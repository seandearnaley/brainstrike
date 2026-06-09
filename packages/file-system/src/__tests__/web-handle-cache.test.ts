import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type StoredRootHandle, WebHandleCache } from '../adapters/web-handle-cache';

const createDirectoryHandle = (name: string) =>
  ({
    kind: 'directory',
    name,
    entries: vi.fn(),
    queryPermission: vi.fn().mockResolvedValue('granted'),
    requestPermission: vi.fn().mockResolvedValue('granted'),
  }) as unknown as FileSystemDirectoryHandle;

const createFileHandle = (name: string) =>
  ({
    kind: 'file',
    name,
    getFile: vi.fn(),
    queryPermission: vi.fn().mockResolvedValue('granted'),
    requestPermission: vi.fn().mockResolvedValue('granted'),
  }) as unknown as FileSystemFileHandle;

const getAllRoots = async (cache: WebHandleCache): Promise<StoredRootHandle[]> =>
  cache.getAllRootHandles();

const withIndexedDbUnavailable = async (runTest: () => Promise<void>): Promise<void> => {
  const originalIndexedDB = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: undefined,
  });

  try {
    await runTest();
  } finally {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: originalIndexedDB,
    });
  }
};

describe('WebHandleCache', () => {
  let mockedNow = new Date('2025-01-01T00:00:00.000Z').getTime();

  beforeEach(() => {
    mockedNow = new Date('2025-01-01T00:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockImplementation(() => mockedNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores and retrieves root handles', async () => {
    const cache = new WebHandleCache();
    const handle = createDirectoryHandle('root');

    await cache.storeRootHandle('root', handle);
    const restored = await cache.getRootHandle('root');

    expect(restored).toBe(handle);
  });

  it('updates lastAccessedAt when retrieving root handles', async () => {
    const cache = new WebHandleCache();
    const handle = createDirectoryHandle('root');

    await cache.storeRootHandle('root', handle);
    mockedNow = new Date('2025-01-02T00:00:00.000Z').getTime();
    await cache.getRootHandle('root');

    const stored = await getAllRoots(cache);
    expect(stored[0]?.lastAccessedAt).toBe(new Date('2025-01-02T00:00:00.000Z').getTime());
  });

  it('preserves storedAt when root handles are updated', async () => {
    await withIndexedDbUnavailable(async () => {
      const cache = new WebHandleCache();
      const firstHandle = createDirectoryHandle('root');
      const secondHandle = createDirectoryHandle('renamed-root');
      const storedAt = mockedNow;

      await cache.storeRootHandle('root', firstHandle);
      mockedNow = new Date('2025-01-03T00:00:00.000Z').getTime();
      await cache.storeRootHandle('root', secondHandle);

      const [record] = await cache.getAllRootHandles();
      expect(record).toMatchObject({
        folderId: 'root',
        handle: secondHandle,
        lastAccessedAt: mockedNow,
        name: 'renamed-root',
        storedAt,
      });
    });
  });

  it('returns null for missing root handles', async () => {
    const cache = new WebHandleCache();
    const result = await cache.getRootHandle('missing');
    expect(result).toBeNull();
  });

  it('removes root handles and associated file handles', async () => {
    const cache = new WebHandleCache();
    const rootHandle = createDirectoryHandle('root');
    const fileHandle = createFileHandle('file.txt');

    await cache.storeRootHandle('root', rootHandle);
    await cache.storeFileHandle('root', 'file.txt', fileHandle);
    await cache.removeRootHandle('root');

    const root = await cache.getRootHandle('root');
    const file = await cache.getFileHandle('root', 'file.txt');

    expect(root).toBeNull();
    expect(file).toBeNull();
  });

  it('restores most recently accessed root handle when permission granted', async () => {
    const cache = new WebHandleCache();
    const first = createDirectoryHandle('first');
    const second = createDirectoryHandle('second');

    await cache.storeRootHandle('first', first);
    mockedNow = new Date('2025-01-02T00:00:00.000Z').getTime();
    await cache.storeRootHandle('second', second);

    const restored = await cache.restoreLastRootHandle();

    expect(restored?.handle).toBe(second);
  });

  it('requests permission when prompt state returned', async () => {
    const cache = new WebHandleCache();
    const handle = createDirectoryHandle('root');
    const queryPermission = vi.fn().mockResolvedValue('prompt');
    const requestPermission = vi.fn().mockResolvedValue('granted');

    (handle as unknown as { queryPermission: typeof queryPermission }).queryPermission =
      queryPermission;
    (handle as unknown as { requestPermission: typeof requestPermission }).requestPermission =
      requestPermission;

    await cache.storeRootHandle('root', handle);
    const restored = await cache.restoreLastRootHandle();

    expect(restored?.handle).toBe(handle);
    expect(queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('returns null when permission denied', async () => {
    const cache = new WebHandleCache();
    const handle = createDirectoryHandle('root');
    const queryPermission = vi.fn().mockResolvedValue('denied');
    (handle as unknown as { queryPermission: typeof queryPermission }).queryPermission =
      queryPermission;

    await cache.storeRootHandle('root', handle);
    const restored = await cache.restoreLastRootHandle();

    expect(restored).toBeNull();
  });

  it('returns null when requested permission remains prompt', async () => {
    const cache = new WebHandleCache();
    const handle = createDirectoryHandle('root');
    const queryPermission = vi.fn().mockResolvedValue('prompt');
    const requestPermission = vi.fn().mockResolvedValue('prompt');
    (handle as unknown as { queryPermission: typeof queryPermission }).queryPermission =
      queryPermission;
    (handle as unknown as { requestPermission: typeof requestPermission }).requestPermission =
      requestPermission;

    await cache.storeRootHandle('root', handle);
    const restored = await cache.restoreLastRootHandle();

    expect(restored).toBeNull();
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('returns null when prompted handles cannot request permission', async () => {
    const cache = new WebHandleCache();
    const queryPermission = vi.fn().mockResolvedValue('prompt');
    const handle = {
      kind: 'directory',
      name: 'root',
      entries: vi.fn(),
      queryPermission,
    } as unknown as FileSystemDirectoryHandle;

    await cache.storeRootHandle('root', handle);
    const restored = await cache.restoreLastRootHandle();

    expect(restored).toBeNull();
    expect(queryPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('returns null when prompted permission requests throw', async () => {
    const cache = new WebHandleCache();
    const handle = createDirectoryHandle('root');
    const queryPermission = vi.fn().mockResolvedValue('prompt');
    const requestPermission = vi.fn().mockRejectedValue(new Error('permission dialog failed'));
    (handle as unknown as { queryPermission: typeof queryPermission }).queryPermission =
      queryPermission;
    (handle as unknown as { requestPermission: typeof requestPermission }).requestPermission =
      requestPermission;

    await cache.storeRootHandle('root', handle);
    const restored = await cache.restoreLastRootHandle();

    expect(restored).toBeNull();
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('returns null when a prompted permission request times out', async () => {
    await withIndexedDbUnavailable(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const cache = new WebHandleCache();
        const handle = createDirectoryHandle('root');
        const queryPermission = vi.fn().mockResolvedValue('prompt');
        const requestPermission = vi.fn<() => Promise<PermissionState>>(
          () => new Promise(() => {})
        );
        (handle as unknown as { queryPermission: typeof queryPermission }).queryPermission =
          queryPermission;
        (handle as unknown as { requestPermission: typeof requestPermission }).requestPermission =
          requestPermission;

        await cache.storeRootHandle('root', handle);
        const restorePromise = cache.restoreLastRootHandle();
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(restorePromise).resolves.toBeNull();
        expect(requestPermission).toHaveBeenCalledWith({ mode: 'read' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('restores handles without the optional permission API', async () => {
    const cache = new WebHandleCache();
    const handle = {
      kind: 'directory',
      name: 'legacy-root',
      entries: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;

    await cache.storeRootHandle('legacy-root', handle);
    const restored = await cache.restoreLastRootHandle();

    expect(restored?.handle).toBe(handle);
  });

  it('returns last restore candidate with permission state without requesting access', async () => {
    const cache = new WebHandleCache();
    const first = createDirectoryHandle('first');
    const second = createDirectoryHandle('second');

    await cache.storeRootHandle('first', first);
    mockedNow = new Date('2025-01-02T00:00:00.000Z').getTime();
    await cache.storeRootHandle('second', second);

    const candidate = await cache.getLastRootHandleForRestore();

    expect(candidate).toMatchObject({
      folderId: 'second',
      handle: second,
      name: 'second',
      permissionState: 'granted',
    });
    expect(second.requestPermission).not.toHaveBeenCalled();
  });

  it('uses unknown permission state when restore candidate permission query fails', async () => {
    const cache = new WebHandleCache();
    const handle = createDirectoryHandle('root');
    const queryPermission = vi.fn().mockRejectedValue(new Error('permission state unavailable'));
    (handle as unknown as { queryPermission: typeof queryPermission }).queryPermission =
      queryPermission;

    await cache.storeRootHandle('root', handle);
    const candidate = await cache.getLastRootHandleForRestore();

    expect(candidate?.permissionState).toBe('unknown');
    expect(candidate?.handle).toBe(handle);
  });

  it('removes stale handles that throw during permission check', async () => {
    const cache = new WebHandleCache();
    const handle = createDirectoryHandle('root');
    const queryPermission = vi.fn().mockRejectedValue(new Error('stale'));
    (handle as unknown as { queryPermission: typeof queryPermission }).queryPermission =
      queryPermission;

    await cache.storeRootHandle('root', handle);
    const restored = await cache.restoreLastRootHandle();

    expect(restored).toBeNull();
    const remaining = await cache.getAllRootHandles();
    expect(remaining).toHaveLength(0);
  });

  it('stores and retrieves file handles', async () => {
    const cache = new WebHandleCache();
    const fileHandle = createFileHandle('file.txt');

    await cache.storeFileHandle('root', 'file.txt', fileHandle);
    const restored = await cache.getFileHandle('root', 'file.txt');

    expect(restored).toBe(fileHandle);
  });

  it('preserves storedAt when file handles are updated', async () => {
    await withIndexedDbUnavailable(async () => {
      const cache = new WebHandleCache();
      const firstHandle = createFileHandle('file.txt');
      const secondHandle = createFileHandle('new-file.txt');
      const storedAt = mockedNow;

      await cache.storeFileHandle('root', 'file.txt', firstHandle);
      mockedNow = new Date('2025-01-03T00:00:00.000Z').getTime();
      await cache.storeFileHandle('root', 'file.txt', secondHandle);

      await expect(cache.getFileHandle('root', 'file.txt')).resolves.toBe(secondHandle);
      mockedNow = new Date('2025-02-01T00:00:00.000Z').getTime();
      await cache.pruneOldHandles(mockedNow - storedAt + 1);
      await expect(cache.getFileHandle('root', 'file.txt')).resolves.toBe(secondHandle);
    });
  });

  it('removes file handles independently of their root handle', async () => {
    const cache = new WebHandleCache();
    const rootHandle = createDirectoryHandle('root');
    const fileHandle = createFileHandle('file.txt');

    await cache.storeRootHandle('root', rootHandle);
    await cache.storeFileHandle('root', 'file.txt', fileHandle);
    await cache.removeFileHandle('root', 'file.txt');

    const root = await cache.getRootHandle('root');
    const file = await cache.getFileHandle('root', 'file.txt');

    expect(root).toBe(rootHandle);
    expect(file).toBeNull();
  });

  it('updates restore timestamps from memory and ignores missing handles', async () => {
    const folderId = 'restored-root';
    const cache = new WebHandleCache();
    const handle = createDirectoryHandle(folderId);

    await cache.storeRootHandle(folderId, handle);
    mockedNow = new Date('2025-01-02T00:00:00.000Z').getTime();
    await cache.markHandleRestored(folderId);
    await cache.markHandleRestored('missing-root');

    const records = await cache.getAllRootHandles();
    expect(records.find((record) => record.folderId === folderId)?.lastAccessedAt).toBe(
      new Date('2025-01-02T00:00:00.000Z').getTime()
    );
  });

  it('clears all handles', async () => {
    const cache = new WebHandleCache();
    const rootHandle = createDirectoryHandle('root');
    const fileHandle = createFileHandle('file.txt');

    await cache.storeRootHandle('root', rootHandle);
    await cache.storeFileHandle('root', 'file.txt', fileHandle);

    await cache.clear();

    const roots = await cache.getAllRootHandles();
    const file = await cache.getFileHandle('root', 'file.txt');

    expect(roots).toHaveLength(0);
    expect(file).toBeNull();
  });

  it('prunes old handles by maxAge', async () => {
    const cache = new WebHandleCache();
    const handle = createDirectoryHandle('root');

    await cache.storeRootHandle('root', handle);
    mockedNow = new Date('2025-02-15T00:00:00.000Z').getTime();

    await cache.pruneOldHandles(1000 * 60 * 60 * 24 * 7);

    const roots = await cache.getAllRootHandles();
    expect(roots).toHaveLength(0);
  });

  it('prunes old file handles by maxAge', async () => {
    await withIndexedDbUnavailable(async () => {
      const cache = new WebHandleCache();

      await cache.storeFileHandle('root', 'old.txt', createFileHandle('old.txt'));
      mockedNow = new Date('2025-01-15T00:00:00.000Z').getTime();
      await cache.storeFileHandle('root', 'fresh.txt', createFileHandle('fresh.txt'));
      mockedNow = new Date('2025-02-01T00:00:00.000Z').getTime();

      await cache.pruneOldHandles(1000 * 60 * 60 * 24 * 20);

      await expect(cache.getFileHandle('root', 'old.txt')).resolves.toBeNull();
      await expect(cache.getFileHandle('root', 'fresh.txt')).resolves.toMatchObject({
        name: 'fresh.txt',
      });
    });
  });

  describe('database recovery', () => {
    it('falls back to memory when IndexedDB is unavailable', async () => {
      await withIndexedDbUnavailable(async () => {
        const cache = new WebHandleCache();
        const handle = createDirectoryHandle('memory-only');

        await cache.storeRootHandle('memory-only', handle);
        const retrieved = await cache.getRootHandle('memory-only');

        expect(retrieved).toBe(handle);
      });
    });

    it('removes and clears handles in memory-only mode', async () => {
      await withIndexedDbUnavailable(async () => {
        const cache = new WebHandleCache();
        const rootHandle = createDirectoryHandle('memory-only-root');
        const firstFileHandle = createFileHandle('first.txt');
        const secondFileHandle = createFileHandle('second.txt');

        await cache.storeRootHandle('root', rootHandle);
        await cache.storeFileHandle('root', 'first.txt', firstFileHandle);
        await cache.removeFileHandle('root', 'first.txt');

        await expect(cache.getRootHandle('root')).resolves.toBe(rootHandle);
        await expect(cache.getFileHandle('root', 'first.txt')).resolves.toBeNull();

        await cache.storeFileHandle('root', 'second.txt', secondFileHandle);
        await cache.removeRootHandle('root');

        await expect(cache.getRootHandle('root')).resolves.toBeNull();
        await expect(cache.getFileHandle('root', 'second.txt')).resolves.toBeNull();

        await cache.storeRootHandle('root', rootHandle);
        await cache.storeFileHandle('root', 'second.txt', secondFileHandle);
        await cache.clear();

        await expect(cache.getAllRootHandles()).resolves.toEqual([]);
        await expect(cache.getFileHandle('root', 'second.txt')).resolves.toBeNull();
      });
    });

    it('uses the memory cache during IndexedDB open failure cooldown', async () => {
      const openSpy = vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(() => {
        throw new Error('IndexedDB open failed');
      });
      const cache = new WebHandleCache();
      const handle = createDirectoryHandle('cooldown-root');

      await cache.storeRootHandle('cooldown-root', handle);
      await expect(cache.getRootHandle('cooldown-root')).resolves.toBe(handle);
      expect(openSpy).toHaveBeenCalledTimes(1);

      mockedNow += 4000;
      await expect(cache.getAllRootHandles()).resolves.toMatchObject([
        {
          folderId: 'cooldown-root',
          handle,
        },
      ]);
      expect(openSpy).toHaveBeenCalledTimes(1);

      openSpy.mockRestore();
    });

    it('limits memory-only root handles to the most recent entries', async () => {
      await withIndexedDbUnavailable(async () => {
        const cache = new WebHandleCache();

        for (let index = 0; index < 12; index += 1) {
          await cache.storeRootHandle(`root-${index}`, createDirectoryHandle(`root-${index}`));
        }

        const roots = await cache.getAllRootHandles();
        const folderIds = roots.map((record) => record.folderId);

        expect(folderIds).toHaveLength(10);
        expect(folderIds).toEqual(Array.from({ length: 10 }, (_, index) => `root-${index + 2}`));
      });
    });

    it('limits memory-only file handles to the most recent entries', async () => {
      await withIndexedDbUnavailable(async () => {
        const cache = new WebHandleCache();

        for (let index = 0; index < 102; index += 1) {
          await cache.storeFileHandle(
            'root',
            `file-${index}.txt`,
            createFileHandle(`file-${index}.txt`)
          );
        }

        await expect(cache.getFileHandle('root', 'file-0.txt')).resolves.toBeNull();
        await expect(cache.getFileHandle('root', 'file-101.txt')).resolves.toMatchObject({
          name: 'file-101.txt',
        });
      });
    });

    it('removes invalid handles that fail validation', async () => {
      const cache = new WebHandleCache();

      // Create a handle that will fail validation
      const invalidHandle = {
        kind: 'directory',
        name: 'invalid',
        entries: vi.fn(),
        // queryPermission throws, simulating a stale/revoked handle
        queryPermission: vi.fn().mockRejectedValue(new Error('Permission revoked')),
        requestPermission: vi.fn().mockRejectedValue(new Error('Permission revoked')),
      } as unknown as FileSystemDirectoryHandle;

      await cache.storeRootHandle('invalid', invalidHandle);

      // Attempt to retrieve should return null and remove the invalid handle
      const retrieved = await cache.getRootHandle('invalid');
      expect(retrieved).toBeNull();

      // Handle should be removed from cache
      const allHandles = await cache.getAllRootHandles();
      expect(allHandles).toHaveLength(0);
    });

    it('handles concurrent store operations without errors', async () => {
      const cache = new WebHandleCache();

      // Store multiple handles concurrently
      const handles = Array.from({ length: 5 }, (_, i) => createDirectoryHandle(`concurrent-${i}`));

      // All operations should complete without throwing
      await Promise.all(
        handles.map((handle, i) => cache.storeRootHandle(`concurrent-${i}`, handle))
      );

      // Verify all handles can be retrieved
      const allHandles = await cache.getAllRootHandles();
      expect(allHandles.length).toBe(5);
    });
  });

  describe('type guards and validation', () => {
    it('rejects handles missing required methods', async () => {
      const cache = new WebHandleCache();

      // Create a handle missing the entries method
      const incompleteHandle = {
        kind: 'directory',
        name: 'incomplete',
        // No entries method
        queryPermission: vi.fn().mockResolvedValue('granted'),
      } as unknown as FileSystemDirectoryHandle;

      await cache.storeRootHandle('incomplete', incompleteHandle);

      // Should return null because handle fails type guard
      const retrieved = await cache.getRootHandle('incomplete');
      expect(retrieved).toBeNull();
    });

    it('rejects file handles missing getFile method', async () => {
      const cache = new WebHandleCache();

      // Create a file handle missing the getFile method
      const incompleteFileHandle = {
        kind: 'file',
        name: 'incomplete.txt',
        // No getFile method
      } as unknown as FileSystemFileHandle;

      await cache.storeFileHandle('root', 'incomplete.txt', incompleteFileHandle);

      // Should return null because handle fails type guard
      const retrieved = await cache.getFileHandle('root', 'incomplete.txt');
      expect(retrieved).toBeNull();
    });

    it('skips invalid restore candidates', async () => {
      const cache = new WebHandleCache();
      const invalidHandle = {
        kind: 'directory',
        name: 'incomplete',
      } as unknown as FileSystemDirectoryHandle;

      await cache.storeRootHandle('incomplete', invalidHandle);

      await expect(cache.restoreLastRootHandle()).resolves.toBeNull();
      await expect(cache.getLastRootHandleForRestore()).resolves.toBeNull();
    });
  });
});
