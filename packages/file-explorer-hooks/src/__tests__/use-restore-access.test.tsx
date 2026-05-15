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
});
