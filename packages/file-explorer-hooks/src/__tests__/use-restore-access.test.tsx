import type { FileSystemAdapter } from '@brainstrike/file-system';
import { createStorageAdapter } from '@brainstrike/storage';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdaptersProvider } from '../adapters-context';
import { useRestoreAccess } from '../use-restore-access';

const createWrapper = (adapter: FileSystemAdapter) => {
  const storageAdapter = createStorageAdapter('web');
  return ({ children }: { children: ReactNode }) => (
    <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storageAdapter}>
      {children}
    </AdaptersProvider>
  );
};

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

function createAdapterWithCache(handleCache: unknown): FileSystemAdapter {
  return {
    requestDirectoryAccess: vi.fn(),
    readDirectory: vi.fn(),
    readFile: vi.fn(),
    exists: vi.fn(),
    getHandleCache: () => handleCache,
  } as unknown as FileSystemAdapter;
}

describe('useRestoreAccess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes pending restore from stored handles (new API)', async () => {
    const mockRawHandle = {
      name: 'New Folder',
      kind: 'directory',
      queryPermission: vi.fn().mockResolvedValue('prompt'),
    } as unknown as FileSystemDirectoryHandle;

    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        { folderId: 'old', name: 'Old Folder', lastAccessedAt: 1 },
        { folderId: 'new', name: 'New Folder', lastAccessedAt: 2 },
      ]),
      getLastRootHandleForRestore: vi.fn().mockResolvedValue({
        handle: mockRawHandle,
        folderId: 'new',
        name: 'New Folder',
        permissionState: 'prompt',
      }),
      markHandleRestored: vi.fn().mockResolvedValue(undefined),
      restoreLastRootHandle: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
      getHandleCache: () => handleCache,
    } as unknown as FileSystemAdapter;

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(adapter),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.pendingRestore).toEqual({
      folderId: 'new',
      name: 'New Folder',
      rawHandle: mockRawHandle,
      permissionState: 'prompt',
    });
    expect(result.current.storedFolders).toHaveLength(2);
  });

  it('exposes pending restore from stored handles (legacy API)', async () => {
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        { folderId: 'old', name: 'Old Folder', lastAccessedAt: 1 },
        { folderId: 'new', name: 'New Folder', lastAccessedAt: 2 },
      ]),
      // No getLastRootHandleForRestore - tests legacy path
      restoreLastRootHandle: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
      getHandleCache: () => handleCache,
    } as unknown as FileSystemAdapter;

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(adapter),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Legacy path doesn't set pendingRestore since there's no raw handle
    expect(result.current.pendingRestore).toBeNull();
    expect(result.current.storedFolders).toHaveLength(2);
  });

  it('marks denial when restore returns null and handles remain', async () => {
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        {
          folderId: 'root',
          name: 'Root',
          lastAccessedAt: 1,
        },
      ]),
      restoreLastRootHandle: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
      getHandleCache: () => handleCache,
    } as unknown as FileSystemAdapter;

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(adapter),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      await result.current.beginRestore();
    });

    expect(result.current.showDeniedBanner).toBe(true);
  });

  it('restores a pending handle when stored permission is already granted', async () => {
    const mockRawHandle = {
      name: 'Root',
      kind: 'directory',
      requestPermission: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        {
          folderId: 'root',
          name: 'Root',
          lastAccessedAt: 1,
        },
      ]),
      getLastRootHandleForRestore: vi.fn().mockResolvedValue({
        folderId: 'root',
        handle: mockRawHandle,
        name: 'Root',
        permissionState: 'granted',
      }),
      markHandleRestored: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(createAdapterWithCache(handleCache)),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    let restored: Awaited<ReturnType<typeof result.current.beginRestore>> = null;
    await act(async () => {
      restored = await result.current.beginRestore();
    });

    expect(restored).toMatchObject({
      path: 'Root',
      name: 'Root',
      kind: 'directory',
      platform: 'web',
      _internal: mockRawHandle,
    });
    // Under RootId keying, the stored folderId ('root') is the authoritative
    // identity — not the handle name ('Root'). No name-based re-keying occurs.
    expect(handleCache.markHandleRestored).toHaveBeenCalledWith('root');
    expect(mockRawHandle.requestPermission).not.toHaveBeenCalled();
    expect(result.current.pendingRestore).toBeNull();
  });

  it('uses stored folderId as the authoritative identity even when it differs from handle name', async () => {
    // Under RootId keying (v2) the stored folderId is a UUID — it will never
    // equal rawHandle.name. The old name-equality cleanup is removed because it
    // would otherwise delete every stored root. The stored key is now canonical.
    const mockRawHandle = {
      name: 'Actual Root',
      kind: 'directory',
    } as unknown as FileSystemDirectoryHandle;
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([]),
      getLastRootHandleForRestore: vi.fn().mockResolvedValue({
        folderId: 'uuid-root-id',
        handle: mockRawHandle,
        name: 'Actual Root',
        permissionState: 'granted',
      }),
      markHandleRestored: vi.fn().mockResolvedValue(undefined),
      removeRootHandle: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(createAdapterWithCache(handleCache)),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      await result.current.beginRestore();
    });

    // Stored folderId is used as-is — no name-based re-keying or deletion.
    expect(handleCache.removeRootHandle).not.toHaveBeenCalled();
    expect(handleCache.markHandleRestored).toHaveBeenCalledWith('uuid-root-id');
  });

  it('requests permission for prompt handles and marks denied or stale states', async () => {
    const mockRawHandle = {
      name: 'Prompt Root',
      kind: 'directory',
      requestPermission: vi.fn().mockResolvedValueOnce('denied').mockResolvedValueOnce('prompt'),
    } as unknown as FileSystemDirectoryHandle;
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([]),
      getLastRootHandleForRestore: vi.fn().mockResolvedValue({
        folderId: 'Prompt Root',
        handle: mockRawHandle,
        name: 'Prompt Root',
        permissionState: 'prompt',
      }),
      markHandleRestored: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(createAdapterWithCache(handleCache)),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      await result.current.beginRestore();
    });

    expect(result.current.showDeniedBanner).toBe(true);
    expect(result.current.showStaleBanner).toBe(false);
    expect(mockRawHandle.requestPermission).toHaveBeenCalledWith({ mode: 'read' });

    await act(async () => {
      await result.current.beginRestore();
    });

    expect(result.current.showDeniedBanner).toBe(false);
    expect(result.current.showStaleBanner).toBe(true);
  });

  it('removes not-found pending handles and treats them as stale', async () => {
    const notFoundError = new Error('missing folder');
    notFoundError.name = 'NotFoundError';
    const mockRawHandle = {
      name: 'Missing Root',
      kind: 'directory',
      requestPermission: vi.fn().mockRejectedValue(notFoundError),
    } as unknown as FileSystemDirectoryHandle;
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([]),
      getLastRootHandleForRestore: vi.fn().mockResolvedValue({
        folderId: 'Missing Root',
        handle: mockRawHandle,
        name: 'Missing Root',
        permissionState: 'unknown',
      }),
      removeRootHandle: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(createAdapterWithCache(handleCache)),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      await result.current.beginRestore();
    });

    expect(handleCache.removeRootHandle).toHaveBeenCalledWith('Missing Root');
    expect(result.current.pendingRestore).toBeNull();
    expect(result.current.showStaleBanner).toBe(true);
  });

  it('does not show banners when the user cancels a permission dialog', async () => {
    const abortError = new Error('cancelled');
    abortError.name = 'AbortError';
    const mockRawHandle = {
      name: 'Root',
      kind: 'directory',
      requestPermission: vi.fn().mockRejectedValue(abortError),
    } as unknown as FileSystemDirectoryHandle;
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([]),
      getLastRootHandleForRestore: vi.fn().mockResolvedValue({
        folderId: 'Root',
        handle: mockRawHandle,
        name: 'Root',
        permissionState: 'unknown',
      }),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(createAdapterWithCache(handleCache)),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      await result.current.beginRestore();
    });

    expect(result.current.showDeniedBanner).toBe(false);
    expect(result.current.showStaleBanner).toBe(false);
    expect(result.current.pendingRestore?.folderId).toBe('Root');
  });

  it('marks stale when restore returns null and no handles remain', async () => {
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([]),
      restoreLastRootHandle: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
      getHandleCache: () => handleCache,
    } as unknown as FileSystemAdapter;

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(adapter),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      await result.current.beginRestore();
    });

    expect(result.current.showStaleBanner).toBe(true);
  });

  it('uses legacy restore results and refreshes stored folders', async () => {
    const restoredHandle = {
      name: 'Restored Root',
      kind: 'directory',
    } as unknown as FileSystemDirectoryHandle;
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        {
          folderId: 'restored',
          name: 'Restored Root',
          lastAccessedAt: 2,
        },
      ]),
      restoreLastRootHandle: vi.fn().mockResolvedValue({ handle: restoredHandle }),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(createAdapterWithCache(handleCache)),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    let restored: Awaited<ReturnType<typeof result.current.beginRestore>> = null;
    await act(async () => {
      restored = await result.current.beginRestore();
    });

    expect(restored).toMatchObject({
      path: 'Restored Root',
      name: 'Restored Root',
      kind: 'directory',
      platform: 'web',
      _internal: restoredHandle,
    });
    expect(result.current.storedFolders).toEqual([{ folderId: 'restored', name: 'Restored Root' }]);
  });

  it('dismisses restore state and opens a different folder through the adapter', async () => {
    const selectedDirectory = {
      path: 'Selected',
      name: 'Selected',
      kind: 'directory',
      platform: 'web',
    } as const;
    const requestDirectoryAccess = vi.fn().mockResolvedValue(selectedDirectory);
    const mockRawHandle = {
      name: 'Root',
      kind: 'directory',
      requestPermission: vi.fn().mockResolvedValue('denied'),
    } as unknown as FileSystemDirectoryHandle;
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([]),
      getLastRootHandleForRestore: vi.fn().mockResolvedValue({
        folderId: 'Root',
        handle: mockRawHandle,
        name: 'Root',
        permissionState: 'denied',
      }),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = {
      requestDirectoryAccess,
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
      getHandleCache: () => handleCache,
    } as unknown as FileSystemAdapter;

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(adapter),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    await act(async () => {
      await result.current.beginRestore();
    });

    expect(result.current.showDeniedBanner).toBe(true);

    act(() => {
      result.current.dismissRestore();
    });

    expect(result.current.pendingRestore).toBeNull();
    expect(result.current.showDeniedBanner).toBe(false);

    let selected: Awaited<ReturnType<typeof result.current.chooseDifferentFolder>> = null;
    await act(async () => {
      selected = await result.current.chooseDifferentFolder();
    });

    expect(selected).toBe(selectedDirectory);
    expect(requestDirectoryAccess).toHaveBeenCalledOnce();
  });

  it('clears stored handles via clearStoredHandles', async () => {
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        {
          folderId: 'root',
          name: 'Root',
          lastAccessedAt: 1,
        },
      ]),
      restoreLastRootHandle: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
      getHandleCache: () => handleCache,
    } as unknown as FileSystemAdapter;

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(adapter),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      await result.current.clearStoredHandles();
    });

    expect(handleCache.clear).toHaveBeenCalledOnce();
    expect(result.current.storedFolders).toEqual([]);
  });

  it('does not repopulate restore state when handles resolve after a clear', async () => {
    const mockRawHandle = {
      name: 'Root',
      kind: 'directory',
      queryPermission: vi.fn().mockResolvedValue('prompt'),
    } as unknown as FileSystemDirectoryHandle;
    const pendingLookup = createDeferred<{
      folderId: string;
      handle: FileSystemDirectoryHandle;
      name: string;
      permissionState: PermissionState | 'unknown';
    } | null>();
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        {
          folderId: 'root',
          name: 'Root',
          lastAccessedAt: 1,
        },
      ]),
      getLastRootHandleForRestore: vi.fn(() => pendingLookup.promise),
      markHandleRestored: vi.fn().mockResolvedValue(undefined),
      restoreLastRootHandle: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const { result } = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(createAdapterWithCache(handleCache)),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(handleCache.getLastRootHandleForRestore).toHaveBeenCalledOnce();

    await act(async () => {
      await result.current.clearStoredHandles();
    });

    await act(async () => {
      pendingLookup.resolve({
        folderId: 'root',
        handle: mockRawHandle,
        name: 'Root',
        permissionState: 'prompt',
      });
      await pendingLookup.promise;
      await vi.runAllTimersAsync();
    });

    expect(result.current.pendingRestore).toBeNull();
    expect(result.current.storedFolders).toEqual([]);
    expect(handleCache.getAllRootHandles).not.toHaveBeenCalled();
  });

  it('syncs cleared stored handles across hook instances', async () => {
    const mockRawHandle = {
      name: 'Root',
      kind: 'directory',
      queryPermission: vi.fn().mockResolvedValue('prompt'),
    } as unknown as FileSystemDirectoryHandle;

    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        {
          folderId: 'root',
          name: 'Root',
          lastAccessedAt: 1,
        },
      ]),
      getLastRootHandleForRestore: vi.fn().mockResolvedValue({
        folderId: 'root',
        handle: mockRawHandle,
        name: 'Root',
        permissionState: 'prompt',
      }),
      markHandleRestored: vi.fn().mockResolvedValue(undefined),
      restoreLastRootHandle: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
      getHandleCache: () => handleCache,
    } as unknown as FileSystemAdapter;

    const first = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(adapter),
    });
    const second = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(adapter),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(first.result.current.storedFolders).toEqual([{ folderId: 'root', name: 'Root' }]);
    expect(second.result.current.storedFolders).toEqual([{ folderId: 'root', name: 'Root' }]);
    expect(second.result.current.pendingRestore?.folderId).toBe('root');

    await act(async () => {
      await first.result.current.clearStoredHandles();
    });

    expect(handleCache.clear).toHaveBeenCalledOnce();
    expect(first.result.current.storedFolders).toEqual([]);
    expect(second.result.current.storedFolders).toEqual([]);
    expect(second.result.current.pendingRestore).toBeNull();

    first.unmount();
    second.unmount();
  });

  it('does not broadcast a clear to hooks backed by a different handle cache', async () => {
    const firstHandle = {
      name: 'First Root',
      kind: 'directory',
      queryPermission: vi.fn().mockResolvedValue('prompt'),
    } as unknown as FileSystemDirectoryHandle;
    const secondHandle = {
      name: 'Second Root',
      kind: 'directory',
      queryPermission: vi.fn().mockResolvedValue('prompt'),
    } as unknown as FileSystemDirectoryHandle;
    const firstCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        {
          folderId: 'first-root',
          name: 'First Root',
          lastAccessedAt: 1,
        },
      ]),
      getLastRootHandleForRestore: vi.fn().mockResolvedValue({
        folderId: 'first-root',
        handle: firstHandle,
        name: 'First Root',
        permissionState: 'prompt',
      }),
      markHandleRestored: vi.fn().mockResolvedValue(undefined),
      restoreLastRootHandle: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const secondCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        {
          folderId: 'second-root',
          name: 'Second Root',
          lastAccessedAt: 1,
        },
      ]),
      getLastRootHandleForRestore: vi.fn().mockResolvedValue({
        folderId: 'second-root',
        handle: secondHandle,
        name: 'Second Root',
        permissionState: 'prompt',
      }),
      markHandleRestored: vi.fn().mockResolvedValue(undefined),
      restoreLastRootHandle: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const first = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(createAdapterWithCache(firstCache)),
    });
    const second = renderHook(() => useRestoreAccess(), {
      wrapper: createWrapper(createAdapterWithCache(secondCache)),
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(first.result.current.storedFolders).toEqual([
      { folderId: 'first-root', name: 'First Root' },
    ]);
    expect(second.result.current.storedFolders).toEqual([
      { folderId: 'second-root', name: 'Second Root' },
    ]);

    await act(async () => {
      await first.result.current.clearStoredHandles();
    });

    expect(firstCache.clear).toHaveBeenCalledOnce();
    expect(secondCache.clear).not.toHaveBeenCalled();
    expect(first.result.current.storedFolders).toEqual([]);
    expect(first.result.current.pendingRestore).toBeNull();
    expect(second.result.current.storedFolders).toEqual([
      { folderId: 'second-root', name: 'Second Root' },
    ]);
    expect(second.result.current.pendingRestore?.folderId).toBe('second-root');

    first.unmount();
    second.unmount();
  });
});
