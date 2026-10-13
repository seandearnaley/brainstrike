// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('WorkspaceRootRegistry recent-roots ledger + addRootByPath (real StateStore)', () => {
  let database: StateStore;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'brainstrike-root-kinds-'));
    database = await StateStore.open(directory);
  });

  afterEach(async () => {
    await database.close();
    await rm(directory, { force: true, recursive: true });
  });

  it('loads persisted worktree kinds through the canonical catalog', async () => {
    const storage = createStorage();
    const createRegistry = () =>
      new WorkspaceRootRegistry({
        createSecureRoot: async (rootPath) => secureRoot(rootPath),
        disposeCommandSessionsForRoot: vi.fn(async () => 0),
        evictLspServersForRoot: vi.fn(async () => undefined),
        getRootsCatalog: async () => database,
        pathExists: async () => true,
        resolveCanonicalRoot: async (rootPath) => rootPath,
        storage,
      });
    // The active managed-worktree ledger names the path, so Main's registry, the
    // one writer of `roots` (BST-1990), records the mount as a worktree.
    await database.worktreeLedger({
      operation: 'insert',
      row: {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseRef: 'main',
        branch: null,
        createdAt: '2026-10-13T00:00:00.000Z',
        createdBy: 'agent',
        id: 'bright-fox',
        path: '/managed/app/bright-fox',
        repoCommonDir: '/repo/.git',
        runId: null,
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: null,
      },
    });
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
    await firstRegistry.dispose();
    await relaunchedRegistry.dispose();
  });
});
