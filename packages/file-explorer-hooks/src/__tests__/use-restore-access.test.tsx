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

  it('exposes pending restore from stored handles', async () => {
    const handleCache = {
      getAllRootHandles: vi.fn().mockResolvedValue([
        {
          folderId: 'old',
          name: 'Old Folder',
          lastAccessedAt: 1,
        },
        {
          folderId: 'new',
          name: 'New Folder',
          lastAccessedAt: 2,
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

    expect(result.current.pendingRestore).toEqual({ folderId: 'new', name: 'New Folder' });
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
});
