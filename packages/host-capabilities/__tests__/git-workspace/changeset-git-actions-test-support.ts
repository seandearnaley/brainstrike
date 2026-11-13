/**
 * Real repositories and a hunk-action client for changeset-git-actions{,-2,-3,-4}.test.ts (ADR-0036), and the
 * generated property those four files share.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
import { expect } from 'vitest';
import { createChangesetDiffService } from '../../src/git-workspace/changeset-diff-service.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import type { GitCommandRunner } from '../../src/git-workspace/git-service.ts';
import { applyHunks } from './patch-test-support.ts';

const created: string[] = [];

/** Removes every directory `tempDir` made so far. */
export async function removeTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
}

export async function tempDir(): Promise<string> {
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

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
}

export async function repoWith(
  committed: Readonly<Record<string, Buffer | string>>
): Promise<string> {
  const dir = await tempDir();
  git(dir, ['init', '-q']);
  // Files keep the line endings they were written with: Git for Windows turns
  // core.autocrlf on for the whole machine.
  git(dir, ['config', 'core.autocrlf', 'false']);
  for (const [name, text] of Object.entries(committed)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'base']);
  return dir;
}

export function scope(
  kind: 'staged' | 'uncommitted' | 'unstaged',
  dir: string,
  folder = dir
): Changeset {
  return {
    kind: 'git-scope',
    repositoryRoot: dir,
    scope: { kind } as GitScope,
    worktreePath: folder,
  };
}

export function changesIn(root: string, run: GitCommandRunner = execFileGitRunner) {
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

export type Changes = ReturnType<typeof changesIn>;

export async function hunksOf(
  changes: Changes,
  changeset: Changeset,
  file: string
): Promise<string[]> {
  const entry = (await changes.view(changeset)).files.find((candidate) => candidate.path === file);
  return entry?.patch ? patchHunks(entry.patch) : [];
}

/** A files target for `paths` as the view draws them now. */
export async function drawn(
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

export const indexText = (dir: string, file: string) => git(dir, ['show', `:${file}`]);

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

/**
 * The generated property's share for one test file. Four files (changeset-git-actions{,-2,-3,-4}.test.ts) run it, 16
 * cases in all. Each case makes a repository and runs git for every view, stage, unstage and revert, so one file of
 * 16 cases took 49 s of its 60 s budget beside four other packages' suites, and timed out at 60 s on a busier machine
 * (BST-2494). Separate files run on separate workers.
 */
const GENERATED_RUNS_PER_FILE = 4;

/** Stage, unstage and revert exactly the chosen hunks of generated edits, where their text repeats. */
export async function checkChosenHunks(): Promise<void> {
  try {
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
      { numRuns: GENERATED_RUNS_PER_FILE }
    );
  } finally {
    await removeTempDirs();
  }
}
