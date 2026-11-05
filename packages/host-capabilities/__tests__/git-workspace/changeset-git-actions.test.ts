/**
 * Stage, unstage and revert hunks against real repositories (ADR-0036): git
 * applies its own patch text, a reference patcher says what the result must
 * be, and anything stale or not offered is refused before git writes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type ChangesAction,
  type ChangesActionTarget,
  type Changeset,
  type ChangesetView,
  type GitScope,
  patchHunks,
} from '@brainstrike/types';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { createChangesetDiffService } from '../../src/git-workspace/changeset-diff-service.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import type { GitCommandRunner } from '../../src/git-workspace/git-service.ts';
import { applyHunks } from './patch-test-support.ts';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-git-actions-')));
  created.push(dir);
  return dir;
}

const GIT_IDENTITY = [
  '-c',
  'commit.gpgsign=false',
  '-c',
  'user.name=Test',
  '-c',
  'user.email=t@example.invalid',
];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
}

async function repoWith(committed: Readonly<Record<string, Buffer | string>>): Promise<string> {
  const dir = await tempDir();
  git(dir, ['init', '-q']);
  for (const [name, text] of Object.entries(committed)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'base']);
  return dir;
}

function scope(kind: 'staged' | 'uncommitted' | 'unstaged', dir: string, folder = dir): Changeset {
  return {
    kind: 'git-scope',
    repositoryRoot: dir,
    scope: { kind } as GitScope,
    worktreePath: folder,
  };
}

function changesIn(root: string, run: GitCommandRunner = execFileGitRunner) {
  const service = createChangesetDiffService({
    resolveRootCwd: async () => ({ ok: true, value: root }) as const,
    run,
  });
  return {
    apply: (action: ChangesAction, changeset: Changeset, target: ChangesActionTarget) =>
      service.apply({ action, changeset, rootId: 'root', target }),
    fileDiff: (changeset: Changeset, file: string) => service.fileDiff('root', changeset, file),
    resolve: (changeset: Changeset) => service.resolveView('root', changeset),
    view: async (changeset: Changeset): Promise<ChangesetView> => {
      const result = await service.resolveView('root', changeset);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    },
  };
}

type Changes = ReturnType<typeof changesIn>;

async function hunksOf(changes: Changes, changeset: Changeset, file: string): Promise<string[]> {
  const entry = (await changes.view(changeset)).files.find((candidate) => candidate.path === file);
  return entry?.patch ? patchHunks(entry.patch) : [];
}

/** A files target for `paths` as the view draws them now. */
async function drawn(
  changes: Changes,
  changeset: Changeset,
  paths: readonly string[]
): Promise<ChangesActionTarget> {
  const revisions = new Map(
    (await changes.view(changeset)).files.map((file) => [file.path, file.revision])
  );
  return {
    files: paths.map((filePath) => ({
      path: filePath,
      revision: revisions.get(filePath) ?? 'not drawn',
    })),
    kind: 'files',
  };
}

const indexText = (dir: string, file: string) => git(dir, ['show', `:${file}`]);
const indexBytes = (dir: string, file: string) =>
  execFileSync('git', ['show', `:${file}`], { cwd: dir });

/** One place a file is edited: after `gap` kept lines, `lines` lines deleted, inserted or replaced. */
const SITE = fc.record({
  edit: fc.constantFrom('delete' as const, 'insert' as const, 'replace' as const),
  gap: fc.integer({ max: 12, min: 3 }),
  lines: fc.integer({ max: 3, min: 1 }),
});
/**
 * A file and an edit of it in two to six places. The file repeats a few
 * lines over and over, so a hunk's text recurs elsewhere in the file and only
 * its line numbers say which copy it changes.
 */
const EDITED_FILE = fc
  .record({
    baseNewline: fc.boolean(),
    chosen: fc.array(fc.boolean(), { maxLength: 12, minLength: 12 }),
    editedNewline: fc.boolean(),
    period: fc.integer({ max: 3, min: 1 }),
    sites: fc.array(SITE, { maxLength: 6, minLength: 2 }),
    tail: fc.integer({ max: 8, min: 0 }),
    unstaging: fc.array(fc.boolean(), { maxLength: 12, minLength: 12 }),
  })
  .map(({ baseNewline, chosen, editedNewline, period, sites, tail, unstaging }) => {
    const base: string[] = [];
    const edited: string[] = [];
    const nextBase = () => {
      const line = `line ${base.length % period}`;
      base.push(line);
      return line;
    };
    for (const { edit, gap, lines } of sites) {
      for (let kept = 0; kept < gap; kept += 1) {
        edited.push(nextBase());
      }
      for (let index = 0; index < lines; index += 1) {
        if (edit !== 'insert') {
          nextBase();
        }
        if (edit !== 'delete') {
          edited.push(`new ${edited.length % period}`);
        }
      }
    }
    for (let kept = 0; kept < tail; kept += 1) {
      edited.push(nextBase());
    }
    const text = (lines: string[], newline: boolean) =>
      `${lines.join('\n')}${newline && lines.length > 0 ? '\n' : ''}`;
    return {
      base: text(base, baseNewline),
      chosen,
      edited: text(edited, editedNewline),
      unstaging,
    };
  });

describe('hunk actions', () => {
  it('stage, unstage and revert exactly the chosen hunks, where their text repeats', async () => {
    await fc.assert(
      fc.asyncProperty(EDITED_FILE, async ({ base, chosen: mask, edited, unstaging }) => {
        fc.pre(base !== edited);
        const dir = await repoWith({ 'f.txt': base });
        await writeFile(path.join(dir, 'f.txt'), edited);
        const changes = changesIn(dir);
        const unstaged = scope('unstaged', dir);
        const staged = scope('staged', dir);
        const all = await hunksOf(changes, unstaged, 'f.txt');
        const chosen = all.filter((_, index) => mask[index]);
        const rest = all.filter((_, index) => !mask[index]);
        expect(applyHunks(base, all)).toBe(edited);

        if (chosen.length > 0) {
          const stage = await changes.apply('stage', unstaged, {
            hunks: chosen,
            kind: 'hunks',
            path: 'f.txt',
          });
          expect(stage).toEqual({ ok: true, value: { paths: ['f.txt'] } });
          expect(indexText(dir, 'f.txt')).toBe(applyHunks(base, chosen));
          expect(await readFile(path.join(dir, 'f.txt'), 'utf8')).toBe(edited);

          const inIndex = await hunksOf(changes, staged, 'f.txt');
          const taken = inIndex.filter((_, index) => unstaging[index]);
          if (taken.length > 0) {
            const unstage = await changes.apply('unstage', staged, {
              hunks: taken,
              kind: 'hunks',
              path: 'f.txt',
            });
            expect(unstage.ok).toBe(true);
            expect(indexText(dir, 'f.txt')).toBe(
              applyHunks(
                base,
                inIndex.filter((_, index) => !unstaging[index])
              )
            );
          }
          git(dir, ['reset', '-q', '--', 'f.txt']);
        }

        expect(
          (await changes.apply('stage', unstaged, { hunks: all, kind: 'hunks', path: 'f.txt' })).ok
        ).toBe(true);
        expect(git(dir, ['rev-parse', ':f.txt'])).toBe(git(dir, ['hash-object', 'f.txt']));
        expect((await changes.view(unstaged)).files).toEqual([]);
        expect(
          (await changes.apply('unstage', staged, await drawn(changes, staged, ['f.txt']))).ok
        ).toBe(true);
        expect(indexText(dir, 'f.txt')).toBe(base);

        // The hunks left out of the stage are the ones reverted, so either set
        // may have a hunk left out before a hunk taken.
        if (rest.length > 0) {
          const revert = await changes.apply('revert', unstaged, {
            hunks: rest,
            kind: 'hunks',
            path: 'f.txt',
          });
          expect(revert).toEqual({ ok: true, value: { paths: ['f.txt'] } });
          expect(await readFile(path.join(dir, 'f.txt'), 'utf8')).toBe(applyHunks(base, chosen));
          expect(indexText(dir, 'f.txt')).toBe(base);
        }
      }),
      { numRuns: 16 }
    );
  });

  it('change the copy of repeated text a hunk names when an earlier hunk is left out', async () => {
    const block = ['r1', 'r2', 'r3', 'TARGET', 'r5', 'r6', 'r7'];
    const changed = block.map((line) => (line === 'TARGET' ? 'CHANGED' : line));
    const filler = Array.from({ length: 10 }, (_, index) => `filler ${index}`);
    const inserted = Array.from({ length: 7 }, (_, index) => `inserted ${index}`);
    const text = (...parts: string[][]) => `${parts.flat().join('\n')}\n`;

    // Staging the change alone changes the first of two copies, as it says.
    const stageDir = await repoWith({ 'f.txt': text(['top'], filler, block, block, filler) });
    await writeFile(
      path.join(stageDir, 'f.txt'),
      text(['top'], inserted, filler, changed, block, filler)
    );
    const stageChanges = changesIn(stageDir);
    const [, change = ''] = await hunksOf(stageChanges, scope('unstaged', stageDir), 'f.txt');
    const stage = await stageChanges.apply('stage', scope('unstaged', stageDir), {
      hunks: [change],
      kind: 'hunks',
      path: 'f.txt',
    });
    expect(stage.ok).toBe(true);
    expect(indexText(stageDir, 'f.txt')).toBe(text(['top'], filler, changed, block, filler));

    // Unstaging or reverting it alone changes the second copy, never the committed first.
    const dir = await repoWith({ 'f.txt': text(['top'], filler, changed, block, filler) });
    await writeFile(
      path.join(dir, 'f.txt'),
      text(['top'], inserted, filler, changed, changed, filler)
    );
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir);
    const staged = scope('staged', dir);
    const [, unstagedChange = ''] = await hunksOf(changes, unstaged, 'f.txt');
    expect(
      (await changes.apply('stage', unstaged, await drawn(changes, unstaged, ['f.txt']))).ok
    ).toBe(true);
    const [, stagedChange = ''] = await hunksOf(changes, staged, 'f.txt');
    const unstage = await changes.apply('unstage', staged, {
      hunks: [stagedChange],
      kind: 'hunks',
      path: 'f.txt',
    });
    expect(unstage.ok).toBe(true);
    expect(indexText(dir, 'f.txt')).toBe(text(['top'], inserted, filler, changed, block, filler));
    expect(
      (await changes.apply('unstage', staged, await drawn(changes, staged, ['f.txt']))).ok
    ).toBe(true);
    const revert = await changes.apply('revert', unstaged, {
      hunks: [unstagedChange],
      kind: 'hunks',
      path: 'f.txt',
    });
    expect(revert.ok).toBe(true);
    expect(await readFile(path.join(dir, 'f.txt'), 'utf8')).toBe(
      text(['top'], inserted, filler, changed, block, filler)
    );
  });

  it('apply from a folder inside the repository to the file under it', async () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join('');
    const after = before.replace('line 1\n', 'one\n').replace('line 18\n', 'eighteen\n');
    const dir = await repoWith({ 'sub/f.txt': before });
    await writeFile(path.join(dir, 'sub', 'f.txt'), after);
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir, path.join(dir, 'sub'));
    const [first, second] = await hunksOf(changes, unstaged, 'f.txt');

    const stage = await changes.apply('stage', unstaged, {
      hunks: [first ?? ''],
      kind: 'hunks',
      path: 'f.txt',
    });
    const revert = await changes.apply('revert', unstaged, {
      hunks: [second ?? ''],
      kind: 'hunks',
      path: 'f.txt',
    });

    expect([stage.ok, revert.ok]).toEqual([true, true]);
    expect(indexText(dir, 'sub/f.txt')).toBe(before.replace('line 1\n', 'one\n'));
    expect(await readFile(path.join(dir, 'sub', 'f.txt'), 'utf8')).toBe(
      before.replace('line 1\n', 'one\n')
    );
  });

  it.skipIf(process.platform === 'win32')(
    'a mode change stays with the file, not with its hunks',
    async () => {
      const before = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join('');
      const dir = await repoWith({ 'run.sh': before });
      await writeFile(path.join(dir, 'run.sh'), before.replace('line 3\n', 'three\n'));
      await chmod(path.join(dir, 'run.sh'), 0o755);
      const changes = changesIn(dir);
      const unstaged = scope('unstaged', dir);

      const hunks = await hunksOf(changes, unstaged, 'run.sh');
      const result = await changes.apply('stage', unstaged, {
        hunks,
        kind: 'hunks',
        path: 'run.sh',
      });

      expect(result.ok).toBe(true);
      expect(git(dir, ['ls-files', '-s', 'run.sh'])).toMatch(/^100644 /u);
      expect(indexText(dir, 'run.sh')).toBe(before.replace('line 3\n', 'three\n'));
    }
  );

  it('refuse the hunks of text git does not decode, whose bytes they would replace', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join('');
    const latin1 = (text: string) => Buffer.from(text, 'latin1');
    const withCafe = (cafe: string) => latin1(lines.replace('line 2\n', `${cafe}\n`));
    const dir = await repoWith({ 'added.txt': lines, 'removed.txt': withCafe('caf\xe9') });
    await writeFile(path.join(dir, 'added.txt'), withCafe('caf\xe9'));
    await writeFile(path.join(dir, 'removed.txt'), withCafe('cafe'));
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir);

    const refused = await Promise.all(
      (['stage', 'revert'] as const).flatMap((action) =>
        ['added.txt', 'removed.txt'].map(async (file) =>
          changes.apply(action, unstaged, {
            hunks: await hunksOf(changes, unstaged, file),
            kind: 'hunks',
            path: file,
          })
        )
      )
    );

    for (const result of refused) {
      expect(result).toMatchObject({ error: { code: 'changeset.action-unavailable' }, ok: false });
    }
    expect(indexBytes(dir, 'added.txt')).toEqual(latin1(lines));
    expect(await readFile(path.join(dir, 'removed.txt'))).toEqual(withCafe('cafe'));
    // The whole file keeps its bytes.
    const stage = await changes.apply(
      'stage',
      unstaged,
      await drawn(changes, unstaged, ['added.txt'])
    );
    expect(stage.ok).toBe(true);
    expect(indexBytes(dir, 'added.txt')).toEqual(withCafe('caf\xe9'));
  });

  it('a hostile config cannot change what applies: whitespace rules, and CRLF in the working tree', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const before = `${lines.join('\n')}\n`;
    const after = before.replace('line 2\n', 'two  \n\t\n').replace('line 17\n', 'seventeen\t\n');
    const dir = await repoWith({ 'f.txt': before });
    git(dir, ['config', 'apply.whitespace', 'error']);
    git(dir, ['config', 'apply.ignoreWhitespace', 'change']);
    git(dir, ['config', 'core.whitespace', 'trailing-space,space-before-tab']);
    await writeFile(path.join(dir, 'f.txt'), after);
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir);
    const [first, second] = await hunksOf(changes, unstaged, 'f.txt');

    expect(
      (
        await changes.apply('stage', unstaged, {
          hunks: [first ?? ''],
          kind: 'hunks',
          path: 'f.txt',
        })
      ).ok
    ).toBe(true);
    expect(indexText(dir, 'f.txt')).toBe(before.replace('line 2\n', 'two  \n\t\n'));
    // Staging the first hunk moved the second one's numbers: the view draws it anew.
    const [moved = ''] = await hunksOf(changes, unstaged, 'f.txt');
    const body = (hunk: string) => hunk.slice(hunk.indexOf('\n') + 1);
    expect(body(moved)).toBe(body(second ?? ''));
    expect(
      await changes.apply('revert', unstaged, {
        hunks: [second ?? ''],
        kind: 'hunks',
        path: 'f.txt',
      })
    ).toMatchObject({ error: { code: 'changeset.stale' }, ok: false });
    expect(
      (
        await changes.apply('revert', unstaged, {
          hunks: [moved],
          kind: 'hunks',
          path: 'f.txt',
        })
      ).ok
    ).toBe(true);
    expect(await readFile(path.join(dir, 'f.txt'), 'utf8')).toBe(
      before.replace('line 2\n', 'two  \n\t\n')
    );

    const crlf = await repoWith({ 'w.txt': before });
    git(crlf, ['config', 'core.autocrlf', 'true']);
    const windows = (text: string) => text.replaceAll('\n', '\r\n');
    await writeFile(
      path.join(crlf, 'w.txt'),
      windows(before.replace('line 2\n', 'two\n').replace('line 17\n', 'seventeen\n'))
    );
    const crlfChanges = changesIn(crlf);
    const crlfUnstaged = scope('unstaged', crlf);
    const [, last] = await hunksOf(crlfChanges, crlfUnstaged, 'w.txt');
    const revert = await crlfChanges.apply('revert', crlfUnstaged, {
      hunks: [last ?? ''],
      kind: 'hunks',
      path: 'w.txt',
    });

    expect(revert.ok).toBe(true);
    expect(await readFile(path.join(crlf, 'w.txt'), 'utf8')).toBe(
      windows(before.replace('line 2\n', 'two\n'))
    );
  });
});

describe('a stale or unoffered target', () => {
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join('');

  it('is refused before git writes', async () => {
    const dir = await repoWith({ 'bin.dat': '\0one', 'deleted.txt': 'gone\n', 'f.txt': lines });
    await writeFile(path.join(dir, 'f.txt'), lines.replace('line 1\n', 'one\n'));
    await writeFile(path.join(dir, 'bin.dat'), '\0two');
    await writeFile(path.join(dir, 'new.txt'), 'new\n');
    await rm(path.join(dir, 'deleted.txt'));
    await writeFile(path.join(dir, 'added.txt'), 'added\n');
    git(dir, ['add', 'added.txt']);
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir);
    const [hunk = ''] = await hunksOf(changes, unstaged, 'f.txt');
    const drawnF = await drawn(changes, unstaged, ['f.txt']);
    const index = git(dir, ['ls-files', '-s']);

    // The file changed under the hunk the view drew.
    await writeFile(path.join(dir, 'f.txt'), lines.replace('line 1\n', 'uno\n'));
    const staleHunk = await changes.apply('stage', unstaged, {
      hunks: [hunk],
      kind: 'hunks',
      path: 'f.txt',
    });
    // The file left the view.
    git(dir, ['checkout', '--', 'f.txt']);
    const unlisted = await changes.apply('stage', unstaged, drawnF);
    const unoffered = [
      await changes.apply(
        'stage',
        scope('staged', dir),
        await drawn(changes, scope('staged', dir), ['added.txt'])
      ),
      await changes.apply(
        'revert',
        scope('uncommitted', dir),
        await drawn(changes, scope('uncommitted', dir), ['new.txt'])
      ),
      await changes.apply(
        'revert',
        { kind: 'agent-run', runId: 'run', threadId: 'thread' },
        await drawn(changes, unstaged, ['new.txt'])
      ),
    ];
    const notHunks = await Promise.all(
      [
        ['stage', unstaged, 'new.txt'],
        ['revert', unstaged, 'deleted.txt'],
        ['stage', unstaged, 'bin.dat'],
        ['unstage', scope('staged', dir), 'added.txt'],
      ].map(([action, changeset, file]) =>
        changes.apply(action as ChangesAction, changeset as Changeset, {
          hunks: [hunk],
          kind: 'hunks',
          path: file as string,
        })
      )
    );

    expect(staleHunk).toMatchObject({ error: { code: 'changeset.stale' }, ok: false });
    expect(unlisted).toMatchObject({ error: { code: 'changeset.stale' }, ok: false });
    expect(unlisted.ok ? '' : unlisted.error.message).toContain('f.txt');
    for (const result of [...unoffered, ...notHunks]) {
      expect(result).toMatchObject({ error: { code: 'changeset.action-unavailable' }, ok: false });
    }
    expect(git(dir, ['ls-files', '-s'])).toBe(index);
    expect(await readFile(path.join(dir, 'new.txt'), 'utf8')).toBe('new\n');
  });

  it('a file that reads differently than the view drew it is refused whole', async () => {
    const dir = await repoWith({ 'b.bin': '\0one', 'f.txt': 'one\n' });
    await writeFile(path.join(dir, 'f.txt'), 'one\ntwo\n');
    await writeFile(path.join(dir, 'b.bin'), '\0two');
    await writeFile(path.join(dir, 'notes.md'), 'draft 1\n');
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir);
    const target = await drawn(changes, unstaged, ['b.bin', 'f.txt', 'notes.md']);

    // Newer work lands after the view was drawn, in each file in turn.
    const newer: [string, string, string][] = [
      ['f.txt', 'one\ntwo\nthree\n', 'one\ntwo\n'],
      ['b.bin', '\0thr', '\0two'],
      ['notes.md', 'draft 1\ndraft 2\n', 'draft 1\n'],
    ];
    for (const [file, text, drawnText] of newer) {
      await writeFile(path.join(dir, file), text);
      const revert = await changes.apply('revert', unstaged, target);
      expect(revert).toMatchObject({ error: { code: 'changeset.stale' }, ok: false });
      expect(revert.ok ? '' : revert.error.message).toContain(file);
      expect(await readFile(path.join(dir, file), 'utf8')).toBe(text);
      await writeFile(path.join(dir, file), drawnText);
    }

    // As drawn, it applies.
    expect((await changes.apply('revert', unstaged, target)).ok).toBe(true);
    expect(git(dir, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('a file the view draws no content for is refused once it is written again', async () => {
    const dir = await repoWith({ 'f.txt': 'one\n' });
    const bin = path.join(dir, 'new.bin');
    await writeFile(bin, '\0one');
    // Its first write, well before the view was drawn.
    await utimes(bin, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir);
    const target = await drawn(changes, unstaged, ['new.bin']);

    // The same size, and no patch to compare: only its stat tells.
    await writeFile(bin, '\0two');
    const revert = await changes.apply('revert', unstaged, target);

    expect(revert).toMatchObject({ error: { code: 'changeset.stale' }, ok: false });
    expect(await readFile(bin, 'utf8')).toBe('\0two');
    const redrawn = await drawn(changes, unstaged, ['new.bin']);
    expect((await changes.apply('revert', unstaged, redrawn)).ok).toBe(true);
    expect(existsSync(bin)).toBe(false);
  });

  it('a patch that no longer applies changes nothing', async () => {
    const dir = await repoWith({ 'f.txt': lines });
    // Matching context while ignoring whitespace would let the race through.
    git(dir, ['config', 'apply.ignoreWhitespace', 'change']);
    await writeFile(path.join(dir, 'f.txt'), lines.replace('line 1\n', 'one\n'));
    const racer = lines.replace('line 1\n', 'one\n').replace('line 2\n', 'line  2\n');
    // Another writer edits the file between the host's check and git's apply.
    const racing: GitCommandRunner = async (params) => {
      if (params.args.includes('apply')) {
        await writeFile(path.join(dir, 'f.txt'), racer);
      }
      return await execFileGitRunner(params);
    };
    const changes = changesIn(dir, racing);
    const unstaged = scope('unstaged', dir);

    const result = await changes.apply('revert', unstaged, {
      hunks: await hunksOf(changes, unstaged, 'f.txt'),
      kind: 'hunks',
      path: 'f.txt',
    });

    expect(result).toMatchObject({ error: { code: 'changeset.apply-conflict' }, ok: false });
    expect(result.ok ? '' : result.error.message).toContain('f.txt');
    expect(await readFile(path.join(dir, 'f.txt'), 'utf8')).toBe(racer);
  });

  it('a repository whose work tree is not inside the opened root is refused, read or write', async () => {
    const top = await tempDir();
    const root = path.join(top, 'root');
    const outside = path.join(top, 'outside');
    const repo = path.join(root, 'downloaded');
    await mkdir(repo, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, 'important.txt'), 'mine\n');
    git(repo, ['init', '-q']);
    git(repo, ['--work-tree', outside, 'add', '-A']);
    git(repo, ['--work-tree', outside, 'commit', '-q', '-m', 'outside']);
    await writeFile(path.join(outside, 'important.txt'), 'mine, edited\n');
    const changes = changesIn(root);
    const unstaged = scope('unstaged', repo);
    const target: ChangesActionTarget = {
      files: [{ path: 'important.txt', revision: 'any' }],
      kind: 'files',
    };

    // The repository names a work tree outside the root, or one whose top is above it.
    for (const workTree of [outside, top]) {
      git(repo, ['config', 'core.worktree', workTree]);
      const refused = [
        await changes.resolve(unstaged),
        await changes.fileDiff(unstaged, 'important.txt'),
        await changes.apply('revert', unstaged, target),
        await changes.apply('stage', unstaged, target),
      ];
      for (const result of refused) {
        expect(result).toMatchObject({ error: { code: 'changeset.outside-roots' }, ok: false });
      }
    }
    expect(await readFile(path.join(outside, 'important.txt'), 'utf8')).toBe('mine, edited\n');
  });

  it.skipIf(process.platform === 'win32')(
    "never runs the repository's fsmonitor command",
    async () => {
      const dir = await repoWith({ 'f.txt': lines });
      const marker = path.join(await tempDir(), 'fsmonitor-ran');
      const hook = path.join(dir, '.git', 'fsmonitor-hook');
      await writeFile(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
      await chmod(hook, 0o755);
      git(dir, ['config', 'core.fsmonitor', hook]);
      await writeFile(path.join(dir, 'f.txt'), lines.replace('line 1\n', 'one\n'));
      await writeFile(path.join(dir, 'u.txt'), 'u\n');
      const changes = changesIn(dir);
      const unstaged = scope('unstaged', dir);

      const [hunk = ''] = await hunksOf(changes, unstaged, 'f.txt');
      const diffs = [
        await changes.fileDiff(unstaged, 'f.txt'),
        await changes.fileDiff(unstaged, 'u.txt'),
      ];
      const stage = await changes.apply('stage', unstaged, {
        hunks: [hunk],
        kind: 'hunks',
        path: 'f.txt',
      });
      const revert = await changes.apply(
        'revert',
        unstaged,
        await drawn(changes, unstaged, ['u.txt'])
      );

      expect([...diffs, stage, revert].map((result) => result.ok)).toEqual([
        true,
        true,
        true,
        true,
      ]);
      expect(existsSync(marker)).toBe(false);
      // The hook is live: git's own status runs it.
      git(dir, ['status', '--porcelain']);
      expect(existsSync(marker)).toBe(true);
    }
  );
});

/** Each listed path with its status. */
async function statuses(changes: Changes, changeset: Changeset) {
  return Object.fromEntries(
    (await changes.view(changeset)).files.map((file) => [file.path, file.status])
  );
}

// Names a careless pathspec or shell would misread; `*`, tab and `"` are not file names on Windows.
const POSIX = process.platform !== 'win32';
const ODD_TRACKED = POSIX ? 'tab\there "q".txt' : '-tracked [x].txt';
const ODD_UNTRACKED = ['-lead sp ü.txt', '[x] (1).txt', ...(POSIX ? ['*.txt'] : [])];

describe('file actions', () => {
  it("each file offers its scope's actions; an untracked file's diff opens", async () => {
    const dir = await repoWith({ 'f.txt': 'f\n' });
    await writeFile(path.join(dir, 'f.txt'), 'F\n');
    git(dir, ['add', 'f.txt']);
    await writeFile(path.join(dir, 'new.txt'), 'new\n');
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir);

    const view = await changes.view(unstaged);
    const diff = await changes.fileDiff(unstaged, 'new.txt');

    expect(view.files).toEqual([
      expect.objectContaining({
        actions: ['stage', 'revert'],
        additions: 1,
        path: 'new.txt',
        status: 'untracked',
      }),
    ]);
    expect((await changes.view(scope('staged', dir))).files).toEqual([
      expect.objectContaining({ actions: ['unstage'], path: 'f.txt' }),
    ]);
    expect(
      (await changes.view(scope('uncommitted', dir))).files.map((file) => file.actions)
    ).toEqual([[], []]);
    expect(diff).toMatchObject({ ok: true, value: { status: 'untracked' } });
    expect(diff.ok && diff.value.content.kind !== 'binary' && diff.value.content.patch).toBe(
      view.files[0]?.patch
    );
  });

  it('stage, unstage and revert every kind of file by path, and nothing else', async () => {
    const dir = await repoWith({
      '.gitignore': 'ignored.log\n',
      'b.bin': '\0one',
      'd.txt': 'd\n',
      'm.txt': 'm\n',
      [ODD_TRACKED]: Array.from({ length: 12 }, (_, index) => `line ${index}\n`).join(''),
    });
    const head = git(dir, ['ls-files', '-s']);
    await writeFile(path.join(dir, 'b.bin'), '\0two');
    await rm(path.join(dir, 'd.txt'));
    await writeFile(path.join(dir, 'm.txt'), 'M\n');
    await writeFile(
      path.join(dir, ODD_TRACKED),
      Array.from({ length: 12 }, (_, index) => `line ${index === 10 ? 'ten' : index}\n`).join('')
    );
    for (const name of ['u.txt', 'ignored.log', ...ODD_UNTRACKED]) {
      await writeFile(path.join(dir, name), `${name}\n`);
    }
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir);
    const staged = scope('staged', dir);
    const listed = await statuses(changes, unstaged);
    const paths = Object.keys(listed);

    expect(listed).toEqual({
      'b.bin': 'modified',
      'd.txt': 'deleted',
      'm.txt': 'modified',
      [ODD_TRACKED]: 'modified',
      'u.txt': 'untracked',
      ...Object.fromEntries(ODD_UNTRACKED.map((name) => [name, 'untracked'])),
    });
    // A quoted name's patch applies by its hunks.
    const oddHunks = await hunksOf(changes, unstaged, ODD_TRACKED);
    const oddStage = await changes.apply('stage', unstaged, {
      hunks: oddHunks,
      kind: 'hunks',
      path: ODD_TRACKED,
    });
    expect(oddStage.ok).toBe(true);
    expect(await statuses(changes, staged)).toEqual({ [ODD_TRACKED]: 'modified' });

    const rest = paths.filter((name) => name !== ODD_TRACKED);
    const stage = await changes.apply('stage', unstaged, await drawn(changes, unstaged, rest));
    expect(stage.ok && [...stage.value.paths].sort()).toEqual([...rest].sort());
    expect(await statuses(changes, staged)).toEqual({
      ...listed,
      'u.txt': 'added',
      ...Object.fromEntries(ODD_UNTRACKED.map((name) => [name, 'added'])),
    });
    expect((await changes.view(unstaged)).files).toEqual([]);

    const unstage = await changes.apply(
      'unstage',
      staged,
      await drawn(changes, staged, Object.keys(await statuses(changes, staged)))
    );
    expect(unstage.ok).toBe(true);
    expect(git(dir, ['ls-files', '-s'])).toBe(head);
    expect(await statuses(changes, unstaged)).toEqual(listed);

    const revert = await changes.apply('revert', unstaged, await drawn(changes, unstaged, paths));
    expect(revert.ok).toBe(true);
    expect(git(dir, ['status', '--porcelain'])).toBe('');
    expect(await readFile(path.join(dir, 'd.txt'), 'utf8')).toBe('d\n');
    expect(await readFile(path.join(dir, 'ignored.log'), 'utf8')).toBe('ignored.log\n');
  });

  it('unstage a staged rename by both its sides, and stage it back', async () => {
    const text = Array.from({ length: 10 }, (_, index) => `line ${index}\n`).join('');
    const dir = await repoWith({ 'old.txt': text });
    git(dir, ['mv', 'old.txt', 'new.txt']);
    await writeFile(path.join(dir, 'new.txt'), `${text}more\n`);
    git(dir, ['add', 'new.txt']);
    const changes = changesIn(dir);
    const staged = scope('staged', dir);
    const unstaged = scope('unstaged', dir);
    expect((await changes.view(staged)).files).toEqual([
      expect.objectContaining({ oldPath: 'old.txt', path: 'new.txt', status: 'renamed' }),
    ]);

    const unstage = await changes.apply(
      'unstage',
      staged,
      await drawn(changes, staged, ['new.txt'])
    );

    expect(unstage).toEqual({ ok: true, value: { paths: ['old.txt', 'new.txt'] } });
    expect((await changes.view(staged)).files).toEqual([]);
    expect(await statuses(changes, unstaged)).toEqual({
      'new.txt': 'untracked',
      'old.txt': 'deleted',
    });
    const stage = await changes.apply(
      'stage',
      unstaged,
      await drawn(changes, unstaged, ['old.txt', 'new.txt'])
    );
    expect(stage.ok).toBe(true);
    expect((await changes.view(staged)).files).toEqual([
      expect.objectContaining({ oldPath: 'old.txt', path: 'new.txt', status: 'renamed' }),
    ]);
  });

  it('revert a file added with intent, alone or as the new side of a rename, by removing it', async () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index}\n`).join('');
    const dir = await repoWith({ 'old.txt': text });
    await writeFile(path.join(dir, 'intent.txt'), 'new work\n');
    await rename(path.join(dir, 'old.txt'), path.join(dir, 'moved.txt'));
    await writeFile(path.join(dir, 'moved.txt'), `${text}more work\n`);
    git(dir, ['add', '--intent-to-add', 'intent.txt', 'moved.txt']);
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir);
    expect(await statuses(changes, unstaged)).toEqual({
      'intent.txt': 'added',
      'moved.txt': 'renamed',
    });

    const revert = await changes.apply(
      'revert',
      unstaged,
      await drawn(changes, unstaged, ['intent.txt', 'moved.txt'])
    );

    expect(revert).toEqual({ ok: true, value: { paths: ['intent.txt', 'old.txt', 'moved.txt'] } });
    expect(git(dir, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(await readFile(path.join(dir, 'old.txt'), 'utf8')).toBe(text);
    expect([
      existsSync(path.join(dir, 'intent.txt')),
      existsSync(path.join(dir, 'moved.txt')),
    ]).toEqual([false, false]);
  });

  it('work before the first commit', async () => {
    const dir = await tempDir();
    git(dir, ['init', '-q']);
    await writeFile(path.join(dir, 'a.txt'), 'a\n');
    git(dir, ['add', 'a.txt']);
    const changes = changesIn(dir);
    const staged = scope('staged', dir);
    const unstaged = scope('unstaged', dir);

    expect(await statuses(changes, staged)).toEqual({ 'a.txt': 'added' });
    expect(
      (await changes.apply('unstage', staged, await drawn(changes, staged, ['a.txt']))).ok
    ).toBe(true);
    expect(await statuses(changes, unstaged)).toEqual({ 'a.txt': 'untracked' });
    expect(
      (await changes.apply('stage', unstaged, await drawn(changes, unstaged, ['a.txt']))).ok
    ).toBe(true);
    expect(await statuses(changes, staged)).toEqual({ 'a.txt': 'added' });
    git(dir, ['rm', '-q', '--cached', 'a.txt']);
    expect(
      (await changes.apply('revert', unstaged, await drawn(changes, unstaged, ['a.txt']))).ok
    ).toBe(true);
    expect(git(dir, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('offer nothing for an untracked repository, no revert or hunks for a gitlink, and fail visibly on a locked index', async () => {
    const dir = await repoWith({ 'm.txt': 'm\n' });
    // A repository committed as a gitlink, then moved to a new commit.
    const linked = path.join(dir, 'linked');
    await mkdir(linked);
    git(linked, ['init', '-q']);
    git(linked, ['commit', '-q', '--allow-empty', '-m', 'one']);
    const linkedAt = git(linked, ['rev-parse', 'HEAD']).trim();
    git(dir, ['update-index', '--add', '--cacheinfo', `160000,${linkedAt},linked`]);
    git(dir, ['commit', '-q', '-m', 'link']);
    git(linked, ['commit', '-q', '--allow-empty', '-m', 'two']);
    const moved = git(linked, ['rev-parse', 'HEAD']);
    // A repository git does not track.
    await mkdir(path.join(dir, 'nested'));
    git(path.join(dir, 'nested'), ['init', '-q']);
    await writeFile(path.join(dir, 'nested', 'n.txt'), 'n\n');
    await writeFile(path.join(dir, 'm.txt'), 'M\n');
    const changes = changesIn(dir);
    const unstaged = scope('unstaged', dir);
    const index = git(dir, ['ls-files', '-s']);

    expect(
      (await changes.view(unstaged)).files.map((file) => [file.path, file.status, file.actions])
    ).toEqual([
      ['linked', 'modified', ['stage']],
      ['m.txt', 'modified', ['stage', 'revert']],
      ['nested/', 'untracked', []],
    ]);
    const refused = [
      await changes.apply('revert', unstaged, await drawn(changes, unstaged, ['m.txt', 'nested/'])),
      await changes.apply('stage', unstaged, await drawn(changes, unstaged, ['nested/'])),
      await changes.apply('revert', unstaged, await drawn(changes, unstaged, ['linked'])),
      ...(['stage', 'revert'] as const).map(async (action) =>
        changes.apply(action, unstaged, {
          hunks: await hunksOf(changes, unstaged, 'linked'),
          kind: 'hunks',
          path: 'linked',
        })
      ),
    ];
    for (const result of await Promise.all(refused)) {
      expect(result).toMatchObject({ error: { code: 'changeset.action-unavailable' }, ok: false });
    }
    expect(git(dir, ['ls-files', '-s'])).toBe(index);
    expect(git(linked, ['rev-parse', 'HEAD'])).toBe(moved);
    expect(await readFile(path.join(dir, 'nested', 'n.txt'), 'utf8')).toBe('n\n');
    expect(await readFile(path.join(dir, 'm.txt'), 'utf8')).toBe('M\n');

    const stageLink = await changes.apply(
      'stage',
      unstaged,
      await drawn(changes, unstaged, ['linked'])
    );
    expect(stageLink.ok).toBe(true);
    expect((await changes.view(scope('staged', dir))).files).toEqual([
      expect.objectContaining({ actions: ['unstage'], path: 'linked' }),
    ]);

    const target = await drawn(changes, unstaged, ['m.txt']);
    await writeFile(path.join(dir, '.git', 'index.lock'), '');
    const locked = await changes.apply('stage', unstaged, target);
    expect(locked).toMatchObject({ error: { code: 'git.command-failed' }, ok: false });
    expect(locked.ok ? '' : locked.error.message).toContain('index.lock');
  });
});
