// @vitest-environment node

/**
 * Git records a linked worktree twice: the repository's
 * `.git/worktrees/<name>/gitdir` names the folder, and the folder's own `.git`
 * names the repository back. A repository can write the first half about any
 * folder, so only the two together show that a folder is its worktree.
 *
 * Every folder here is open, the case where the inventory once took the
 * repository's half as enough. Real git builds each shape; the real inventory,
 * worktree service and ledger read it (the `worktree-service.shared.ts`
 * harness).
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import type { GitInventory, WorktreeDescriptor } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInventorySnapshot } from '../../src/git-workspace/git-inventory-service.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared.ts';

describe('worktree links inside an open folder (real git + real SQLite)', () => {
  let db: StateStore;
  let repo: string;
  const workspace = createTestWorkspace();

  /** A fresh repository under the OS canonical spelling the inventory reports. */
  const freshRepo = (label: string) => realpathSync.native(workspace.freshRepo(label));

  /** Opens every folder, in order, and reads them through the real inventory. */
  function openFolders(...folders: readonly string[]) {
    const roots = folders.map((folder, index) => ({ id: `r-${index + 1}`, path: folder }));
    const resolveInventory = () =>
      buildInventorySnapshot({ loadRoots: () => Promise.resolve(roots), run: execFileGitRunner });
    const service = buildTestService(
      { db, managedDirectory: workspace.freshManagedDir(), repo },
      { resolveInventory, resolveRootPaths: () => Promise.resolve(roots) }
    );
    return { resolveInventory, service };
  }

  /**
   * Writes only the repository's half of a worktree link: `repository` now
   * lists `folder` as its worktree, while `folder`'s own `.git` is untouched.
   */
  function listFolderAsWorktree(repository: string, folder: string): void {
    const admin = path.join(repository, '.git', 'worktrees', 'listed');
    mkdirSync(admin, { recursive: true });
    writeFileSync(path.join(admin, 'gitdir'), `${path.join(folder, '.git')}\n`);
    writeFileSync(path.join(admin, 'HEAD'), git(repository, ['rev-parse', 'HEAD']));
    writeFileSync(path.join(admin, 'commondir'), '../..\n');
  }

  /** What the repository whose common dir is `gitCommonDir` reports at `worktreePath`. */
  function listedBy(
    inventory: GitInventory,
    gitCommonDir: string,
    worktreePath: string
  ): WorktreeDescriptor | undefined {
    return inventory.repositories
      .find((repository) => repository.identity.gitCommonDir === gitCommonDir)
      ?.worktrees.find((worktree) => worktree.path === worktreePath);
  }

  beforeEach(async () => {
    db = await StateStore.open(workspace.freshTempDir('bst-worktree-state-'));
    repo = freshRepo('repo');
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  it('reports a folder a repository lists as unvalidated when the folder is its own repository', async () => {
    const folder = freshRepo('other');
    listFolderAsWorktree(repo, folder);
    const { resolveInventory } = openFolders(repo, folder);

    const inventory = await resolveInventory();

    expect(inventory.errors).toEqual([]);
    expect(listedBy(inventory, path.join(repo, '.git'), folder)).toMatchObject({
      containment: ['r-2'],
      trust: 'unvalidated',
      // Names what the folder's own `.git` is, so the refusal can be acted on.
      trustReason: expect.stringContaining(path.join(folder, '.git')),
    });
  });

  it('refuses to adopt a folder that only a listing claims, and records no worktree', async () => {
    // The inventory never looks inside `node_modules`, so this repository is
    // not in it: the listing is the only claim on the folder.
    const folder = path.join(repo, 'node_modules', 'vendored');
    mkdirSync(folder, { recursive: true });
    git(folder, ['init', '--quiet', '-b', 'main']);
    listFolderAsWorktree(repo, folder);
    const { service } = openFolders(repo);

    const adopted = await service.adopt({ createdBy: 'user', path: folder });

    expect(adopted).toMatchObject({
      error: {
        code: 'worktree.unverified',
        // The refusal says what the folder's own `.git` is.
        message: expect.stringContaining(path.join(folder, '.git')),
      },
      ok: false,
    });
    await expect(service.listManagedPaths()).resolves.toEqual({ ok: true, value: [] });
  });

  describe.each([
    ['the listing repository', (lister: string, owner: string) => [lister, owner]],
    ['the owning repository', (lister: string, owner: string) => [owner, lister]],
  ])('when two repositories list one folder and %s is opened first', (_first, opened) => {
    /** `repo` owns a worktree git created; another repository lists that folder too. */
    function ownedAndAlsoListed() {
      const worktreePath = path.join(repo, '.claude', 'worktrees', 'feature');
      git(repo, ['worktree', 'add', '--quiet', '-b', 'bs/feature', worktreePath, 'HEAD']);
      const lister = freshRepo('other');
      listFolderAsWorktree(lister, worktreePath);
      return { lister, worktreePath, ...openFolders(...opened(lister, repo)) };
    }

    it('adopts the worktree for the repository its own .git names', async () => {
      const { lister, resolveInventory, service, worktreePath } = ownedAndAlsoListed();

      const adopted = await service.adopt({ createdBy: 'user', path: worktreePath });

      expect(adopted).toMatchObject({
        ok: true,
        value: { path: worktreePath, repoCommonDir: path.join(repo, '.git') },
      });
      // The other repository's listing is still reported, for what it is.
      expect(
        listedBy(await resolveInventory(), path.join(lister, '.git'), worktreePath)
      ).toMatchObject({ trust: 'unvalidated' });
    });

    it("reads the worktree's status", async () => {
      const { service, worktreePath } = ownedAndAlsoListed();

      const status = await service.checkoutStatus({ path: worktreePath });

      expect(status).toMatchObject({ ok: true, value: { clean: true, path: worktreePath } });
    });

    it("refuses to adopt another repository's primary checkout, and records no worktree", async () => {
      const owner = freshRepo('other');
      listFolderAsWorktree(repo, owner);
      const { service } = openFolders(...opened(repo, owner));

      const adopted = await service.adopt({ createdBy: 'user', path: owner });

      expect(adopted).toMatchObject({ error: { code: 'worktree.primary-checkout' }, ok: false });
      await expect(service.listManagedPaths()).resolves.toEqual({ ok: true, value: [] });
    });
  });

  it('adopts a worktree git created inside the open folder', async () => {
    const worktreePath = path.join(repo, '.claude', 'worktrees', 'feature');
    git(repo, ['worktree', 'add', '--quiet', '-b', 'bs/feature', worktreePath, 'HEAD']);
    const { service } = openFolders(repo);

    const adopted = await service.adopt({ createdBy: 'user', path: worktreePath });

    expect(adopted).toMatchObject({
      ok: true,
      value: { path: worktreePath, repoCommonDir: path.join(repo, '.git') },
    });
  });

  it("keeps a submodule's repository validated, whose checkout git names by its git directory", async () => {
    // Git derives a repository's primary checkout from its common dir, and for
    // a submodule that is the git directory itself: a path with no `.git` in
    // it and no link file written about it, so there is nothing to read back.
    const library = freshRepo('library');
    git(repo, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      '--quiet',
      'add',
      library,
      'library',
    ]);
    const submoduleGitDir = path.join(repo, '.git', 'modules', 'library');
    const { resolveInventory } = openFolders(repo);

    const inventory = await resolveInventory();

    expect(inventory.errors).toEqual([]);
    expect(listedBy(inventory, submoduleGitDir, submoduleGitDir)).toMatchObject({
      containment: ['r-1'],
      trust: 'validated',
      trustReason: null,
    });
  });
});
