/**
 * Real repositories and the three readers of git's patch (the file diff, the view and the snapshot engine) for
 * structured-diff-patch{,-2,-3,-4}.test.ts (ADR-0036), and the generated property those four files share.
 */
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Changeset, StructuredFileDiff } from '@brainstrike/types';
import fc from 'fast-check';
import { expect } from 'vitest';
import {
  resolveGitScopeChangesetView,
  resolveGitScopeFileDiff,
} from '../../src/git-workspace/changeset-git-scope.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import { execFileSnapshotGitRunner } from '../../src/git-workspace/snapshot-git.ts';
import { createSnapshotService } from '../../src/git-workspace/snapshot-service.ts';
import { parsePatch } from './patch-test-support.ts';

const created: string[] = [];

/** Removes every directory `tempDir` made so far. */
export async function removeTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
}

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-diff-patch-')));
  created.push(dir);
  return dir;
}

const FIXED_DATE = '2001-01-01T00:00:00Z';

/** Git for fixtures: no signing, a fixed identity and date, so equal trees make equal commits. */
export function git(cwd: string, args: readonly string[], input?: string): string {
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
export async function repoWith(committed: Readonly<Record<string, string>>): Promise<string> {
  const dir = await tempDir();
  git(dir, ['init', '-q']);
  // Files keep the line endings they were written with: Git for Windows turns
  // core.autocrlf on for the whole machine.
  git(dir, ['config', 'core.autocrlf', 'false']);
  for (const [name, text] of Object.entries(committed)) {
    await writeFile(path.join(dir, name), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'base']);
  return dir;
}

export function uncommitted(dir: string): Extract<Changeset, { kind: 'git-scope' }> {
  return {
    kind: 'git-scope',
    repositoryRoot: dir,
    scope: { kind: 'uncommitted' },
    worktreePath: dir,
  };
}

export function deps(dir: string) {
  return {
    resolveRootCwd: async () => ({ ok: true, value: dir }) as const,
    run: execFileGitRunner,
  };
}

export async function fileDiff(dir: string, file: string): Promise<StructuredFileDiff> {
  const result = await resolveGitScopeFileDiff(deps(dir), 'root', uncommitted(dir), file);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export async function view(dir: string) {
  const result = await resolveGitScopeChangesetView(deps(dir), 'root', uncommitted(dir));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function patchOf(diff: StructuredFileDiff): string {
  if (diff.content.kind === 'binary') {
    throw new Error(`${diff.path} is binary`);
  }
  return diff.content.patch;
}

/** Apply `patch` with git to `files` laid out in a fresh directory; returns `file`'s result. */
export async function applied(
  patch: string,
  files: Readonly<Record<string, string>>,
  file: string
): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(dir, name), text);
  }
  git(dir, ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', '-'], patch);
  return await readFile(path.join(dir, file), 'utf8');
}

/** The snapshot engine's diffs from a turn start (taken by `before`) to the live tree. */
export async function snapshotDiffs(dir: string, change: () => Promise<void>, shadowConfig = '') {
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

/**
 * The generated property's share for one test file. Four files (structured-diff-patch{,-2,-3,-4}.test.ts) run it, 20
 * cases in all. Each case makes a repository and a snapshot shadow repository and runs git for every read and apply,
 * so one file of 20 cases took 50 s of its 60 s budget beside four other packages' suites, and timed out at 60 s on a
 * busier machine (BST-2494). Separate files run on separate workers.
 */
const GENERATED_RUNS_PER_FILE = 5;

/**
 * Git's patch applies to the old side, counts what numstat counts, and reads the same in the view and the snapshot
 * engine, for generated old, new and added texts.
 */
export async function checkPatchAgreement(): Promise<void> {
  try {
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
      { numRuns: GENERATED_RUNS_PER_FILE }
    );
  } finally {
    await removeTempDirs();
  }
}
