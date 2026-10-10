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
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GitInventoryRepository, WorktreeDescriptor } from '@brainstrike/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNodeInventoryFs,
  type InventoryFs,
} from '../../assistant-server/git-inventory-discovery';
import { buildInventorySnapshot } from '../../assistant-server/git-inventory-service';
import { execFixtureGit, fixtureGitRunner } from './_git-fixture-environment';

const createdRoots: string[] = [];

async function makeRepo(prefix = 'brainstrike-git-inventory-'): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  await execFixtureGit(['init', '-q'], { cwd: real });
  await execFixtureGit(['config', 'user.email', 'test@brainstrike.dev'], { cwd: real });
  await execFixtureGit(['config', 'user.name', 'Brainstrike Test'], { cwd: real });
  await execFixtureGit(['config', 'commit.gpgsign', 'false'], { cwd: real });
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
  await execFixtureGit(['init', '-q'], { cwd: dir });
  await execFixtureGit(['config', 'user.email', 'test@brainstrike.dev'], { cwd: dir });
  await execFixtureGit(['config', 'user.name', 'Brainstrike Test'], { cwd: dir });
  await execFixtureGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

async function commitFile(repo: string, name: string, content: string): Promise<void> {
  await fsPromises.writeFile(path.join(repo, name), content, 'utf8');
  await execFixtureGit(['add', name], { cwd: repo });
  await execFixtureGit(['commit', '-q', '-m', `add ${name}`], { cwd: repo });
}

/**
 * Hand-write a `.git/worktrees/<name>/gitdir` admin entry — the
 * attacker-writable file `git worktree list` trusts verbatim, never
 * canonicalizing it. `targetGitPath` is whatever the attack wants git to
 * report as this worktree's location; it need not point at anything real.
 */
async function writeFabricatedWorktreeAdmin(
  repo: string,
  name: string,
  targetGitPath: string
): Promise<void> {
  const worktreesDir = path.join(repo, '.git', 'worktrees');
  await expect(
    fsPromises.lstat(worktreesDir),
    'Fabricated inventory requires a fresh repository without existing worktree admin entries'
  ).rejects.toMatchObject({ code: 'ENOENT' });
  // Each attack fixture starts without worktrees. Publish its complete, locked
  // admin directory atomically so Git maintenance cannot prune partial writes.
  const stagingDir = await fsPromises.mkdtemp(path.join(repo, '.git', 'inventory-admin-'));
  const adminDir = path.join(stagingDir, name);
  await fsPromises.mkdir(adminDir);
  await fsPromises.writeFile(path.join(adminDir, 'locked'), 'security fixture\n', 'utf8');
  await fsPromises.writeFile(path.join(adminDir, 'gitdir'), `${targetGitPath}\n`, 'utf8');
  await fsPromises.writeFile(path.join(adminDir, 'HEAD'), 'ref: refs/heads/master\n', 'utf8');
  await fsPromises.writeFile(path.join(adminDir, 'commondir'), '../..\n', 'utf8');
  await fsPromises.rename(stagingDir, worktreesDir);
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
      run: fixtureGitRunner,
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
      run: fixtureGitRunner,
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
    await execFixtureGit(['branch', 'feat'], { cwd: repo });
    const linkedPath = path.join(container, 'main-repo-linked');
    await execFixtureGit(['worktree', 'add', '-q', linkedPath, 'feat'], { cwd: repo });
    const linkedReal = await fsPromises.realpath(linkedPath);

    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-parent', path: container }]),
      run: fixtureGitRunner,
    });

    expect(snapshot.errors).toEqual([]);
    // Exactly ONE repository entry: the main `.git` DIRECTORY and the linked
    // worktree's `.git` FILE both resolve to the same common dir and must be
    // deduped into a single group BEFORE any `git worktree list` spawn — a
    // dedup keyed by `${commonDir}::${entryPath}` instead of `commonDir`
    // alone would spawn twice and report this repository twice.
    expect(snapshot.repositories).toHaveLength(1);
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
    await execFixtureGit(['branch', 'feat'], { cwd: repo });
    const outsideParent = await makeDir('brainstrike-git-inventory-outside-');
    const linkedPath = path.join(outsideParent, 'linked-wt');
    await execFixtureGit(['worktree', 'add', '-q', linkedPath, 'feat'], { cwd: repo });
    const linkedReal = await fsPromises.realpath(linkedPath);

    // Only the main repo is an active root — the linked worktree's parent is NOT.
    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-main', path: repo }]),
      run: fixtureGitRunner,
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

  it('treats a merely-prunable (deleted, not yet `git worktree prune`d) linked worktree as trust state, not an inventory error', async () => {
    // The routine, extremely common case: the user deleted a linked
    // worktree's directory directly (rm -rf, Finder, etc.) without running
    // `git worktree prune` first. `git worktree list` still reports the
    // entry — now marked `prunable` — and its `gitdir` no longer resolves.
    const repo = await makeRepo();
    await commitFile(repo, 'a.txt', 'a');
    await execFixtureGit(['branch', 'feat'], { cwd: repo });
    const outsideParent = await makeDir('brainstrike-git-inventory-prunable-');
    const linkedPath = path.join(outsideParent, 'linked-wt');
    await execFixtureGit(['worktree', 'add', '-q', linkedPath, 'feat'], { cwd: repo });
    const linkedReal = await fsPromises.realpath(linkedPath);

    await fsPromises.rm(linkedPath, { force: true, recursive: true });

    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-main', path: repo }]),
      run: fixtureGitRunner,
    });

    // The realpath failure on a PRUNABLE worktree is routine housekeeping,
    // not an inventory failure — it must NOT surface in `snapshot.errors`,
    // which later workstreams treat as a health signal.
    expect(snapshot.errors).toEqual([]);
    const repository = findRepoByCommonDir(snapshot.repositories, '.git');
    expect(repository).toBeDefined();
    const prunableDescriptor = findWorktreeByPath(repository?.worktrees ?? [], linkedReal);
    expect(prunableDescriptor).toBeDefined();
    expect(prunableDescriptor?.prunableReason).toBe('gitdir file points to non-existent location');
    expect(prunableDescriptor?.trust).toBe('unvalidated');
    // The trust reason still carries git's own explanation, so an operator
    // debugging an `unvalidated` entry has something to act on.
    expect(prunableDescriptor?.trustReason).toBe(prunableDescriptor?.prunableReason);
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
      run: fixtureGitRunner,
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
    await writeFabricatedWorktreeAdmin(repo, 'evil', path.join(attackTarget, '.git'));

    // Wrap the REAL fs with a call recorder so "no content access beyond its
    // own .git" is proven, not just asserted in a comment — a mutation that
    // reads/lists everything under a discovered worktree's target would
    // otherwise stay green here even with `secret.txt` sitting right there.
    const realFs = createNodeInventoryFs();
    const readdirCalls: string[] = [];
    const readFileCalls: string[] = [];
    const recordingFs: InventoryFs = {
      lstat: (targetPath) => realFs.lstat(targetPath),
      readdir: (dirPath) => {
        readdirCalls.push(dirPath);
        return realFs.readdir(dirPath);
      },
      readFile: (filePath) => {
        readFileCalls.push(filePath);
        return realFs.readFile(filePath);
      },
      realpath: (targetPath) => realFs.realpath(targetPath),
    };

    const snapshot = await buildInventorySnapshot({
      fs: recordingFs,
      loadRoots: loadRootsFrom([{ id: 'root-main', path: repo }]),
      run: fixtureGitRunner,
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
    // The failure reason is carried, not discarded — an operator debugging
    // this entry has something to act on beyond the bare 'unvalidated' bit.
    expect(evilDescriptor?.trustReason).toContain('could not stat');

    // The security property: the attack target's own content (secret.txt) is
    // never listed or read — only its (nonexistent) `.git` is probed.
    expect(readdirCalls).not.toContain(attackTarget);
    expect(readFileCalls.some((filePath) => filePath.includes('secret.txt'))).toBe(false);
  });

  it('symlink-defeats-containment attack: a committed in-root symlink to an outside target is NOT auto-validated', async () => {
    const repo = await makeRepo();
    await commitFile(repo, 'a.txt', 'a');

    const outsideTarget = await makeDir('brainstrike-git-inventory-symlink-target-');
    // The symlink lives INSIDE the repo — attacker-writable via a normal
    // commit — but its REAL target is OUTSIDE every workspace root. `git
    // worktree list` will report this worktree's path exactly as the
    // fabricated `gitdir` file says: LEXICALLY inside the root.
    const insideLinkPath = path.join(repo, 'inside-link');
    await fsPromises.symlink(outsideTarget, insideLinkPath, 'dir');
    await execFixtureGit(['add', 'inside-link'], { cwd: repo });
    await execFixtureGit(['commit', '-q', '-m', 'add inside-link symlink'], { cwd: repo });

    await writeFabricatedWorktreeAdmin(repo, 'evil', path.join(insideLinkPath, '.git'));
    // Maintenance must leave the locked malicious entry visible to inventory;
    // the lock is attacker-constructible and does not establish trust.
    await execFixtureGit(['worktree', 'prune', '--expire=now'], { cwd: repo });
    await expect(
      fsPromises.readFile(path.join(repo, '.git', 'worktrees', 'evil', 'locked'), 'utf8'),
      'Git pruning must preserve the complete locked attack fixture before inventory runs'
    ).resolves.toBe('security fixture\n');

    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-main', path: repo }]),
      run: fixtureGitRunner,
    });

    expect(snapshot.errors).toEqual([]);
    const repository = findRepoByCommonDir(snapshot.repositories, '.git');
    const outsideTargetReal = await fsPromises.realpath(outsideTarget);
    const evilDescriptor = findWorktreeByPath(repository?.worktrees ?? [], outsideTargetReal);
    expect(
      evilDescriptor,
      `expected canonical outside target ${outsideTargetReal}; inventory reported ${JSON.stringify(repository?.worktrees ?? [])}`
    ).toBeDefined();
    // Canonicalized BEFORE containment: the symlink's true target is outside
    // every root, so this must NOT be lexically classified as in-root
    // (which would skip the trust check entirely and auto-`validated`).
    expect(evilDescriptor?.containment).toBe('outside-roots');
    expect(evilDescriptor?.trust).toBe('unvalidated');
    // `name`/`current` recomputed from the CANONICAL path too (BST-1112
    // review 3712381425) — `git worktree list` reports this worktree's raw
    // path as `inside-link` (the attacker-chosen, in-root symlink name); a
    // `name` still derived from that raw path would disagree with the
    // canonical `path` above and leak the attacker's chosen basename right
    // next to the true (outside-roots) location.
    expect(evilDescriptor?.name).not.toBe('inside-link');
    expect(evilDescriptor?.name).toBe(path.basename(outsideTargetReal));
    expect(evilDescriptor?.current).toBe(false);
  });

  it('fabricated-gitdir attack pointing at a DIFFERENT real repository: resolves but the common dir mismatches — unvalidated', async () => {
    const repo = await makeRepo();
    await commitFile(repo, 'a.txt', 'a');
    // A completely different, real repository (e.g. the user's other
    // checkout) — its `.git` genuinely exists and resolves, so the ONLY
    // thing that can distinguish this from a real worktree is the equality
    // comparison against the EXPECTED common dir, not merely "does its .git
    // resolve at all".
    const otherRepo = await makeRepo();
    await commitFile(otherRepo, 'other.txt', 'other');

    await writeFabricatedWorktreeAdmin(repo, 'evil', path.join(otherRepo, '.git'));

    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-main', path: repo }]),
      run: fixtureGitRunner,
    });

    expect(snapshot.errors).toEqual([]);
    const repository = findRepoByCommonDir(
      snapshot.repositories,
      path.join(path.basename(repo), '.git')
    );
    const evilDescriptor = findWorktreeByPath(repository?.worktrees ?? [], otherRepo);
    expect(evilDescriptor).toBeDefined();
    expect(evilDescriptor?.containment).toBe('outside-roots');
    expect(evilDescriptor?.trust).toBe('unvalidated');
    expect(evilDescriptor?.trustReason).toContain('resolves to common dir');
  });

  it('discovers a repository ONLY via a linked worktree inside the root, with the main worktree outside every root (cwd-selection deviation)', async () => {
    // The main worktree lives OUTSIDE every root — never walked, never
    // discovered directly. Only its linked worktree, inside the one active
    // root, is ever found by the fs walk. `chooseGroupCwd` must fall back to
    // the linked worktree's `.git` FILE (no `.git` DIRECTORY was ever
    // discovered in this group) to pick a cwd for `git worktree list`, which
    // then reports the full inventory including the outside main worktree.
    const repo = await makeRepo();
    await commitFile(repo, 'a.txt', 'a');
    await execFixtureGit(['branch', 'feat'], { cwd: repo });
    const container = await makeDir('brainstrike-git-inventory-linked-only-root-');
    const linkedPath = path.join(container, 'linked-wt');
    await execFixtureGit(['worktree', 'add', '-q', linkedPath, 'feat'], { cwd: repo });
    const linkedReal = await fsPromises.realpath(linkedPath);

    const snapshot = await buildInventorySnapshot({
      loadRoots: loadRootsFrom([{ id: 'root-linked-only', path: container }]),
      run: fixtureGitRunner,
    });

    expect(snapshot.errors).toEqual([]);
    const repository = findRepoByCommonDir(snapshot.repositories, '.git');
    expect(repository).toBeDefined();
    // repositoryRoot is always the MAIN worktree (git worktree list's first
    // entry) even though only the linked worktree was ever walked.
    expect(repository?.identity.repositoryRoot).toBe(repo);

    const mainDescriptor = findWorktreeByPath(repository?.worktrees ?? [], repo);
    expect(mainDescriptor).toBeDefined();
    expect(mainDescriptor?.containment).toBe('outside-roots');
    expect(mainDescriptor?.trust).toBe('validated');

    const linkedDescriptor = findWorktreeByPath(repository?.worktrees ?? [], linkedReal);
    expect(linkedDescriptor).toBeDefined();
    expect(linkedDescriptor?.containment).toEqual(['root-linked-only']);
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
      run: fixtureGitRunner,
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
      run: fixtureGitRunner,
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
      run: fixtureGitRunner,
    });

    expect(snapshot.repositories).toEqual([]);
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toContain('root-missing');
  });
});
