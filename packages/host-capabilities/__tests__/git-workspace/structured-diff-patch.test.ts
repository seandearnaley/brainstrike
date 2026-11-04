/**
 * Git's patch, end to end against real repositories (ADR-0036): what the
 * renderer draws is git's own patch, so it must apply to the old side, count
 * the same lines as numstat, read the same in the view as in the file's own
 * diff and in the snapshot engine, survive a hostile git config, and still
 * parse when cut to its bound.
 */
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Changeset, StructuredFileDiff } from '@brainstrike/types';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveGitScopeChangesetView,
  resolveGitScopeFileDiff,
} from '../../src/git-workspace/changeset-git-scope.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import { execFileSnapshotGitRunner } from '../../src/git-workspace/snapshot-git.ts';
import { createSnapshotService } from '../../src/git-workspace/snapshot-service.ts';
import { PATCH_BOUND, pinnedPatchArgs } from '../../src/git-workspace/structured-diff-content.ts';
import { parsePatch } from './patch-test-support.ts';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-diff-patch-')));
  created.push(dir);
  return dir;
}

const FIXED_DATE = '2001-01-01T00:00:00Z';

/** Git for fixtures: no signing, a fixed identity and date, so equal trees make equal commits. */
function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=t@example.invalid',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
      maxBuffer: 64 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    }
  );
}

/** A repository whose HEAD holds `committed`. */
async function repoWith(committed: Readonly<Record<string, string>>): Promise<string> {
  const dir = await tempDir();
  git(dir, ['init', '-q']);
  for (const [name, text] of Object.entries(committed)) {
    await writeFile(path.join(dir, name), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'base']);
  return dir;
}

function uncommitted(dir: string): Extract<Changeset, { kind: 'git-scope' }> {
  return {
    kind: 'git-scope',
    repositoryRoot: dir,
    scope: { kind: 'uncommitted' },
    worktreePath: dir,
  };
}

function deps(dir: string) {
  return {
    resolveRootCwd: async () => ({ ok: true, value: dir }) as const,
    run: execFileGitRunner,
  };
}

async function fileDiff(dir: string, file: string): Promise<StructuredFileDiff> {
  const result = await resolveGitScopeFileDiff(deps(dir), 'root', uncommitted(dir), file);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

async function view(dir: string) {
  const result = await resolveGitScopeChangesetView(deps(dir), 'root', uncommitted(dir));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function patchOf(diff: StructuredFileDiff): string {
  if (diff.content.kind === 'binary') {
    throw new Error(`${diff.path} is binary`);
  }
  return diff.content.patch;
}

/** Apply `patch` with git to `files` laid out in a fresh directory; returns `file`'s result. */
async function applied(
  patch: string,
  files: Readonly<Record<string, string>>,
  file: string
): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(dir, name), text);
  }
  git(dir, ['apply', '--whitespace=nowarn', '-'], patch);
  return await readFile(path.join(dir, file), 'utf8');
}

/** The snapshot engine's diffs from a turn start (taken by `before`) to the live tree. */
async function snapshotDiffs(dir: string, change: () => Promise<void>, shadowConfig = '') {
  const base = await tempDir();
  const service = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir: base,
  });
  const handle = await service.ensureShadowRepo({ path: dir, rootId: 'root' });
  if (shadowConfig !== '') {
    await appendFile(path.join(handle.gitDir, 'config'), shadowConfig);
    await mkdir(path.join(handle.gitDir, 'info'), { recursive: true });
    await writeFile(path.join(handle.gitDir, 'info', 'attributes'), '* diff=evil\n');
  }
  const start = await service.snapshot(handle, { kind: 'turn-start', threadId: 'thread' });
  await change();
  return await service.diffRefs(handle, start.commitOid, { worktree: true });
}

// Lines that look like patch syntax, blank lines, whitespace and multibyte text.
const LINE = fc.constantFrom(
  '',
  ' ',
  '\t',
  'a',
  'b',
  'c',
  '-- not a header',
  '++ nor this',
  '@@ -1 +1 @@',
  'diff --git a/x b/x',
  '\\ No newline at end of file',
  'Binary files a and b differ',
  'naïve 🎉',
  'carriage\r'
);
const TEXT = fc
  .tuple(fc.array(LINE, { maxLength: 24 }), fc.boolean())
  .map(([lines, newline]) => `${lines.join('\n')}${newline && lines.length > 0 ? '\n' : ''}`);

describe("git's patch is the diff the user sees", () => {
  it('applies to the old side, counts what numstat counts, and reads the same in the view and the snapshot engine', async () => {
    await fc.assert(
      fc.asyncProperty(TEXT, TEXT, TEXT, async (oldText, newText, addedText) => {
        fc.pre(oldText !== newText);
        const dir = await repoWith({ 'f.txt': oldText });
        const diffs = await snapshotDiffs(dir, async () => {
          await writeFile(path.join(dir, 'f.txt'), newText);
          await writeFile(path.join(dir, 'new file.txt'), addedText);
        });
        const [modified, untracked, listing] = await Promise.all([
          fileDiff(dir, 'f.txt'),
          fileDiff(dir, 'new file.txt'),
          view(dir),
        ]);

        // (a) git's patch turns the old side into the new one.
        expect(modified.content.kind).toBe('full');
        expect(await applied(patchOf(modified), { 'f.txt': oldText }, 'f.txt')).toBe(newText);
        expect(await applied(patchOf(untracked), {}, 'new file.txt')).toBe(addedText);
        // (b) the drawn lines are the counted lines.
        expect(parsePatch(patchOf(modified))).toMatchObject({
          additions: modified.additions,
          deletions: modified.deletions,
        });
        expect(parsePatch(patchOf(untracked))).toMatchObject({
          additions: untracked.additions,
          deletions: 0,
        });
        // One request draws the view with the same bytes and counts the file's diff carries.
        expect(
          listing.files.map((file) => [file.path, file.patch, file.additions, file.deletions])
        ).toEqual([
          ['f.txt', patchOf(modified), modified.additions, modified.deletions],
          ['new file.txt', patchOf(untracked), untracked.additions, 0],
        ]);
        // The snapshot engine produces the same payload for the same change.
        const byPath = new Map(diffs.map((diff) => [diff.path, diff]));
        expect(byPath.get('f.txt')).toEqual(modified);
        expect(byPath.get('new file.txt')?.content).toEqual(untracked.content);
        expect(byPath.get('new file.txt')?.additions).toBe(untracked.additions);
      }),
      { numRuns: 20 }
    );
  });
});

const HOSTILE_CONFIG = `[color]
\tui = always
\tdiff = always
[core]
\tquotePath = true
\tabbrev = 12
[diff]
\tnoprefix = true
\tmnemonicPrefix = true
\tsuppressBlankEmpty = true
\tcontext = 0
\tinterHunkContext = 10
\talgorithm = patience
\tindentHeuristic = false
\tsubmodule = log
\texternal = echo EXTERNAL
[diff "evil"]
\ttextconv = sed s/^/TEXTCONV:/
\tcommand = echo DRIVER
`;

describe('a hostile git config', () => {
  it('cannot change a byte of the patch, the counts or the view', async () => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      index % 5 === 0 ? '' : `line ${index}`
    );
    const before = `${lines.join('\n')}\n`;
    const after = before.replace('line 3\n', 'line three\n').replace('line 14\n', 'fourteen\n');
    // Pairs where `diff.algorithm=patience` counts other lines than myers, and
    // where `diff.indentHeuristic=false` slides the hunk.
    const algorithm = ['x\nb\nc\nc\nc\na\nc\ny\nc\ny\n\n', 'c\na\na\nb\nc\nx\n'] as const;
    const heuristic = ['x\n}\n\nb\nc\nb\na\n}\n', '\nb\na\n'] as const;
    async function outcome(hostile: boolean) {
      const dir = await repoWith({
        'algorithm.txt': algorithm[0],
        'f.txt': before,
        'heuristic.txt': heuristic[0],
        'naïve.txt': 'one\ntwo\n',
        'old.txt': before,
      });
      const sub = path.join(dir, 'sub');
      await mkdir(sub);
      git(sub, ['init', '-q']);
      await writeFile(path.join(sub, 'one.txt'), 'one\n');
      git(sub, ['add', '-A']);
      git(sub, ['commit', '-q', '-m', 'one']);
      git(dir, ['-c', 'advice.addEmbeddedRepo=false', 'add', 'sub']);
      git(dir, ['commit', '-q', '-m', 'sub']);
      if (hostile) {
        await appendFile(path.join(dir, '.git', 'config'), HOSTILE_CONFIG);
        await writeFile(path.join(dir, '.git', 'info', 'attributes'), '* diff=evil\n');
      }
      const diffs = await snapshotDiffs(
        dir,
        async () => {
          await writeFile(path.join(dir, 'algorithm.txt'), algorithm[1]);
          await writeFile(path.join(dir, 'f.txt'), after);
          await writeFile(path.join(dir, 'heuristic.txt'), heuristic[1]);
          await writeFile(path.join(dir, 'naïve.txt'), 'one\n\ntwo\n');
          await writeFile(path.join(dir, 'notes new.txt'), 'fresh\n\n');
          git(dir, ['mv', 'old.txt', 'renamed.txt']);
          await writeFile(path.join(dir, 'renamed.txt'), after);
          await writeFile(path.join(sub, 'one.txt'), 'two\n');
          git(sub, ['commit', '-q', '-am', 'two']);
        },
        hostile ? HOSTILE_CONFIG : ''
      );
      const listing = await view(dir);
      return {
        diffs,
        // A submodule's own diff is not under test: git-scope reads its sides as blobs.
        files: await Promise.all(
          listing.files
            .filter((file) => file.path !== 'sub')
            .map((file) => fileDiff(dir, file.path))
        ),
        view: listing.files.map(({ repositoryRoot: _root, worktreePath: _tree, ...file }) => file),
      };
    }
    const [clean, hostile] = await Promise.all([outcome(false), outcome(true)]);

    expect(hostile).toEqual(clean);
    const f = clean.files.find((file) => file.path === 'f.txt');
    expect(f && parsePatch(patchOf(f))).toEqual({ additions: 2, deletions: 2, hunks: 2 });
    expect(clean.view.map((file) => file.path)).toEqual([
      'algorithm.txt',
      'f.txt',
      'heuristic.txt',
      'naïve.txt',
      'renamed.txt',
      'sub',
      'notes new.txt',
    ]);
    for (const file of clean.view) {
      expect(file.patch).toMatch(/^diff --git a\//u);
      expect(file.patch).not.toContain('\u001b');
    }
  });
});

describe('an over-bound patch', () => {
  it('is cut after a whole hunk, still parses and applies, and the view leaves it to load on demand', async () => {
    const lines = Array.from({ length: 40_000 }, (_, index) => `line ${index} ${'x'.repeat(28)}`);
    const before = `${lines.join('\n')}\n`;
    const after = `${lines.map((line, index) => (index % 10 === 5 ? `${line}!` : line)).join('\n')}\n`;
    const dir = await repoWith({ 'f.txt': before });
    const diffs = await snapshotDiffs(dir, async () => {
      await writeFile(path.join(dir, 'f.txt'), after);
    });
    const [diff, listing] = await Promise.all([fileDiff(dir, 'f.txt'), view(dir)]);
    const whole = git(dir, pinnedPatchArgs(['HEAD', '--', 'f.txt']));

    expect(whole.length).toBeGreaterThan(PATCH_BOUND);
    expect(diff).toMatchObject({ additions: 4000, deletions: 4000 });
    expect(diff.content).toMatchObject({
      kind: 'hunks-only',
      patchTruncated: true,
      reason: 'diff-overflow',
    });
    const patch = patchOf(diff);
    expect(patch.length).toBeLessThanOrEqual(PATCH_BOUND);
    expect(whole.startsWith(patch)).toBe(true);
    expect(whole.slice(patch.length).startsWith('@@ ')).toBe(true);
    const parsed = parsePatch(patch);
    expect(parsed.hunks).toBeGreaterThan(0);
    expect(parsed.additions).toBeLessThan(4000);
    const partial = await applied(patch, { 'f.txt': before }, 'f.txt');
    expect(after.startsWith(partial.slice(0, partial.lastIndexOf('!') + 1))).toBe(true);
    expect(listing.files).toEqual([
      expect.objectContaining({ additions: 4000, deletions: 4000, patch: null, path: 'f.txt' }),
    ]);
    expect(diffs.find((entry) => entry.path === 'f.txt')?.content).toEqual(diff.content);
  });
});
