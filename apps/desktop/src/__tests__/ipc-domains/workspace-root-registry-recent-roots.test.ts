import path from 'node:path';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import {
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
} from '../../ipc-domains/workspace-root-registry';

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

function rootHandle(rootPath: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path.basename(rootPath),
    path: rootPath,
    platform: 'electron',
  };
}

function secureRoot(canonicalPath: string): SecureWorkspaceRoot {
  return {
    canonicalPath,
    close: vi.fn(),
    listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
    readFile: vi.fn(async () => ({ content: Buffer.from('inside'), status: 'ok' as const })),
  };
}

describe('WorkspaceRootRegistry recent-roots ledger + addRootByPath', () => {
  let storage: ElectronStorageAdapter;

  function createRegistry(): WorkspaceRootRegistry {
    const db = { query: vi.fn(async () => ({ rows: [] })) } as unknown as WorkspaceRootsQueryable;
    return new WorkspaceRootRegistry({
      createSecureRoot: async (rootPath) => secureRoot(rootPath),
      disposeCommandSessionsForRoot: vi.fn(async () => 0),
      evictLspServersForRoot: vi.fn(async () => undefined),
      getRootsDatabase: async () => db,
      pathExists: async () => true,
      resolveCanonicalRoot: async (rootPath) => path.normalize(rootPath),
      storage,
    });
  }

  beforeEach(() => {
    storage = createStorage();
  });

  it('records every successful addRoot in recentRootsList, newest first, deduped', async () => {
    const registry = createRegistry();
    await registry.addRoot(rootHandle('/ws/alpha'));
    await registry.addRoot(rootHandle('/ws/beta'));
    await registry.addRoot(rootHandle('/ws/alpha'));

    const recents = await registry.listRecentRoots();
    expect(recents.map((entry) => entry.path)).toEqual(['/ws/alpha', '/ws/beta']);
    expect(recents[0]?.displayName).toBe('alpha');
    expect(JSON.parse((await storage.getItem('recentRootsList')) ?? '[]')).toHaveLength(2);
  });

  it('caps the ledger at the newest 20 grants', async () => {
    const registry = createRegistry();
    for (let index = 0; index < 22; index += 1) {
      // eslint-disable-next-line react-doctor/async-await-in-loop -- grants must land serially: the cap under test is an ordering property of the grant sequence.
      await registry.addRoot(rootHandle(`/ws/root-${index}`));
    }

    const recents = await registry.listRecentRoots();
    expect(recents).toHaveLength(20);
    expect(recents[0]?.path).toBe('/ws/root-21');
    expect(recents.at(-1)?.path).toBe('/ws/root-2');
  });

  it('addRootByPath mounts a previously granted path without a picker and rejects an unknown one', async () => {
    const registry = createRegistry();
    await registry.addRoot(rootHandle('/ws/alpha'));
    const restored = await registry.restoreRoots();
    const restoredRootId = restored[0]?.rootId;
    expect(restoredRootId).toBeDefined();
    // Disconnecting drops the root from rootsList but must NOT revoke the
    // grant — that separation is what addRootByPath relies on.
    await registry.removeRoot(restoredRootId as string);

    const descriptor = await registry.addRootByPath('/ws/alpha');
    expect(descriptor.handle.path).toBe('/ws/alpha');
    expect(descriptor.permissionState).toBe('granted');

    await expect(registry.addRootByPath('/ws/never')).rejects.toThrow(
      'Folder was never granted in this app; use Add Folder to grant it.'
    );
  });

  it('restoreRoots records restored entries as recents', async () => {
    const registry = createRegistry();
    await storage.setItem(
      'rootsList',
      JSON.stringify([{ addedAt: 1, path: '/ws/gamma', rootId: 'r-gamma' }])
    );

    await registry.restoreRoots();

    expect((await registry.listRecentRoots()).map((entry) => entry.path)).toEqual(['/ws/gamma']);
  });

  it('does not churn lastGrantedAt on a second restoreRoots for an already-recorded path', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const registry = createRegistry();
      await storage.setItem(
        'rootsList',
        JSON.stringify([{ addedAt: 1, path: '/ws/gamma', rootId: 'r-gamma' }])
      );

      await registry.restoreRoots();
      const firstGrantedAt = (await registry.listRecentRoots())[0]?.lastGrantedAt;
      expect(firstGrantedAt).toBe(1_000_000);

      // Advance the clock so a churned ledger entry would visibly differ.
      vi.setSystemTime(2_000_000);
      await registry.restoreRoots();
      const secondGrantedAt = (await registry.listRecentRoots())[0]?.lastGrantedAt;

      expect(secondGrantedAt).toBe(firstGrantedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a malformed ledger instead of silently starting over', async () => {
    const registry = createRegistry();
    await storage.setItem('recentRootsList', JSON.stringify([{ path: '/ws/alpha' }]));

    await expect(registry.listRecentRoots()).rejects.toThrow('recentRootsList entry is malformed.');
  });

  it('surfaces a corrupt ledger read from addRoot instead of degrading it to a session-only mount', async () => {
    const registry = createRegistry();
    await storage.setItem('recentRootsList', JSON.stringify([{ path: '/ws/alpha' }]));

    await expect(registry.addRoot(rootHandle('/ws/beta'))).rejects.toThrow(
      'recentRootsList entry is malformed.'
    );
  });

  it('tolerates a recentRootsList write failure without failing addRoot (accepted deviation)', async () => {
    const registry = createRegistry();
    const setItemMock = vi.mocked(storage.setItem);
    const originalSetItem = setItemMock.getMockImplementation();
    setItemMock.mockImplementation(async (key: string, value: string) => {
      if (key === 'recentRootsList') {
        throw new Error('disk full');
      }
      await originalSetItem?.(key, value);
    });

    const descriptor = await registry.addRoot(rootHandle('/ws/gamma'));

    expect(descriptor.permissionState).toBe('granted');
    expect(await registry.listRecentRoots()).toEqual([]);
  });
});
