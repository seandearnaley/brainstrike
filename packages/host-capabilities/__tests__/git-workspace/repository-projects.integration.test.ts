// @vitest-environment node

/**
 * ADR-0034 build decisions (BST-2511): a repository the inventory finds inside an open folder,
 * whose own checkout is not itself an open folder, has a project of its own, which the store's
 * roots domain keeps by the checkout's canonical path. The worktree listing names it, so the
 * Threads panel can name, join and list that repository's section as a project.
 *
 * Real git builds each folder; the real inventory, worktree service and state store read it.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import type { WorktreeListEntry } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInventorySnapshot } from '../../src/git-workspace/git-inventory-service.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import { withRepositoryProjects } from '../../src/git-workspace/repository-projects.ts';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared.ts';

describe('the project of a repository found inside an open folder (real git + real SQLite)', () => {
  let store: StateStore;
  const workspace = createTestWorkspace();

  /** A folder under the OS canonical spelling the inventory reports. */
  const freshFolder = (label: string) =>
    realpathSync.native(workspace.freshTempDir(`bst-repository-projects-${label}-`));

  /** A repository with one commit at `folder`. */
  function initRepository(folder: string): string {
    mkdirSync(folder, { recursive: true });
    git(folder, ['init', '--quiet', '-b', 'main']);
    git(folder, [
      '-c',
      'user.email=test@brainstrike.invalid',
      '-c',
      'user.name=BrainStrike Test',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'initial commit',
    ]);
    return folder;
  }

  /** Opens `folder` as the person does, so the store records it, and lists worktrees. */
  async function openAndList(folder: string, rootId: string) {
    await store.workspaceRoots({
      operation: 'register',
      root: {
        canonicalPath: folder,
        displayName: path.basename(folder),
        path: folder,
        preferredId: rootId,
      },
    });
    const roots = [{ id: rootId, path: folder }];
    const service = buildTestService(
      { db: store, managedDirectory: workspace.freshManagedDir(), repo: folder },
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

  beforeEach(async () => {
    store = await StateStore.open(workspace.freshTempDir('bst-repository-projects-state-'));
  });

  afterEach(async () => {
    await store.close();
    workspace.cleanup();
  });

  it("names a project for a repository inside an open folder, its own and not the folder's, and the same one each time", async () => {
    const container = freshFolder('container');
    const inner = initRepository(path.join(container, 'vendor', 'inner'));
    const list = await openAndList(container, 'root-container');
    const { roots } = await store.workspaceRoots({ operation: 'list' });
    const containerProject = roots[0]?.projectId;

    const entry = entryAt(await list(), inner);
    expect(entry).toMatchObject({
      primary: true,
      projectId: expect.stringMatching(/\S/u),
      projectName: null,
      rootIdIsExactMount: false,
    });
    expect(entry?.projectId).not.toBe(containerProject);
    expect(entryAt(await list(), inner)?.projectId).toBe(entry?.projectId);

    // The name the person gives it is the one the listing carries.
    await store.workspaceRoots({
      name: 'Inner library',
      operation: 'rename-project',
      projectId: entry?.projectId ?? '',
    });
    expect(entryAt(await list(), inner)).toMatchObject({
      projectId: entry?.projectId,
      projectName: 'Inner library',
    });
    // No folder was recorded for it: it is still not an open folder.
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toHaveLength(1);
  });

  it('names no project for a repository reached only through a worktree of it inside the open folder', async () => {
    const container = freshFolder('holder');
    const outside = initRepository(path.join(freshFolder('outside'), 'repo'));
    const linked = path.join(container, 'linked');
    git(outside, ['worktree', 'add', '--quiet', '-b', 'feature', linked, 'HEAD']);
    const list = await openAndList(container, 'root-holder');

    const entries = await list();
    // Its own checkout is outside every open folder, so nothing looks there.
    expect(entryAt(entries, outside)).toMatchObject({
      containment: 'outside-roots',
      primary: true,
      projectId: null,
      projectName: null,
    });
    expect(entryAt(entries, realpathSync.native(linked))).toMatchObject({
      primary: false,
      projectId: null,
    });
  });

  it("leaves a repository that is itself the open folder to its folder's own project", async () => {
    const repository = initRepository(path.join(freshFolder('own'), 'repo'));
    const list = await openAndList(repository, 'root-own');

    expect(entryAt(await list(), repository)).toMatchObject({
      primary: true,
      projectId: null,
      rootIdIsExactMount: true,
    });
  });
});
