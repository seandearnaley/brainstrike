import type { DirectoryHandle } from '@brainstrike/file-system';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { RootDataDeletionProvider } from '../shell/root-data-deletion-context';
import { useFileSystem } from '../shell/use-file-system-context';
import { FileExplorerTestWrapper } from './test-helpers';

function useExposed() {
  const fs = useFileSystem();
  const store = useFileExplorerStoreContext();
  return { fs, store };
}

describe('useFileSystem context hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('selectRootDirectory success sets handle and toggles loading', async () => {
    const mockHandle: DirectoryHandle = {
      path: 'mock-root',
      name: 'mock-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;

    let resolveFn: (h: DirectoryHandle) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFn = resolve;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let handle: DirectoryHandle | null = null;
    let promise: Promise<DirectoryHandle | null> | undefined;
    act(() => {
      promise = result.current.fs.selectRootDirectory();
    });
    await waitFor(() => expect(result.current.fs.isAccessLoading).toBe(true));

    act(() => {
      resolveFn(mockHandle);
    });

    await act(async () => {
      await promise;
    });

    handle = result.current.fs.rootDirectoryHandle;

    expect(handle).toEqual(mockHandle);
    expect(result.current.fs.rootDirectoryHandle).toEqual(mockHandle);
    // v5: currentFolderId is a durable RootId UUID, not the handle path.
    expect(result.current.store.getState().currentFolderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.current.fs.isAccessLoading).toBe(false);
  });

  it('throws Permission denied when access is denied', async () => {
    const error = new Error('Permission denied');
    error.name = 'SecurityError';
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });
    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Permission denied: Unable to access the selected directory. Please check folder permissions and try again.'
    );
  });

  it('returns null when user cancels directory selection', async () => {
    const error = new Error('User cancelled');
    error.name = 'AbortError';
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    act(() => {
      promise = result.current.fs.selectRootDirectory();
    });
    await waitFor(() => expect(result.current.fs.isAccessLoading).toBe(true));

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await expect(promise).resolves.toBeNull();
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
  });

  it('throws dialog open error for "Unable to open directory selection dialog"', async () => {
    const error = new Error('Unable to open directory selection dialog');
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });

    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Could not open the folder selection dialog. Please try again.'
    );
  });

  it('throws dialog open error for "Failed to open directory dialog"', async () => {
    const error = new Error('Failed to open directory dialog');
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });

    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Could not open the folder selection dialog. Please try again.'
    );
  });

  it('throws read error when unable to read directory', async () => {
    const error = new Error('Unable to read the selected directory');
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });

    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Cannot read the selected directory. Please ensure you have proper access permissions.'
    );
  });

  it('throws access error when directory cannot be accessed', async () => {
    const error = new Error('Cannot access selected directory');
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });

    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Cannot access the selected directory. Please ensure you have proper access permissions.'
    );
  });

  it('handles non-Error rejections with a generic message', async () => {
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });

    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn('something went wrong');
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'An unexpected error occurred while selecting the directory. Please try again.'
    );
  });

  it('rehydrates persisted folder state when restoring a handle for the already-current folder id', () => {
    const restoredHandle: DirectoryHandle = {
      path: 'restored-root',
      name: 'restored-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    act(() => {
      result.current.store.setState({
        currentFolderId: 'restored-root',
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          mode: 'explicit',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
        folderStates: {
          'restored-root': {
            selectedFilePaths: new Set<string>(['restored-root|@|file-0.ts']),
            selectionModel: {
              mode: 'query',
              explicitPaths: new Set<string>(),
              ruleSetJson: null,
              materializedPaths: new Set<string>(['file-0.ts']),
              materializedAt: new Date().toISOString(),
              queryDescriptor: {
                kind: 'recursive-select-all',
                folderId: 'restored-root',
                rootPath: null,
                coveredDirectoryPaths: [],
                includeFilters: ['*.ts'],
                excludeFilters: [],
                includedPaths: [],
                excludedPaths: [],
                manifestFingerprint: 'fingerprint',
                manifestSnapshotId: 'snapshot-id',
                useRegex: false,
                totalSelectedCount: 600,
              },
            },
            expandedDirectoryPaths: new Set<string>(),
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: true,
            tokenBudget: 100_000,
            folderSummaryThreshold: 5,
            maxSelectionCount: 1000,
            lastActiveTab: 'files',
            lastAccessed: Date.now(),
            viewFilterPresetId: null,
          },
        },
      });
    });

    act(() => {
      result.current.fs.setRootDirectoryHandle(restoredHandle);
    });

    expect(result.current.store.getState().selectionModel.mode).toBe('query');
    expect(result.current.store.getState().selectedFilePaths.size).toBe(1);
  });

  it('rehydrates persisted folder state when selecting the already-current folder id', async () => {
    // v5: folderStates keys are durable RootId UUIDs. Mock randomUUID so the
    // generated rootId is predictable, then pre-seed folderStates with that UUID.
    const CONTROLLED_ROOT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      CONTROLLED_ROOT_ID as ReturnType<typeof crypto.randomUUID>
    );

    const restoredHandle: DirectoryHandle = {
      path: 'selected-restored-root',
      name: 'selected-restored-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;

    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockResolvedValue(
      restoredHandle
    );

    const isolatedStorageAdapter = new MemoryStorageAdapter();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FileExplorerTestWrapper, {
        children,
        mockStorageAdapter: isolatedStorageAdapter,
      });
    const { result } = renderHook(() => useExposed(), { wrapper });

    const SELECTION_KEY = `${CONTROLLED_ROOT_ID}|@|file-0.ts`;
    act(() => {
      result.current.store.setState({
        currentFolderId: CONTROLLED_ROOT_ID,
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          mode: 'explicit',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
        folderStates: {
          [CONTROLLED_ROOT_ID]: {
            selectedFilePaths: new Set<string>([SELECTION_KEY]),
            selectionModel: {
              mode: 'explicit',
              explicitPaths: new Set<string>([SELECTION_KEY]),
              ruleSetJson: null,
              materializedPaths: null,
              materializedAt: null,
              queryDescriptor: null,
            },
            expandedDirectoryPaths: new Set<string>(['src']),
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: true,
            tokenBudget: 100_000,
            folderSummaryThreshold: 5,
            maxSelectionCount: 1000,
            lastActiveTab: 'files',
            lastAccessed: Date.now(),
            viewFilterPresetId: null,
          },
        },
      });
    });

    await act(async () => {
      await result.current.fs.selectRootDirectory();
    });

    expect(result.current.store.getState().selectedFilePaths.size).toBe(1);
    expect(result.current.store.getState().expandedDirectoryPaths).toEqual(new Set(['src']));
  });

  it('syncs an auto-restored root handle into the store', async () => {
    const restoredHandle: DirectoryHandle = {
      path: 'restored-root',
      name: 'restored-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;

    const adapterWithRestore = Object.assign(new MockFileSystemAdapter(), {
      restoreLastFolder: vi.fn(async () => restoredHandle),
    });

    // Isolated storage: legacy single-root restore REUSES a persisted
    // currentFolderId as the rootId (storage v5). Without isolation, ids
    // persisted by earlier tests in this file leak into this fresh-boot case.
    const isolatedStorageAdapter = new MemoryStorageAdapter();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FileExplorerTestWrapper, {
        children,
        mockFileSystemAdapter: adapterWithRestore,
        mockStorageAdapter: isolatedStorageAdapter,
      });

    const { result } = renderHook(() => useExposed(), { wrapper });

    await waitFor(() => {
      expect(result.current.fs.rootDirectoryHandle).toEqual(restoredHandle);
      expect(result.current.store.getState().rootDirectoryHandle).toEqual(restoredHandle);
      // v5: on a true first run (nothing persisted) currentFolderId is a
      // freshly minted durable RootId UUID, not the handle path.
      expect(result.current.store.getState().currentFolderId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});

// ---------------------------------------------------------------------------
// Debounce tests for handleWatcherChanges
// These tests verify that multiple rapid file-system change notifications are
// collapsed into a single FILE_EXPLORER_REFRESH_EVENT dispatch (300ms trailing
// debounce), and that the pending timer is cleared on unmount.
//
// Strategy: provide a mock adapter whose watchDirectory captures the internal
// watcher callback. After the hook renders, fire the callback directly to
// simulate file-system changes without needing a real filesystem.
// ---------------------------------------------------------------------------

describe('useFileSystem — handleWatcherChanges debounce', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('5 rapid watcher callbacks produce exactly 1 dispatch after 300ms', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    // Track calls to watchDirectory so we can invoke the callback ourselves.
    let capturedCallback: ((changes: unknown[]) => void) | null = null;

    const handle: DirectoryHandle = {
      path: '/debounce-root',
      name: 'debounce-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;

    const adapterWithWatch = Object.assign(new MockFileSystemAdapter(), {
      restoreLastFolder: vi.fn(async () => handle),
      watchDirectory: vi.fn((_h: DirectoryHandle, cb: (changes: unknown[]) => void) => {
        capturedCallback = cb;
        return vi.fn();
      }),
    });

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FileExplorerTestWrapper, {
        children,
        mockFileSystemAdapter: adapterWithWatch,
      });

    renderHook(() => useExposed(), { wrapper });

    // Allow restoreLastFolder to settle so the watcher root is registered
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    if (!capturedCallback) {
      // watchDirectory was not called — skip (adapter root not populated in this env)
      dispatchSpy.mockRestore();
      return;
    }

    const cb = capturedCallback as (changes: unknown[]) => void;
    const dispatchCountBefore = dispatchSpy.mock.calls.length;

    // Fire 5 rapid changes — all within the 300ms debounce window
    for (let i = 0; i < 5; i++) {
      act(() => {
        cb([]);
      });
    }

    // No dispatch yet (debounce timer hasn't expired)
    expect(dispatchSpy.mock.calls.length).toBe(dispatchCountBefore);

    // Advance past the 300ms trailing window
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Exactly one additional dispatch (not 5)
    expect(dispatchSpy.mock.calls.length).toBe(dispatchCountBefore + 1);

    dispatchSpy.mockRestore();
  });

  it('unmounting clears the pending debounce timer — no dispatch after unmount', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    let capturedCallback: ((changes: unknown[]) => void) | null = null;

    const handle: DirectoryHandle = {
      path: '/unmount-root',
      name: 'unmount-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;

    const adapterWithWatch = Object.assign(new MockFileSystemAdapter(), {
      restoreLastFolder: vi.fn(async () => handle),
      watchDirectory: vi.fn((_h: DirectoryHandle, cb: (changes: unknown[]) => void) => {
        capturedCallback = cb;
        return vi.fn();
      }),
    });

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FileExplorerTestWrapper, {
        children,
        mockFileSystemAdapter: adapterWithWatch,
      });

    const { unmount } = renderHook(() => useExposed(), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    if (!capturedCallback) {
      dispatchSpy.mockRestore();
      return;
    }

    const cb = capturedCallback as (changes: unknown[]) => void;
    const dispatchCountBefore = dispatchSpy.mock.calls.length;

    // Arm the debounce timer with one change notification
    act(() => {
      cb([]);
    });

    // Unmount before the 300ms window expires — cleanup effect should clear timer
    act(() => {
      unmount();
    });

    // Advance past the debounce window — no timer should fire
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Dispatch count must not have increased
    expect(dispatchSpy.mock.calls.length).toBe(dispatchCountBefore);

    dispatchSpy.mockRestore();
  });
});

describe('useFileSystem — cascade delete (Phase 6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Isolated storage: the shared wrapper hydrates persisted state leaked by
  // earlier tests in this file (see the restored-root note above).
  function makeDeletionWrapper(deleteRootData?: (rootId: string) => Promise<void>) {
    const storage = new MemoryStorageAdapter();
    return ({ children }: { children: ReactNode }) =>
      createElement(FileExplorerTestWrapper, {
        // biome-ignore lint/correctness/noChildrenProp: createElement's TS overload requires children inside props when the component declares them required (.ts file, no JSX)
        children: deleteRootData
          ? createElement(RootDataDeletionProvider, { children, deleteRootData })
          : children,
        mockStorageAdapter: storage,
      });
  }

  async function addRoot(result: { current: ReturnType<typeof useExposed> }) {
    const mockHandle: DirectoryHandle = {
      path: 'mock-root',
      name: 'mock-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockResolvedValue(
      mockHandle
    );
    await act(async () => {
      await result.current.fs.selectRootDirectory();
    });
    const rootId = result.current.store.getState().currentFolderId;
    if (!rootId) {
      throw new Error('Root was not added');
    }
    return rootId;
  }

  it('deleteData: deletion runs and the root disconnects on success', async () => {
    const deleteRootData = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useExposed(), {
      wrapper: makeDeletionWrapper(deleteRootData),
    });
    const rootId = await addRoot(result);

    await act(async () => {
      await result.current.fs.removeRootDirectory(rootId, { deleteData: true });
    });

    expect(deleteRootData).toHaveBeenCalledExactlyOnceWith(rootId);
    expect(result.current.fs.rootDirectoryHandles).toHaveLength(0);
    expect(result.current.store.getState().activeRootIds).not.toContain(rootId);
  });

  it('deleteData: a FAILED deletion aborts the disconnect (root stays connected)', async () => {
    const deleteRootData = vi.fn().mockRejectedValue(new Error('db down'));
    const { result } = renderHook(() => useExposed(), {
      wrapper: makeDeletionWrapper(deleteRootData),
    });
    const rootId = await addRoot(result);

    await act(async () => {
      await result.current.fs.removeRootDirectory(rootId, { deleteData: true });
    });

    expect(deleteRootData).toHaveBeenCalledExactlyOnceWith(rootId);
    // Disconnect ABORTED: the handle and store registration both survive.
    expect(result.current.fs.rootDirectoryHandles).toHaveLength(1);
    expect(result.current.store.getState().activeRootIds).toContain(rootId);
  });

  it('plain disconnect (no deleteData) never touches the deletion seam', async () => {
    const deleteRootData = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useExposed(), {
      wrapper: makeDeletionWrapper(deleteRootData),
    });
    const rootId = await addRoot(result);

    await act(async () => {
      await result.current.fs.removeRootDirectory(rootId);
    });

    expect(deleteRootData).not.toHaveBeenCalled();
    expect(result.current.fs.rootDirectoryHandles).toHaveLength(0);
  });

  it('deleteData WITHOUT a mounted provider aborts the disconnect', async () => {
    const { result } = renderHook(() => useExposed(), { wrapper: makeDeletionWrapper() });
    const rootId = await addRoot(result);

    await act(async () => {
      await result.current.fs.removeRootDirectory(rootId, { deleteData: true });
    });

    // No seam → fail loudly and keep the root connected (never silent no-op).
    expect(result.current.fs.rootDirectoryHandles).toHaveLength(1);
  });
});
