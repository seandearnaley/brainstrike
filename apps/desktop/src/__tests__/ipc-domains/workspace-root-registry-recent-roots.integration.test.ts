import { migrate, wasmLoader } from '@brainstrike/db';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import {
  type StoredWorkspaceRoot,
  WorkspaceRootRegistry,
} from '../../ipc-domains/workspace-root-registry';
import { secureRoot } from './workspace-root-registry-test-helpers';

function createStorage(): ElectronStorageAdapter {
  const values = new Map<string, string>();
  return {
    clear: vi.fn(async () => values.clear()),
    getAllKeys: vi.fn(async () => [...values.keys()]),
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  } as unknown as ElectronStorageAdapter;
}

describe('WorkspaceRootRegistry recent-roots ledger + addRootByPath (real PGlite)', () => {
  let database: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

  beforeEach(async () => {
    database = await wasmLoader.createPGlite(`memory://workspace-root-kinds-${Date.now()}`);
    await migrate(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it('loads persisted worktree kinds through a typed ANY text-array query', async () => {
    const storage = createStorage();
    const createRegistry = () =>
      new WorkspaceRootRegistry({
        createSecureRoot: async (rootPath) => secureRoot(rootPath),
        disposeCommandSessionsForRoot: vi.fn(async () => 0),
        evictLspServersForRoot: vi.fn(async () => undefined),
        getRootsDatabase: async () => database as unknown as WorkspaceRootsQueryable,
        pathExists: async () => true,
        resolveCanonicalRoot: async (rootPath) => rootPath,
        storage,
      });
    // The active managed-worktree ledger names the path, so Main's registry, the
    // one writer of `roots` (BST-1990), records the mount as a worktree.
    await database.query(
      `INSERT INTO brainstrike_worktrees (id, repo_common_dir, path, base_ref, created_by)
       VALUES ('bright-fox', '/repo/.git', '/managed/app/bright-fox', 'main', 'agent')`
    );
    const firstRegistry = createRegistry();
    firstRegistry.setManagedWorktreeAuthorizer(() => Promise.resolve('authorized'));
    const descriptor = await firstRegistry.addRootByPath('/managed/app/bright-fox');

    const relaunchedRegistry = createRegistry();
    const storedRoots = JSON.parse((await storage.getItem('rootsList')) ?? '[]') as unknown;
    expect(Array.isArray(storedRoots)).toBe(true);
    if (!Array.isArray(storedRoots)) {
      return;
    }
    const persistedRoots = storedRoots as readonly StoredWorkspaceRoot[];
    const loadPersistedRootKinds = Reflect.get(
      relaunchedRegistry,
      'loadPersistedRootKinds'
    ) as unknown;
    expect(typeof loadPersistedRootKinds).toBe('function');
    if (typeof loadPersistedRootKinds !== 'function') {
      return;
    }
    const kindByRootId = await (
      loadPersistedRootKinds as (
        entries: readonly StoredWorkspaceRoot[]
      ) => Promise<ReadonlyMap<string, string | null>>
    ).call(relaunchedRegistry, persistedRoots);
    expect(kindByRootId.get(descriptor.rootId)).toBe('worktree');

    await relaunchedRegistry.restoreRoots();

    await expect(relaunchedRegistry.listRecentRoots()).resolves.toEqual([]);
  });
});
