import type { DirectoryHandle } from '@brainstrike/file-system';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { FileSystemChange } from '@brainstrike/types';
import { useToast } from '@brainstrike/ui';
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
    cleanup: () => window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, listener),
    events,
    listener,
  };
}

describe('useFileSystem context hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('selectRootDirectory success sets handle and toggles loading', async () => {
    const mockHandle: DirectoryHandle = {
      kind: 'directory',
      name: 'mock-root',
      path: 'mock-root',
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
      kind: 'directory',
      name: 'restored-root',
      path: 'restored-root',
      platform: 'web',
      // Identity is rootId-only: the restored handle's rootId IS the already-current
      // folder id, so restoring it rehydrates the persisted folder state.
      rootId: 'restored-root',
    } as DirectoryHandle;

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    act(() => {
      result.current.store.setState({
        currentFolderId: 'restored-root',
        folderStates: {
          'restored-root': {
            excludeFilters: [],
            expandedDirectoryPaths: new Set<string>(),
            folderSummaryThreshold: 5,
            includeFilters: [],
            includeProjectTree: true,
            lastAccessed: Date.now(),
            lastActiveTab: 'files',
            maxSelectionCount: 1000,
            selectedFilePaths: new Set<string>(['restored-root|@|file-0.ts']),
            selectionModel: {
              explicitPaths: new Set<string>(),
              materializedAt: new Date().toISOString(),
              materializedPaths: new Set<string>(['file-0.ts']),
              mode: 'query',
              queryDescriptor: {
                coveredDirectoryPaths: [],
                excludedPaths: [],
                excludeFilters: [],
                folderId: 'restored-root',
                includedPaths: [],
                includeFilters: ['*.ts'],
                kind: 'recursive-select-all',
                manifestFingerprint: 'fingerprint',
                manifestSnapshotId: 'snapshot-id',
                rootPath: null,
                totalSelectedCount: 600,
                useRegex: false,
              },
            },
            tokenBudget: 100_000,
            useRegex: false,
            viewFilterPresetId: null,
          },
        },
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
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
      kind: 'directory',
      name: 'selected-restored-root',
      path: 'selected-restored-root',
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
        // Expansion is WORKSPACE-GLOBAL: persistence keeps it in the
        // top-level set (folder snapshots are no longer hydrated).
        expandedDirectoryPaths: new Set<string>(['src']),
        folderStates: {
          [CONTROLLED_ROOT_ID]: {
            excludeFilters: [],
            expandedDirectoryPaths: new Set<string>(['src']),
            folderSummaryThreshold: 5,
            includeFilters: [],
            includeProjectTree: true,
            lastAccessed: Date.now(),
            lastActiveTab: 'files',
            maxSelectionCount: 1000,
            selectedFilePaths: new Set<string>([SELECTION_KEY]),
            selectionModel: {
              explicitPaths: new Set<string>([SELECTION_KEY]),
              materializedAt: null,
              materializedPaths: null,
              mode: 'explicit',
              queryDescriptor: null,
            },
            tokenBudget: 100_000,
            useRegex: false,
            viewFilterPresetId: null,
          },
        },
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
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
      kind: 'directory',
      name: 'restored-root',
      path: 'restored-root',
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
      kind: 'directory',
      name: 'fixture-root',
      path: 'fixture-root',
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

  it("appends an additional root from the inject event's 'add' mode (multi-root fixture harness)", async () => {
    const primaryHandle: DirectoryHandle = {
      kind: 'directory',
      name: 'fixture-root',
      path: 'fixture-root',
      platform: 'web',
      rootId: 'fixture-root-id',
    } as DirectoryHandle;
    const secondHandle: DirectoryHandle = {
      kind: 'directory',
      name: 'second-root',
      path: 'second-root',
      platform: 'web',
      rootId: 'second-root-id',
    } as DirectoryHandle;

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(INJECT_ROOT_HANDLE_EVENT, { detail: { handle: primaryHandle } })
      );
    });
    await waitFor(() => {
      expect(result.current.fs.rootDirectoryHandle).toMatchObject(primaryHandle);
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(INJECT_ROOT_HANDLE_EVENT, {
          detail: { handle: secondHandle, mode: 'add' },
        })
      );
    });

    await waitFor(() => {
      // BOTH roots are active (forest), the added one focused, and
      // currentFolderId moved to its durable RootId.
      expect(result.current.fs.rootDirectoryHandles).toHaveLength(2);
      expect(result.current.fs.rootDirectoryHandle).toMatchObject(secondHandle);
      expect(result.current.store.getState().currentFolderId).toBe('second-root-id');
    });

    // Reset like the sibling inject test: the store persists currentFolderId
    // across tests in this file, and a leaked focus would bleed into the
    // watcher-debounce suite's rootId resolution.
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
        kind: 'directory',
        name: 'debounce-root',
        path: '/debounce-root',
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
        roots: [
          {
            changes,
            rootId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
            rootPath: '/debounce-root',
          },
        ],
        scope: 'incremental',
        source: 'watcher',
      });
    } finally {
      refreshCapture.cleanup();
    }
  });

  it('flushes by max-wait even while changes keep streaming in (busy build)', async () => {
    const refreshCapture = captureFileExplorerRefreshEvents();

    try {
      let capturedCallback: ((changes: FileSystemChange[]) => void) | null = null;
      const handle: DirectoryHandle = {
        kind: 'directory',
        name: 'busy-root',
        path: '/busy-root',
        platform: 'web',
        rootId: 'busy-root-id',
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
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      if (!capturedCallback) {
        throw new Error('watchDirectory callback was not registered');
      }
      const cb = capturedCallback as (changes: FileSystemChange[]) => void;

      // A change every 200ms keeps resetting the 300ms trailing window —
      // without a max-wait bound, NOTHING would ever dispatch while a build
      // keeps writing. The max-wait flush must fire within ~1s regardless.
      for (let index = 0; index < 7; index += 1) {
        act(() => {
          cb([{ kind: 'file', path: `src/busy-${index}.ts`, type: 'modified' }]);
        });
        act(() => {
          vi.advanceTimersByTime(200);
        });
      }

      expect(refreshCapture.events.length).toBeGreaterThanOrEqual(1);
    } finally {
      refreshCapture.cleanup();
    }
  });

  it('prunes queued watcher changes when the changed root is removed before debounce fires', async () => {
    const refreshCapture = captureFileExplorerRefreshEvents();

    try {
      const callbacksByPath = new Map<string, (changes: FileSystemChange[]) => void>();
      const root: DirectoryHandle = {
        kind: 'directory',
        name: 'queued-removed-root',
        path: '/queued-removed-root',
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
        kind: 'directory',
        name: 'disposed-flush-root',
        path: '/disposed-flush-root',
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
            roots: [],
            scope: 'incremental',
            source: 'watcher',
          })
        );
        throw expectedError;
      } finally {
        refreshCapture.cleanup();
      }
    }).toThrow(expectedError);

    window.dispatchEvent(
      createFileExplorerRefreshEvent({
        roots: [],
        scope: 'incremental',
        source: 'watcher',
      })
    );

    expect(refreshCapture.listener).toHaveBeenCalledTimes(1);
  });

  it('merges rapid watcher callbacks from different roots into one refresh event', async () => {
    const refreshCapture = captureFileExplorerRefreshEvents();

    try {
      const callbacksByPath = new Map<string, (changes: FileSystemChange[]) => void>();

      const rootA: DirectoryHandle = {
        kind: 'directory',
        name: 'multi-root-a',
        path: '/multi-root-a',
        platform: 'web',
        rootId: 'root-a-id',
      } as DirectoryHandle;
      const rootB: DirectoryHandle = {
        kind: 'directory',
        name: 'multi-root-b',
        path: '/multi-root-b',
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
        roots: [
          {
            changes: changesA,
            rootId: 'root-a-id',
            rootPath: '/multi-root-a',
          },
          {
            changes: changesB,
            rootId: 'root-b-id',
            rootPath: '/multi-root-b',
          },
        ],
        scope: 'incremental',
        source: 'watcher',
      });
    } finally {
      refreshCapture.cleanup();
    }
  });

  it('unmounting clears the pending debounce timer — no dispatch after unmount', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    let capturedCallback: ((changes: FileSystemChange[]) => void) | null = null;

    const handle: DirectoryHandle = {
      kind: 'directory',
      name: 'unmount-root',
      path: '/unmount-root',
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

describe('useFileSystem — watcher health signals (overflow / errored)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type WatchSignal = import('@brainstrike/file-system').FileSystemWatchSignal;

  async function setupWatchedRoot() {
    let capturedCallback: ((changes: FileSystemChange[]) => void) | null = null;
    let capturedOnSignal: ((signal: WatchSignal) => void) | null = null;

    const handle: DirectoryHandle = {
      kind: 'directory',
      name: 'signal-root',
      path: '/signal-root',
      platform: 'web',
      rootId: 'signal-root-id',
    } as DirectoryHandle;

    const adapterWithWatch = Object.assign(new MockFileSystemAdapter(), {
      restoreLastFolder: vi.fn(async () => handle),
      watchDirectory: vi.fn(
        (
          _h: DirectoryHandle,
          cb: (changes: FileSystemChange[]) => void,
          onSignal?: (signal: WatchSignal) => void
        ) => {
          capturedCallback = cb;
          capturedOnSignal = onSignal ?? null;
          return vi.fn();
        }
      ),
    });

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FileExplorerTestWrapper, {
        children,
        mockFileSystemAdapter: adapterWithWatch,
      });

    const rendered = renderHook(() => ({ ...useExposed(), toastState: useToast() }), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    if (!(capturedCallback && capturedOnSignal)) {
      throw new Error('watchDirectory callback/onSignal was not registered');
    }
    return {
      onSignal: capturedOnSignal as (signal: WatchSignal) => void,
      rendered,
      rootId: rendered.result.current.store.getState().currentFolderId as string,
      watcherCallback: capturedCallback as (changes: FileSystemChange[]) => void,
    };
  }

  it('overflow dispatches an immediate one-shot full refresh for the affected root, superseding pending incremental changes', async () => {
    const refreshCapture = captureFileExplorerRefreshEvents();
    try {
      const { onSignal, rootId, watcherCallback } = await setupWatchedRoot();

      // Queue an incremental change, then overflow before the debounce fires.
      act(() => {
        watcherCallback([{ kind: 'file', path: 'src/a.ts', type: 'modified' }]);
      });
      act(() => {
        onSignal({ type: 'overflow' });
      });

      // The full refresh is IMMEDIATE (no 300ms debounce wait).
      expect(refreshCapture.events).toHaveLength(1);
      expect(refreshCapture.events[0]?.detail).toEqual({
        roots: [{ changes: [], rootId, rootPath: '/signal-root' }],
        scope: 'full',
        source: 'watcher',
      });

      // Repeated overflow within the dedupe window is one-shot: no second dispatch.
      act(() => {
        onSignal({ type: 'overflow' });
      });
      expect(refreshCapture.events).toHaveLength(1);

      // The queued incremental change was dropped (superseded by the full
      // refresh) — the debounce timer must not fire a second, stale event.
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(refreshCapture.events).toHaveLength(1);

      // After the dedupe window a NEW overflow refreshes again.
      act(() => {
        onSignal({ type: 'overflow' });
      });
      expect(refreshCapture.events).toHaveLength(2);
    } finally {
      refreshCapture.cleanup();
    }
  });

  it('errored raises a destructive toast and dispatches NO refresh event', async () => {
    const refreshCapture = captureFileExplorerRefreshEvents();
    try {
      const { onSignal, rendered } = await setupWatchedRoot();

      act(() => {
        onSignal({ message: 'File watching stopped for /signal-root: dead.', type: 'errored' });
      });

      expect(refreshCapture.events).toHaveLength(0);
      const toasts = rendered.result.current.toastState.toasts;
      const errorToast = toasts.find((t) => t.title === 'Folder watching stopped');
      expect(errorToast).toBeDefined();
      expect(errorToast?.variant).toBe('destructive');
      expect(String(errorToast?.description)).toContain('/signal-root');
    } finally {
      refreshCapture.cleanup();
    }
  });

  it('ignores signals from roots that are no longer active', async () => {
    const refreshCapture = captureFileExplorerRefreshEvents();
    try {
      const { onSignal, rendered, rootId } = await setupWatchedRoot();

      await act(async () => {
        await rendered.result.current.fs.removeRootDirectory(rootId);
      });

      act(() => {
        onSignal({ type: 'overflow' });
      });
      expect(refreshCapture.events).toHaveLength(0);
    } finally {
      refreshCapture.cleanup();
    }
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
      kind: 'directory',
      name: 'mock-root',
      path: 'mock-root',
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
