/**
 * Hermetic coverage for `git-inventory-service.ts`'s `buildInventorySnapshot`
 * against REAL temp git repositories (real `git init`/`worktree add`, real
 * filesystem walk, real `execFile`-backed hook-free git runner) — mirrors the
 * `makeRepo`/realpath pattern from `git-service.integration.test.ts:31-40`.
 *
 * Covers: multi-root discovery, a linked worktree inside and outside the
 * active roots, symlinked-root containment, the fabricated-gitdir trust
 * attack, a broken repo tolerated alongside a healthy one, and an unborn-HEAD
 * repo.
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitInventoryRepository, WorktreeDescriptor } from '@brainstrike/types';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInventorySnapshot } from '../../assistant-server/git-inventory-service';
import { execFileGitRunner } from '../../git-ipc-handlers';

const execFileAsync = promisify(execFile);
const createdRoots: string[] = [];

async function makeRepo(prefix = 'brainstrike-git-inventory-'): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  await execFileAsync('git', ['init', '-q'], { cwd: real });
  await execFileAsync('git', ['config', 'user.email', 'test@brainstrike.dev'], { cwd: real });
  await execFileAsync('git', ['config', 'user.name', 'Brainstrike Test'], { cwd: real });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: real });
  return real;
}

async function makeDir(prefix: string): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

/**
 * Initialize a git repo at an EXISTING directory (rather than mkdtemp-ing
 * directly under the shared OS tmpdir). Used when a test needs to open a
 * dedicated CONTAINER as the workspace root — opening `os.tmpdir()` itself as
 * a root would walk every other concurrently-running test's temp directory
 * too (flaky: races with unrelated cleanup, e.g. ENOENT mid-walk).
 */
async function initRepoAt(dir: string): Promise<string> {
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@brainstrike.dev'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Brainstrike Test'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

async function commitFile(repo: string, name: string, content: string): Promise<void> {
  await fsPromises.writeFile(path.join(repo, name), content, 'utf8');
  await execFileAsync('git', ['add', name], { cwd: repo });
  await execFileAsync('git', ['commit', '-q', '-m', `add ${name}`], { cwd: repo });
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

function loadRootsFrom(roots: readonly { id: string; path: string }[]) {
  return () => Promise.resolve(roots);
}

function findRepoByCommonDir(
  repositories: readonly GitInventoryRepository[],
  commonDirSuffix: string
): GitInventoryRepository | undefined {
  return repositories.find((repo) => repo.identity.gitCommonDir.endsWith(commonDirSuffix));
}

function findWorktreeByPath(
  worktrees: readonly WorktreeDescriptor[],
  targetPath: string
): WorktreeDescriptor | undefined {
  return worktrees.find((worktree) => worktree.path === targetPath);
}

describe('buildInventorySnapshot', () => {
  it('returns an empty snapshot for no roots', async () => {
    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([]),
      run: execFileGitRunner,
    });
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.repositories).toEqual([]);
    expect(typeof snapshot.capturedAt).toBe('number');
  });

  it('discovers a repository across multiple roots (multi-root discovery)', async () => {
    const repoA = await makeRepo();
    await commitFile(repoA, 'a.txt', 'a');
    const repoB = await makeRepo();
    await commitFile(repoB, 'b.txt', 'b');

    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([
        { id: 'root-a', path: repoA },
        { id: 'root-b', path: repoB },
      ]),
      run: execFileGitRunner,
    });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.repositories).toHaveLength(2);
    const repoAEntry = findRepoByCommonDir(
      snapshot.repositories,
      path.join(path.basename(repoA), '.git')
    );
    const repoBEntry = findRepoByCommonDir(
      snapshot.repositories,
      path.join(path.basename(repoB), '.git')
    );
    expect(repoAEntry).toBeDefined();
    expect(repoBEntry).toBeDefined();
    expect(repoAEntry?.identity.repositoryRoot).toBe(repoA);
    expect(repoAEntry?.worktrees[0]?.containment).toEqual(['root-a']);
    expect(repoAEntry?.worktrees[0]?.trust).toBe('validated');
    expect(repoAEntry?.worktrees[0]?.provenance).toBe('scanned');
  });

  it('reports a linked worktree INSIDE the active roots with containment set', async () => {
    // Both the main repo and its linked worktree live INSIDE a dedicated
    // container directory (never the shared OS tmpdir itself as a root) so
    // opening the container as a root walks only this test's own fixtures.
    const container = await makeDir('brainstrike-git-inventory-container-');
    const repo = path.join(container, 'main-repo');
    await fsPromises.mkdir(repo, { recursive: true });
    await initRepoAt(repo);
    await commitFile(repo, 'a.txt', 'a');
    await execFileAsync('git', ['branch', 'feat'], { cwd: repo });
    const linkedPath = path.join(container, 'main-repo-linked');
    await execFileAsync('git', ['worktree', 'add', '-q', linkedPath, 'feat'], { cwd: repo });
    const linkedReal = await fsPromises.realpath(linkedPath);

    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-parent', path: container }]),
      run: execFileGitRunner,
    });

    expect(snapshot.errors).toEqual([]);
    const repository = findRepoByCommonDir(snapshot.repositories, '.git');
    expect(repository).toBeDefined();
    const linkedDescriptor = findWorktreeByPath(repository?.worktrees ?? [], linkedReal);
    expect(linkedDescriptor).toBeDefined();
    expect(linkedDescriptor?.containment).toEqual(['root-parent']);
    expect(linkedDescriptor?.trust).toBe('validated');
  });

  it('reports a REAL linked worktree OUTSIDE every root as outside-roots but still validated', async () => {
    const repo = await makeRepo();
    await commitFile(repo, 'a.txt', 'a');
    await execFileAsync('git', ['branch', 'feat'], { cwd: repo });
    const outsideParent = await makeDir('brainstrike-git-inventory-outside-');
    const linkedPath = path.join(outsideParent, 'linked-wt');
    await execFileAsync('git', ['worktree', 'add', '-q', linkedPath, 'feat'], { cwd: repo });
    const linkedReal = await fsPromises.realpath(linkedPath);

    // Only the main repo is an active root — the linked worktree's parent is NOT.
    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-main', path: repo }]),
      run: execFileGitRunner,
    });

    expect(snapshot.errors).toEqual([]);
    const repository = findRepoByCommonDir(snapshot.repositories, '.git');
    const linkedDescriptor = findWorktreeByPath(repository?.worktrees ?? [], linkedReal);
    expect(linkedDescriptor).toBeDefined();
    expect(linkedDescriptor?.containment).toBe('outside-roots');
    // A REAL worktree's `.git` points back to the same common dir — validated,
    // even though it lies outside every root.
    expect(linkedDescriptor?.trust).toBe('validated');
  });

  it('classifies a symlinked root correctly (raw mkdtemp-adjacent path passed, canonical expected)', async () => {
    const repo = await makeRepo();
    await commitFile(repo, 'a.txt', 'a');
    const symlinkContainer = await makeDir('brainstrike-git-inventory-symlink-container-');
    const symlinkPath = path.join(symlinkContainer, 'root-symlink');
    await fsPromises.symlink(repo, symlinkPath, 'dir');

    // Pass the RAW symlink path as the root — the service must realpath it
    // before containment, so the worktree (reported by git as the CANONICAL
    // repo path) still classifies as contained.
    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-symlinked', path: symlinkPath }]),
      run: execFileGitRunner,
    });

    expect(snapshot.errors).toEqual([]);
    const repository = findRepoByCommonDir(snapshot.repositories, '.git');
    expect(repository?.identity.repositoryRoot).toBe(repo);
    expect(repository?.worktrees[0]?.containment).toEqual(['root-symlinked']);
  });

  it('fabricated-gitdir attack: a hand-written worktree admin entry pointing outside every root is present but UNVALIDATED, with no content access beyond its own .git', async () => {
    const repo = await makeRepo();
    await commitFile(repo, 'a.txt', 'a');
    const attackTarget = await makeDir('brainstrike-git-inventory-attack-target-');
    // The attack target is a plain directory with unrelated content — it is
    // NOT a real linked worktree of `repo` (its own `.git` does not exist, so
    // it can never point back to `repo`'s common dir).
    await fsPromises.writeFile(
      path.join(attackTarget, 'secret.txt'),
      'should never be read',
      'utf8'
    );

    await fsPromises.mkdir(path.join(repo, '.git', 'worktrees', 'evil'), { recursive: true });
    await fsPromises.writeFile(
      path.join(repo, '.git', 'worktrees', 'evil', 'gitdir'),
      `${path.join(attackTarget, '.git')}\n`,
      'utf8'
    );
    await fsPromises.writeFile(
      path.join(repo, '.git', 'worktrees', 'evil', 'HEAD'),
      'ref: refs/heads/master\n',
      'utf8'
    );
    await fsPromises.writeFile(
      path.join(repo, '.git', 'worktrees', 'evil', 'commondir'),
      '../..\n',
      'utf8'
    );

    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-main', path: repo }]),
      run: execFileGitRunner,
    });

    // The fabrication is surfaced, never silently dropped — no snapshot-level
    // error either (this is a per-worktree trust classification, not a
    // repository-level failure).
    expect(snapshot.errors).toEqual([]);
    const repository = findRepoByCommonDir(snapshot.repositories, '.git');
    const evilDescriptor = findWorktreeByPath(repository?.worktrees ?? [], attackTarget);
    expect(evilDescriptor).toBeDefined();
    expect(evilDescriptor?.containment).toBe('outside-roots');
    expect(evilDescriptor?.trust).toBe('unvalidated');
  });

  it('tolerates a broken repo (unresolvable gitdir) alongside a healthy one — errors entry, rest of inventory intact', async () => {
    const healthyRepo = await makeRepo();
    await commitFile(healthyRepo, 'a.txt', 'a');

    const brokenContainer = await makeDir('brainstrike-git-inventory-broken-');
    const brokenRepoPath = path.join(brokenContainer, 'broken-repo');
    await fsPromises.mkdir(brokenRepoPath, { recursive: true });
    // A `.git` FILE whose gitdir pointer resolves nowhere.
    await fsPromises.writeFile(
      path.join(brokenRepoPath, '.git'),
      'gitdir: /this/path/does/not/exist/.git\n',
      'utf8'
    );

    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([
        { id: 'root-healthy', path: healthyRepo },
        { id: 'root-broken', path: brokenContainer },
      ]),
      run: execFileGitRunner,
    });

    expect(snapshot.errors.length).toBeGreaterThan(0);
    expect(snapshot.errors.some((error) => error.includes(brokenRepoPath))).toBe(true);
    const healthyEntry = findRepoByCommonDir(
      snapshot.repositories,
      path.join(path.basename(healthyRepo), '.git')
    );
    expect(healthyEntry).toBeDefined();
    expect(snapshot.repositories).toHaveLength(1);
  });

  it('tolerates an unborn-HEAD repo (no commits yet) in enumeration', async () => {
    const unbornRepo = await makeRepo();

    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-unborn', path: unbornRepo }]),
      run: execFileGitRunner,
    });

    expect(snapshot.errors).toEqual([]);
    const repository = findRepoByCommonDir(snapshot.repositories, '.git');
    expect(repository).toBeDefined();
    expect(repository?.identity.repositoryRoot).toBe(unbornRepo);
    expect(repository?.worktrees).toHaveLength(1);
    expect(repository?.worktrees[0]?.containment).toEqual(['root-unborn']);
  });

  it('reports a root that cannot be resolved as a visible error and skips it, not silently', async () => {
    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-missing', path: '/does/not/exist/at/all' }]),
      run: execFileGitRunner,
    });

    expect(snapshot.repositories).toEqual([]);
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toContain('root-missing');
  });
});
