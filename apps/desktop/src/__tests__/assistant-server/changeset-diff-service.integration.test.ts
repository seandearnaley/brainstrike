/**
 * Real-repository integration coverage for `changeset-git-scope.ts`'s scope
 * listings (BST-1113) — every `git-scope` kind against a REAL temp git
 * repository via the production `execFile`-backed runner, including unborn
 * HEAD, a root commit, a rename, a binary file (totals exclusion), and
 * untracked files in `uncommitted`. Fake-runner unit coverage (containment,
 * base-ref resolution, the merge-base-vs-raw-base params mapping) lives in
 * `changeset-git-scope.test.ts`.
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitScope } from '@brainstrike/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveGitScopeChangesetView,
  resolveGitScopeFileDiff,
} from '../../assistant-server/changeset-git-scope';
import { execFileGitRunner } from '../../git-ipc-handlers';

const execFileAsync = promisify(execFile);
const createdRoots: string[] = [];

async function makeRepo(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-changeset-scope-'));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  await execFileAsync('git', ['init', '-q'], { cwd: real });
  await execFileAsync('git', ['config', 'user.email', 'test@brainstrike.dev'], { cwd: real });
  await execFileAsync('git', ['config', 'user.name', 'Brainstrike Test'], { cwd: real });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: real });
  return real;
}

async function writeFile(repo: string, name: string, content: string): Promise<void> {
  await fsPromises.writeFile(path.join(repo, name), content, 'utf8');
}

async function commitAll(repo: string, message: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: repo });
  await execFileAsync('git', ['commit', '-qm', message], { cwd: repo });
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

const deps = { run: execFileGitRunner };

function gitScope(repo: string, scope: GitScope) {
  return { kind: 'git-scope' as const, repositoryRoot: repo, scope, worktreePath: repo };
}

async function view(repo: string, scope: GitScope) {
  return await resolveGitScopeChangesetView(
    { ...deps, resolveRootCwd: async () => ({ ok: true, value: repo }) },
    'root-id',
    gitScope(repo, scope)
  );
}

describe('changeset git-scope — uncommitted', () => {
  it('lists modified force-tracked dist and build outputs despite ignore rules', async () => {
    const repo = await makeRepo();
    await fsPromises.mkdir(path.join(repo, 'dist'), { recursive: true });
    await fsPromises.mkdir(path.join(repo, 'build'), { recursive: true });
    await writeFile(repo, '.gitignore', 'dist/\nbuild/\n');
    await writeFile(repo, 'dist/committed.js', 'dist-before\n');
    await writeFile(repo, 'build/committed.js', 'build-before\n');
    await execFileAsync('git', ['add', '.gitignore'], { cwd: repo });
    await execFileAsync('git', ['add', '--force', 'dist/committed.js', 'build/committed.js'], {
      cwd: repo,
    });
    await execFileAsync('git', ['commit', '-qm', 'tracked outputs'], { cwd: repo });

    await writeFile(repo, 'dist/committed.js', 'dist-after\n');
    await writeFile(repo, 'build/committed.js', 'build-after\n');

    const result = await view(repo, { kind: 'uncommitted' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.files.map((file) => file.path).sort()).toEqual([
      'build/committed.js',
      'dist/committed.js',
    ]);
  });

  it('lists a staged change, an unstaged change, and an untracked file together', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'staged.txt', 'a\n');
    await writeFile(repo, 'unstaged.txt', 'b\n');
    await commitAll(repo, 'init');
    await writeFile(repo, 'staged.txt', 'a2\n');
    await execFileAsync('git', ['add', 'staged.txt'], { cwd: repo });
    await writeFile(repo, 'unstaged.txt', 'b2\n');
    await writeFile(repo, 'new.txt', 'brand new\n');

    const result = await view(repo, { kind: 'uncommitted' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const byPath = new Map(result.value.files.map((f) => [f.path, f]));
    expect(byPath.get('staged.txt')?.status).toBe('modified');
    expect(byPath.get('unstaged.txt')?.status).toBe('modified');
    expect(byPath.get('new.txt')?.status).toBe('untracked');
    expect(byPath.get('new.txt')?.additions).toBeNull();
  });

  it('unborn HEAD: an uncommitted scope still lists the staged/untracked files (empty-tree fallback)', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'hello\n');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: repo });
    await writeFile(repo, 'u.txt', 'untracked\n');

    const result = await view(repo, { kind: 'uncommitted' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const byPath = new Map(result.value.files.map((f) => [f.path, f]));
    expect(byPath.get('a.txt')?.status).toBe('added');
    expect(byPath.get('u.txt')?.status).toBe('untracked');
  });
});

describe('changeset git-scope — unstaged / staged', () => {
  it('unstaged lists only index-vs-worktree changes (not the staged one)', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'v1\n');
    await writeFile(repo, 'b.txt', 'v1\n');
    await commitAll(repo, 'init');
    await writeFile(repo, 'a.txt', 'v2-staged\n');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: repo });
    await writeFile(repo, 'b.txt', 'v2-unstaged\n');

    const unstaged = await view(repo, { kind: 'unstaged' });
    expect(unstaged.ok).toBe(true);
    if (!unstaged.ok) {
      return;
    }
    expect(unstaged.value.files.map((f) => f.path)).toEqual(['b.txt']);

    const staged = await view(repo, { kind: 'staged' });
    expect(staged.ok).toBe(true);
    if (!staged.ok) {
      return;
    }
    expect(staged.value.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('a file with BOTH staged and unstaged edits: the unstaged listing counts match the unstaged fileDiff (BST-1113 review finding)', async () => {
    // Regression for the review finding: `unstaged`'s per-file diff used to
    // be mapped to `working` mode (HEAD vs worktree) while its LISTING
    // compared the index vs worktree — a DIFFERENT comparison, so a file
    // with edits on both sides of the index reported contradictory numbers
    // between the list and the rendered diff.
    const repo = await makeRepo();
    await writeFile(repo, 'f.txt', 'line1\n');
    await commitAll(repo, 'init');
    await writeFile(repo, 'f.txt', 'line1\nline2-staged\n');
    await execFileAsync('git', ['add', 'f.txt'], { cwd: repo });
    await writeFile(repo, 'f.txt', 'line1\nline2-staged\nline3-unstaged\n');

    const unstaged = await view(repo, { kind: 'unstaged' });
    expect(unstaged.ok).toBe(true);
    if (!unstaged.ok) {
      return;
    }
    const entry = unstaged.value.files.find((f) => f.path === 'f.txt');
    expect(entry).toBeDefined();
    // Listing counts: index (line1, line2-staged) vs worktree (+line3) = +1/-0.
    expect(entry?.additions).toBe(1);
    expect(entry?.deletions).toBe(0);

    const fileDiff = await resolveGitScopeFileDiff(
      { ...deps, resolveRootCwd: async () => ({ ok: true, value: repo }) },
      'root-id',
      gitScope(repo, { kind: 'unstaged' }),
      'f.txt'
    );
    expect(fileDiff.ok).toBe(true);
    if (!fileDiff.ok) {
      return;
    }
    // The rendered diff must agree with the listing: the OLD side is the
    // INDEX (staged content), not HEAD — so only the unstaged line shows as
    // added, matching the listing's +1/-0, never the +2/-0 a HEAD-vs-worktree
    // ("working" mode) comparison would report.
    expect(fileDiff.value.additions).toBe(1);
    expect(fileDiff.value.deletions).toBe(0);
    expect(fileDiff.value.content).toEqual({
      kind: 'full',
      newContent: 'line1\nline2-staged\nline3-unstaged\n',
      oldContent: 'line1\nline2-staged\n',
    });
  });
});

describe('changeset git-scope — commit', () => {
  it.skipIf(process.platform === 'win32')(
    'a TYPECHANGE (symlink -> regular file) reports that ONE path as "modified" without failing the whole listing',
    async () => {
      // Regression for the review finding: `git diff --name-status` reports a
      // typechange as "T", which used to fail the ENTIRE changeset view (a
      // single unmapped status code aborted every file, not just this one).
      const repo = await makeRepo();
      await execFileAsync('ln', ['-s', 'target.txt', 'link'], { cwd: repo });
      await writeFile(repo, 'target.txt', 'hello\n');
      await commitAll(repo, 'init symlink');
      await fsPromises.rm(path.join(repo, 'link'));
      await writeFile(repo, 'link', 'now a regular file\n');
      await commitAll(repo, 'typechange link to a regular file');
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
      const commitId = stdout.trim();

      const result = await view(repo, { commitId, kind: 'commit' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const byPath = new Map(result.value.files.map((f) => [f.path, f]));
      expect(byPath.get('link')?.status).toBe('modified');
      expect(byPath.get('target.txt')).toBeUndefined();
    }
  );

  it('a root commit (no parent) reports every path as "added"', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'root content\n');
    await commitAll(repo, 'root commit');
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const commitId = stdout.trim();

    const result = await view(repo, { commitId, kind: 'commit' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.files).toEqual([
      expect.objectContaining({ path: 'a.txt', status: 'added' }),
    ]);
  });

  it('resolves an ABBREVIATED commit id to the full sha before use', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'v1\n');
    await commitAll(repo, 'init');
    await writeFile(repo, 'a.txt', 'v2\n');
    await commitAll(repo, 'edit');
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo });
    const shortId = stdout.trim();

    const result = await view(repo, { commitId: shortId, kind: 'commit' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.files.map((f) => f.path)).toEqual(['a.txt']);

    const fileDiff = await resolveGitScopeFileDiff(
      { ...deps, resolveRootCwd: async () => ({ ok: true, value: repo }) },
      'root-id',
      gitScope(repo, { commitId: shortId, kind: 'commit' }),
      'a.txt'
    );
    expect(fileDiff.ok).toBe(true);
  });

  it('a rename shows up with oldPath set', async () => {
    const repo = await makeRepo();
    await writeFile(
      repo,
      'old.txt',
      'same content, unlikely to be similar by luck\nline2\nline3\n'
    );
    await commitAll(repo, 'init');
    await execFileAsync('git', ['mv', 'old.txt', 'new.txt'], { cwd: repo });
    await commitAll(repo, 'rename');
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const commitId = stdout.trim();

    const result = await view(repo, { commitId, kind: 'commit' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.files).toEqual([
      expect.objectContaining({ oldPath: 'old.txt', path: 'new.txt', status: 'renamed' }),
    ]);
  });

  it('a binary file change is listed with null additions/deletions and EXCLUDED from totals', async () => {
    const repo = await makeRepo();
    await fsPromises.writeFile(
      path.join(repo, 'img.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])
    );
    await commitAll(repo, 'init binary');
    await fsPromises.writeFile(
      path.join(repo, 'img.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01])
    );
    await writeFile(repo, 'text.txt', 'line1\nline2\n');
    await commitAll(repo, 'edit binary + add text');
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const commitId = stdout.trim();

    const result = await view(repo, { commitId, kind: 'commit' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const byPath = new Map(result.value.files.map((f) => [f.path, f]));
    expect(byPath.get('img.png')?.additions).toBeNull();
    expect(byPath.get('img.png')?.deletions).toBeNull();
    // Only text.txt's 2 additions count — img.png's null contributes nothing.
    expect(result.value.totalAdditions).toBe(2);
    expect(result.value.totalDeletions).toBe(0);
  });

  it('a changeset whose ONLY changed file is binary totals a REAL 0/0, never null', async () => {
    // The whole point of widening ChangesetView's totals to `number | null`:
    // a git-scope changeset always computes real totals, so "every file was
    // binary" must still be the real number 0, distinct from a journal
    // changeset's `null` ("not computable at all").
    const repo = await makeRepo();
    await fsPromises.writeFile(
      path.join(repo, 'img.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])
    );
    await commitAll(repo, 'init binary');
    await fsPromises.writeFile(
      path.join(repo, 'img.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01])
    );
    await commitAll(repo, 'edit binary only');
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const commitId = stdout.trim();

    const result = await view(repo, { commitId, kind: 'commit' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.files.map((f) => f.path)).toEqual(['img.png']);
    expect(result.value.totalAdditions).toBe(0);
    expect(result.value.totalDeletions).toBe(0);
    expect(result.value.totalAdditions).not.toBeNull();
    expect(result.value.totalDeletions).not.toBeNull();
  });
});

describe('changeset git-scope — branch-vs-base', () => {
  it('lists changes from the merge-base to HEAD against an explicit baseRef', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'v1\n');
    await commitAll(repo, 'init');
    const { stdout: baseStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const baseRef = baseStdout.trim();
    await writeFile(repo, 'a.txt', 'v2\n');
    await commitAll(repo, 'edit a');

    const result = await view(repo, { baseRef, kind: 'branch-vs-base' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.files.map((f) => f.path)).toEqual(['a.txt']);

    const fileDiff = await resolveGitScopeFileDiff(
      { ...deps, resolveRootCwd: async () => ({ ok: true, value: repo }) },
      'root-id',
      gitScope(repo, { baseRef, kind: 'branch-vs-base' }),
      'a.txt'
    );
    expect(fileDiff.ok).toBe(true);
    if (!fileDiff.ok) {
      return;
    }
    expect(fileDiff.value.content).toEqual({
      kind: 'full',
      newContent: 'v2\n',
      oldContent: 'v1\n',
    });
  });
});

describe('changeset git-scope — containment', () => {
  it('outside-roots-unsupported when the worktree is not under the resolved root', async () => {
    const repo = await makeRepo();
    const otherRoot = await makeRepo();
    const result = await resolveGitScopeChangesetView(
      { ...deps, resolveRootCwd: async () => ({ ok: true, value: otherRoot }) },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: repo,
        scope: { kind: 'uncommitted' },
        worktreePath: repo,
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^outside-roots-unsupported:/);
  });
});
