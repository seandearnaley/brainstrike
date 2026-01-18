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

describe('WebHandleCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
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
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));
    await cache.getRootHandle('root');

    const stored = await getAllRoots(cache);
    expect(stored[0]?.lastAccessedAt).toBe(new Date('2025-01-02T00:00:00.000Z').getTime());
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
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));
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
    vi.setSystemTime(new Date('2025-02-15T00:00:00.000Z'));

    await cache.pruneOldHandles(1000 * 60 * 60 * 24 * 7);

    const roots = await cache.getAllRootHandles();
    expect(roots).toHaveLength(0);
  });

  describe('database recovery', () => {
    it('falls back to memory when IndexedDB is unavailable', async () => {
      // Use real timers for this test since we need async operations to work properly
      vi.useRealTimers();

      // Save the original indexedDB
      const originalIndexedDB = globalThis.indexedDB;

      // Temporarily set indexedDB to undefined to simulate unavailability
      // @ts-expect-error - intentionally setting undefined for test
      globalThis.indexedDB = undefined;

      try {
        const cache = new WebHandleCache();
        const handle = createDirectoryHandle('memory-only');

        await cache.storeRootHandle('memory-only', handle);
        const retrieved = await cache.getRootHandle('memory-only');

        // Should still work using in-memory fallback
        expect(retrieved).toBe(handle);
      } finally {
        // Restore indexedDB
        globalThis.indexedDB = originalIndexedDB;
        // Restore fake timers for other tests
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
      }
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
  });
});
