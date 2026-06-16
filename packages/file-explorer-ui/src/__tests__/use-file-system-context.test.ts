import type { DirectoryHandle } from '@brainstrike/file-system';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { FileSystemChange } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INJECT_ROOT_HANDLE_EVENT } from '../inject-root-handle-event';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import {
  createFileExplorerRefreshEvent,
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEventDetail,
} from '../shell/file-explorer-refresh-event';
import { RootDataDeletionProvider } from '../shell/root-data-deletion-context';
import { useFileSystemInstance as useFileSystem } from '../shell/use-file-system-context';
import { FileExplorerTestWrapper } from './test-helpers';

function useExposed() {
  const fs = useFileSystem();
  const store = useFileExplorerStoreContext();
  return { fs, store };
}

function captureFileExplorerRefreshEvents() {
  const events: CustomEvent<FileExplorerRefreshEventDetail>[] = [];
  const listener = vi.fn((event: Event): void => {
    events.push(event as CustomEvent<FileExplorerRefreshEventDetail>);
  });
  window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, listener);
  return {
    events,
    listener,
    cleanup: () => window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, listener),
  };
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

    // The reducer is the sole handle owner; the focused handle is stamped with a
    // durable RootId (storage v5), so it is a superset of the raw mock handle.
    expect(handle).toMatchObject(mockHandle);
    expect(handle?.rootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.current.fs.rootDirectoryHandle).toMatchObject(mockHandle);
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
      // Identity is rootId-only: the restored handle's rootId IS the already-current
      // folder id, so restoring it rehydrates the persisted folder state.
      rootId: 'restored-root',
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
        // Expansion is WORKSPACE-GLOBAL: persistence keeps it in the
        // top-level set (folder snapshots are no longer hydrated).
        expandedDirectoryPaths: new Set<string>(['src']),
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

  it('surfaces an auto-restored root handle (reducer is the sole owner)', async () => {
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
      // The restored handle is stamped with a durable RootId (storage v5), so
      // it's a superset of the input handle — match the known fields.
      expect(result.current.fs.rootDirectoryHandle).toMatchObject(restoredHandle);
      // v5: on a true first run (nothing persisted) currentFolderId is a
      // freshly minted durable RootId UUID, not the handle path.
      expect(result.current.store.getState().currentFolderId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('injects a root handle from the brainstrike:inject-root-handle event (fixture bridge)', async () => {
    const injectedHandle: DirectoryHandle = {
      path: 'fixture-root',
      name: 'fixture-root',
      kind: 'directory',
      platform: 'web',
      // The inline fixture stamps a durable rootId at its source (buildFixtureState),
      // so the injected handle carries one — identity is rootId-only.
      rootId: 'fixture-root-id',
    } as DirectoryHandle;

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(INJECT_ROOT_HANDLE_EVENT, { detail: { handle: injectedHandle } })
      );
    });
    await waitFor(() => {
      expect(result.current.fs.rootDirectoryHandle).toMatchObject(injectedHandle);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(INJECT_ROOT_HANDLE_EVENT, { detail: { handle: null } }));
    });
    await waitFor(() => {
      expect(result.current.fs.rootDirectoryHandle).toBeNull();
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

  it('debounces watcher changes into one typed incremental refresh event', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' as ReturnType<typeof crypto.randomUUID>
    );
    const refreshCapture = captureFileExplorerRefreshEvents();

    try {
      // Track calls to watchDirectory so we can invoke the callback ourselves.
      let capturedCallback: ((changes: FileSystemChange[]) => void) | null = null;

      const handle: DirectoryHandle = {
        path: '/debounce-root',
        name: 'debounce-root',
        kind: 'directory',
        platform: 'web',
        rootId: 'debounce-root-id',
      } as DirectoryHandle;

      const adapterWithWatch = Object.assign(new MockFileSystemAdapter(), {
        restoreLastFolder: vi.fn(async () => handle),
        watchDirectory: vi.fn((_h: DirectoryHandle, cb: (changes: FileSystemChange[]) => void) => {
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
        throw new Error('watchDirectory callback was not registered');
      }

      expect(adapterWithWatch.watchDirectory).toHaveBeenCalledTimes(1);

      const cb = capturedCallback as (changes: FileSystemChange[]) => void;
      const changes: FileSystemChange[] = [
        { kind: 'file', path: 'src/index.ts', type: 'modified' },
        { kind: 'directory', path: 'src/nested', type: 'added' },
        { kind: 'file', path: 'src/nested/deep-file.ts', type: 'removed' },
      ];

      // Fire rapid changes — all within the 300ms debounce window.
      for (const change of changes) {
        act(() => {
          cb([change]);
        });
      }

      // No dispatch yet (debounce timer hasn't expired)
      expect(refreshCapture.events).toHaveLength(0);

      // Advance past the 300ms trailing window
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(refreshCapture.events).toHaveLength(1);
      expect(refreshCapture.events[0]).toBeInstanceOf(CustomEvent);
      expect(refreshCapture.events[0]?.detail).toEqual({
        source: 'watcher',
        scope: 'incremental',
        roots: [
          {
            rootId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
            rootPath: '/debounce-root',
            changes,
          },
        ],
      });
    } finally {
      refreshCapture.cleanup();
    }
  });

  it('prunes queued watcher changes when the changed root is removed before debounce fires', async () => {
    const refreshCapture = captureFileExplorerRefreshEvents();

    try {
      const callbacksByPath = new Map<string, (changes: FileSystemChange[]) => void>();
      const root: DirectoryHandle = {
        path: '/queued-removed-root',
        name: 'queued-removed-root',
        kind: 'directory',
        platform: 'web',
        rootId: 'queued-removed-root-id',
      } as DirectoryHandle;

      const adapterWithWatch = Object.assign(new MockFileSystemAdapter(), {
        watchDirectory: vi.fn(
          (handle: DirectoryHandle, cb: (changes: FileSystemChange[]) => void) => {
            callbacksByPath.set(handle.path, cb);
            return vi.fn();
          }
        ),
      });

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(FileExplorerTestWrapper, {
          children,
          mockFileSystemAdapter: adapterWithWatch,
        });

      const { result } = renderHook(() => useExposed(), { wrapper });

      await act(async () => {
        await result.current.fs.registerRestoredHandles([root]);
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const callback = callbacksByPath.get('/queued-removed-root');
      if (!callback) {
        throw new Error('watchDirectory callback was not registered');
      }

      act(() => {
        callback([{ kind: 'file', path: 'src/stale.ts', type: 'modified' }]);
      });

      await act(async () => {
        await result.current.fs.removeRootDirectory('queued-removed-root-id');
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(refreshCapture.events).toHaveLength(0);
    } finally {
      refreshCapture.cleanup();
    }
  });

  it('ignores watcher callbacks flushed after their root was removed', async () => {
    const refreshCapture = captureFileExplorerRefreshEvents();

    try {
      const callbacksByPath = new Map<string, (changes: FileSystemChange[]) => void>();
      const root: DirectoryHandle = {
        path: '/disposed-flush-root',
        name: 'disposed-flush-root',
        kind: 'directory',
        platform: 'web',
        rootId: 'disposed-flush-root-id',
      } as DirectoryHandle;

      const adapterWithWatch = Object.assign(new MockFileSystemAdapter(), {
        watchDirectory: vi.fn(
          (handle: DirectoryHandle, cb: (changes: FileSystemChange[]) => void) => {
            callbacksByPath.set(handle.path, cb);
            return vi.fn();
          }
        ),
      });

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(FileExplorerTestWrapper, {
          children,
          mockFileSystemAdapter: adapterWithWatch,
        });

      const { result } = renderHook(() => useExposed(), { wrapper });

      await act(async () => {
        await result.current.fs.registerRestoredHandles([root]);
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const callback = callbacksByPath.get('/disposed-flush-root');
      if (!callback) {
        throw new Error('watchDirectory callback was not registered');
      }

      await act(async () => {
        await result.current.fs.removeRootDirectory('disposed-flush-root-id');
      });

      expect(() => {
        callback([{ kind: 'file', path: 'src/disposed.ts', type: 'modified' }]);
      }).not.toThrow();

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(refreshCapture.events).toHaveLength(0);
    } finally {
      refreshCapture.cleanup();
    }
  });

  it('cleans up refresh event listeners when a listener assertion fails', () => {
    const refreshCapture = captureFileExplorerRefreshEvents();
    const expectedError = new Error('intentional listener cleanup assertion failure');

    expect(() => {
      try {
        window.dispatchEvent(
          createFileExplorerRefreshEvent({
            source: 'watcher',
            scope: 'incremental',
            roots: [],
          })
        );
        throw expectedError;
      } finally {
        refreshCapture.cleanup();
      }
    }).toThrow(expectedError);

    window.dispatchEvent(
      createFileExplorerRefreshEvent({
        source: 'watcher',
        scope: 'incremental',
        roots: [],
      })
    );

    expect(refreshCapture.listener).toHaveBeenCalledTimes(1);
  });

  it('merges rapid watcher callbacks from different roots into one refresh event', async () => {
    const refreshCapture = captureFileExplorerRefreshEvents();

    try {
      const callbacksByPath = new Map<string, (changes: FileSystemChange[]) => void>();

      const rootA: DirectoryHandle = {
        path: '/multi-root-a',
        name: 'multi-root-a',
        kind: 'directory',
        platform: 'web',
        rootId: 'root-a-id',
      } as DirectoryHandle;
      const rootB: DirectoryHandle = {
        path: '/multi-root-b',
        name: 'multi-root-b',
        kind: 'directory',
        platform: 'web',
        rootId: 'root-b-id',
      } as DirectoryHandle;

      const adapterWithWatch = Object.assign(new MockFileSystemAdapter(), {
        watchDirectory: vi.fn(
          (handle: DirectoryHandle, cb: (changes: FileSystemChange[]) => void) => {
            callbacksByPath.set(handle.path, cb);
            return vi.fn();
          }
        ),
      });

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(FileExplorerTestWrapper, {
          children,
          mockFileSystemAdapter: adapterWithWatch,
        });

      const { result } = renderHook(() => useExposed(), { wrapper });

      await act(async () => {
        await result.current.fs.registerRestoredHandles([rootA, rootB]);
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(adapterWithWatch.watchDirectory).toHaveBeenCalledTimes(2);
      const callbackA = callbacksByPath.get('/multi-root-a');
      const callbackB = callbacksByPath.get('/multi-root-b');
      if (!(callbackA && callbackB)) {
        throw new Error('watchDirectory callbacks were not registered for both roots');
      }

      const changesA: FileSystemChange[] = [{ kind: 'file', path: 'src/a.ts', type: 'modified' }];
      const changesB: FileSystemChange[] = [
        { kind: 'directory', path: 'src/features/nested', type: 'added' },
        { kind: 'file', path: 'src/features/nested/b.ts', type: 'added' },
      ];

      act(() => {
        callbackA(changesA);
        callbackB(changesB);
      });

      expect(refreshCapture.events).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(refreshCapture.events).toHaveLength(1);
      expect(refreshCapture.events[0]?.detail).toEqual({
        source: 'watcher',
        scope: 'incremental',
        roots: [
          {
            rootId: 'root-a-id',
            rootPath: '/multi-root-a',
            changes: changesA,
          },
          {
            rootId: 'root-b-id',
            rootPath: '/multi-root-b',
            changes: changesB,
          },
        ],
      });
    } finally {
      refreshCapture.cleanup();
    }
  });

  it('unmounting clears the pending debounce timer — no dispatch after unmount', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    let capturedCallback: ((changes: FileSystemChange[]) => void) | null = null;

    const handle: DirectoryHandle = {
      path: '/unmount-root',
      name: 'unmount-root',
      kind: 'directory',
      platform: 'web',
      rootId: 'unmount-root-id',
    } as DirectoryHandle;

    const adapterWithWatch = Object.assign(new MockFileSystemAdapter(), {
      restoreLastFolder: vi.fn(async () => handle),
      watchDirectory: vi.fn((_h: DirectoryHandle, cb: (changes: FileSystemChange[]) => void) => {
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
      throw new Error('watchDirectory callback was not registered');
    }

    expect(adapterWithWatch.watchDirectory).toHaveBeenCalledTimes(1);

    const cb = capturedCallback as (changes: FileSystemChange[]) => void;
    const dispatchCountBefore = dispatchSpy.mock.calls.length;

    // Arm the debounce timer with one change notification
    act(() => {
      cb([{ kind: 'file', path: 'src/unmounted.ts', type: 'modified' }]);
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
