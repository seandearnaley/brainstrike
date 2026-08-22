import path from 'node:path';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import { RECENT_ROOTS_LIMIT } from '../../ipc-domains/workspace-recent-roots';
import {
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
} from '../../ipc-domains/workspace-root-registry';

// Quarantine and write-failure paths log deliberately. Capturing the logger
// keeps the suite's output pristine AND makes "it was reported" an assertion
// rather than something a reader has to spot in the scrollback.
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));

const QUARANTINE_MESSAGE = 'Quarantined a corrupt recently-granted workspace folder ledger';

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
    loggerMock.error.mockClear();
    loggerMock.warn.mockClear();
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

  it('caps the ledger at the newest RECENT_ROOTS_LIMIT grants', async () => {
    const registry = createRegistry();
    const overflow = RECENT_ROOTS_LIMIT + 2;
    for (let index = 0; index < overflow; index += 1) {
      // eslint-disable-next-line react-doctor/async-await-in-loop -- grants must land serially: the cap under test is an ordering property of the grant sequence.
      await registry.addRoot(rootHandle(`/ws/root-${index}`));
    }

    const recents = await registry.listRecentRoots();
    expect(recents).toHaveLength(RECENT_ROOTS_LIMIT);
    expect(recents[0]?.path).toBe(`/ws/root-${overflow - 1}`);
    expect(recents.at(-1)?.path).toBe('/ws/root-2');
  });

  it('keys a trailing-separator path to the same ledger slot as the bare path', async () => {
    const registry = createRegistry();
    await registry.addRoot(rootHandle('/ws/alpha/'));

    const recents = await registry.listRecentRoots();
    expect(recents.map((entry) => entry.path)).toEqual(['/ws/alpha']);

    await registry.addRoot(rootHandle('/ws/alpha'));
    expect((await registry.listRecentRoots()).map((entry) => entry.path)).toEqual(['/ws/alpha']);

    // Lookup normalizes too: either spelling resolves the one grant.
    await expect(registry.addRootByPath('/ws/alpha/')).resolves.toMatchObject({
      permissionState: 'granted',
    });
  });

  it('keeps disconnected grants past the connected-root count within the cap', async () => {
    const registry = createRegistry();
    await registry.addRoot(rootHandle('/ws/disconnected'));
    const disconnected = await registry.listRecentRoots();
    expect(disconnected.map((entry) => entry.path)).toEqual(['/ws/disconnected']);

    // A user with many folders connected at once must not evict earlier
    // grants: the cap is storage hygiene, well above realistic mount counts.
    for (let index = 0; index < 24; index += 1) {
      // eslint-disable-next-line react-doctor/async-await-in-loop -- grants must land serially to reproduce the eviction pressure under test.
      await registry.addRoot(rootHandle(`/ws/mounted-${index}`));
    }

    const recents = await registry.listRecentRoots();
    expect(recents.map((entry) => entry.path)).toContain('/ws/disconnected');
    await expect(registry.addRootByPath('/ws/disconnected')).resolves.toMatchObject({
      permissionState: 'granted',
    });
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

  it('restoreRoots records an absent restored entry with its stored addedAt', async () => {
    const registry = createRegistry();
    await storage.setItem(
      'rootsList',
      JSON.stringify([{ addedAt: 1_700_000_000_000, path: '/ws/gamma', rootId: 'r-gamma' }])
    );

    await registry.restoreRoots();

    const recents = await registry.listRecentRoots();
    expect(recents.map((entry) => entry.path)).toEqual(['/ws/gamma']);
    expect(recents[0]?.lastGrantedAt).toBe(1_700_000_000_000);
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
      expect(firstGrantedAt).toBe(1);

      // Advance the clock so a churned ledger entry would visibly differ.
      vi.setSystemTime(2_000_000);
      await registry.restoreRoots();
      const secondGrantedAt = (await registry.listRecentRoots())[0]?.lastGrantedAt;

      expect(secondGrantedAt).toBe(firstGrantedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('quarantines a malformed ledger on the read path instead of bricking Recents', async () => {
    const registry = createRegistry();
    const corruptRaw = JSON.stringify([{ path: '/ws/alpha' }]);
    await storage.setItem('recentRootsList', corruptRaw);

    expect(await registry.listRecentRoots()).toEqual([]);
    expect(await storage.getItem('recentRootsList.corrupt')).toBe(corruptRaw);
    expect(await storage.getItem('recentRootsList')).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      QUARANTINE_MESSAGE,
      expect.objectContaining({ quarantineKey: 'recentRootsList.corrupt' })
    );
  });

  it('quarantines a malformed ledger on the record path and self-heals from the next grant', async () => {
    const registry = createRegistry();
    const corruptRaw = JSON.stringify([{ path: '/ws/alpha' }]);
    await storage.setItem('recentRootsList', corruptRaw);

    const descriptor = await registry.addRoot(rootHandle('/ws/beta'));

    expect(descriptor.permissionState).toBe('granted');
    expect(await storage.getItem('recentRootsList.corrupt')).toBe(corruptRaw);
    expect((await registry.listRecentRoots()).map((entry) => entry.path)).toEqual(['/ws/beta']);
    expect(loggerMock.error).toHaveBeenCalledWith(QUARANTINE_MESSAGE, expect.anything());
  });

  it('quarantines a malformed ledger on addRootByPath and rejects with the never-granted remedy', async () => {
    const registry = createRegistry();
    const corruptRaw = 'not json at all';
    await storage.setItem('recentRootsList', corruptRaw);

    await expect(registry.addRootByPath('/ws/alpha')).rejects.toThrow(
      'Folder was never granted in this app; use Add Folder to grant it.'
    );
    expect(await storage.getItem('recentRootsList.corrupt')).toBe(corruptRaw);
    expect(await storage.getItem('recentRootsList')).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(QUARANTINE_MESSAGE, expect.anything());
  });

  it('propagates a ledger read I/O failure rather than mistaking it for corruption', async () => {
    const registry = createRegistry();
    vi.mocked(storage.getItem).mockImplementation(async (key: string) => {
      if (key === 'recentRootsList') {
        throw new Error('storage offline');
      }
      return null;
    });

    await expect(registry.listRecentRoots()).rejects.toThrow('storage offline');
    expect(storage.setItem).not.toHaveBeenCalledWith('recentRootsList.corrupt', expect.anything());
    expect(loggerMock.error).not.toHaveBeenCalledWith(QUARANTINE_MESSAGE, expect.anything());
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
    // The deviation is ACCEPTED, not silent: the dropped ledger write is
    // reported so a user who loses Recents has something to point at.
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Failed to record a recently granted workspace folder',
      expect.anything()
    );
  });
});
