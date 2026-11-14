// @vitest-environment node

/**
 * ADR-0034 build decisions (BST-2511, BST-2520): a repository the inventory finds inside an open
 * folder, whose own checkout is not itself an open folder, can have a project of its own, which
 * the store's roots domain keeps by the checkout's canonical path. The worktree listing reads it,
 * whether or not a mounted folder holds the checkout, and never writes one: the person's first
 * Rename project… or Move to project… makes it.
 *
 * Real git builds each folder; the real inventory, worktree service and state store read it.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STATE_DB, StateStore } from '@brainstrike/state-store';
import type { WorktreeListEntry } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInventorySnapshot } from '../../src/git-workspace/git-inventory-service.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import { withRepositoryProjects } from '../../src/git-workspace/repository-projects.ts';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared.ts';

const IDENTITY = ['-c', 'user.email=test@brainstrike.invalid', '-c', 'user.name=BrainStrike Test'];

describe('the project of a repository found inside an open folder (real git + real SQLite)', () => {
  let store: StateStore;
  let stateDir: string;
  const workspace = createTestWorkspace();

  /** A folder under the OS canonical spelling the inventory reports. */
  const freshFolder = (label: string) =>
    realpathSync.native(workspace.freshTempDir(`bst-repository-projects-${label}-`));

  /** A repository with one commit at `folder`. */
  function initRepository(folder: string): string {
    mkdirSync(folder, { recursive: true });
    git(folder, ['init', '--quiet', '-b', 'main']);
    git(folder, [...IDENTITY, 'commit', '--quiet', '--allow-empty', '-m', 'initial commit']);
    return folder;
  }

  /** Records `folder` as opened, as the person's pick does. */
  async function open(folder: string, rootId: string): Promise<void> {
    await store.workspaceRoots({
      operation: 'register',
      root: {
        canonicalPath: folder,
        displayName: path.basename(folder),
        path: folder,
        preferredId: rootId,
      },
    });
  }

  /** The worktree listing over the folders `roots` names as mounted. */
  function listing(roots: readonly { readonly id: string; readonly path: string }[]) {
    const service = buildTestService(
      { db: store, managedDirectory: workspace.freshManagedDir(), repo: roots[0]?.path ?? '' },
      {
        resolveInventory: () =>
          buildInventorySnapshot({
            loadRoots: () => Promise.resolve(roots),
            run: execFileGitRunner,
          }),
        resolveRootPaths: () => Promise.resolve(roots),
      }
    );
    const listed = withRepositoryProjects(service, store);
    return async (): Promise<readonly WorktreeListEntry[]> => {
      const result = await listed.list();
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    };
  }

  /** The listing's entry for the checkout at `checkout`. */
  function entryAt(entries: readonly WorktreeListEntry[], checkout: string) {
    return entries.find((entry) => entry.path === checkout);
  }

  /** Every project the state DB holds, read beside the store as another reader would. */
  function projectCount(): number {
    const db = new DatabaseSync(path.join(stateDir, STATE_DB), { readOnly: true });
    try {
      return Number(db.prepare('SELECT COUNT(*) AS count FROM projects').get()?.['count']);
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    stateDir = workspace.freshTempDir('bst-repository-projects-state-');
    store = await StateStore.open(stateDir);
  });

  afterEach(async () => {
    await store.close();
    workspace.cleanup();
  });

  it('writes no project while listing repositories inside an open folder, a submodule and a fixture among them, and reads the one the person names', async () => {
    const holder = freshFolder('holder');
    const inner = initRepository(path.join(holder, 'inner'));
    // A submodule, which git keeps under the repository's `.git/modules`, and a fixture repository.
    const library = initRepository(path.join(freshFolder('library'), 'library'));
    git(inner, [
      ...IDENTITY,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      library,
      'vendor/library',
    ]);
    initRepository(path.join(inner, 'test', 'fixtures', 'sample'));
    await open(holder, 'root-holder');
    const list = listing([{ id: 'root-holder', path: holder }]);
    const before = projectCount();

    const entries = await list();
    expect(entries.filter((entry) => entry.primary).length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) {
      expect(entry).toMatchObject({ projectId: null, projectName: null });
    }
    expect(projectCount()).toBe(before);

    // The person names it: the listing reads the project that made.
    await store.workspaceRoots({
      canonicalPath: inner,
      name: 'Inner',
      operation: 'rename-project',
    });
    expect(entryAt(await list(), inner)).toMatchObject({
      primary: true,
      projectId: expect.stringMatching(/\S/u),
      projectName: 'Inner',
      rootIdIsExactMount: false,
    });
    expect(projectCount()).toBe(before + 1);
  });

  it('keeps a named repository on its project while the folder that holds it is closed', async () => {
    const holder = freshFolder('closed');
    const inner = initRepository(path.join(holder, 'inner'));
    const worktree = path.join(freshFolder('managed'), 'inner-feature');
    git(inner, ['worktree', 'add', '--quiet', '-b', 'feature', worktree, 'HEAD']);
    await open(holder, 'root-holder');
    await store.workspaceRoots({
      canonicalPath: inner,
      name: 'Inner',
      operation: 'rename-project',
    });
    const { projects } = await store.workspaceRoots({
      canonicalPaths: [inner],
      operation: 'repository-projects',
    });

    // The folder is closed: only the thread's worktree is mounted, outside it.
    const entries = await listing([{ id: 'root-worktree', path: realpathSync.native(worktree) }])();
    expect(entryAt(entries, inner)).toMatchObject({
      containment: 'outside-roots',
      primary: true,
      projectId: projects?.[0]?.id,
      projectName: 'Inner',
    });
  });

  it('lists every repository when one inside the open folder can have no project', async () => {
    const holder = freshFolder('odd');
    const inner = initRepository(path.join(holder, 'inner'));
    // A scratch folder of a thread, recorded but not mounted, that became a repository.
    const odd = initRepository(path.join(holder, 'odd'));
    await store.workspaceRoots({
      operation: 'register-scratch',
      root: { canonicalPath: odd, displayName: 'odd', path: odd, preferredId: 'root-odd' },
      threadId: 'thread-odd',
    });
    await open(holder, 'root-holder');

    const entries = await listing([{ id: 'root-holder', path: holder }])();
    expect(entryAt(entries, inner)).toMatchObject({ primary: true, projectId: null });
    expect(entryAt(entries, odd)).toMatchObject({ primary: true, projectId: null });
  });

  it("leaves a repository that is itself the open folder to its folder's own project", async () => {
    const repository = initRepository(path.join(freshFolder('own'), 'repo'));
    await open(repository, 'root-own');

    expect(
      entryAt(await listing([{ id: 'root-own', path: repository }])(), repository)
    ).toMatchObject({ primary: true, projectId: null, rootIdIsExactMount: true });
  });
});
