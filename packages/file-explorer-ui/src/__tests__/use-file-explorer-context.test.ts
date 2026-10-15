import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { createFileNode } from '@brainstrike/file-tree-test-fixtures';
import type { StorageAdapter } from '@brainstrike/storage';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks for internal context hooks
vi.mock('../shell/file-explorer-provider', () => {
  const useFileExplorerStoreContext = vi.fn();
  return {
    useFileExplorerStoreContext,
    useFileExplorerStoreSelector: vi.fn((selector: (state: unknown) => unknown) => {
      const store = useFileExplorerStoreContext();
      return store(selector);
    }),
  };
});
vi.mock('../shell/file-system-provider', () => ({
  useFileSystem: vi.fn(),
}));
vi.mock('../tree/use-file-tree-context', () => ({
  useFileTree: vi.fn(),
}));
vi.mock('../use-shared-file-content-loading', () => ({
  useSharedFileContentLoading: vi.fn(),
}));

// Mocks for external hooks used inside the context hook
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: vi.fn(),
  useFileContentLoading: vi.fn(),
  useFileExplorer: vi.fn(),
}));

const mockApplyFileFilters = vi.fn();
vi.mock('@brainstrike/hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/hooks')>();
  return {
    ...original,
    useFileFilters: vi.fn(() => ({
      applyFileFilters: mockApplyFileFilters,
      filterError: null,
    })),
  };
});

import {
  useAdapters,
  useFileExplorer as useCoreFileExplorer,
  useFileContentLoading,
} from '@brainstrike/file-explorer-hooks';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { useFileSystem } from '../shell/file-system-provider';
import { __resetRestorationLock, useFileExplorer } from '../shell/use-file-explorer-context';
import { useFileTree } from '../tree/use-file-tree-context';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

describe('useFileExplorer (context)', () => {
  const mockSelectRootDirectory = vi.fn();
  const mockRefreshTree = vi.fn();
  const mockHandleFileContentLoading = vi.fn();
  const mockClearFileContents = vi.fn();

  const rootHandle: DirectoryHandle = {
    _internal: {} as FileSystemDirectoryHandle,
    kind: 'directory',
    name: 'root',
    path: '/root',
    platform: 'web',
    rootId: 'root',
  };

  /** Build a minimal useFileSystem mock with multi-root fields defaulted. */
  function makeFileSystemMock(
    overrides: Partial<ReturnType<typeof useFileSystem>> = {}
  ): ReturnType<typeof useFileSystem> {
    return {
      addRootDirectory: vi.fn().mockResolvedValue(null),
      // Web-shaped adapter: the desktop-only capabilities are absent, not stubbed.
      addRootDirectoryByPath: undefined,
      clearRootDirectory: vi.fn(),
      isAccessLoading: false,
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ reason: '', supported: true }),
      listRecentRoots: undefined,
      recentRootsRevision: 0,
      registerRestoredHandles: vi.fn().mockResolvedValue(undefined),
      removeRootDirectory: vi.fn().mockResolvedValue(undefined),
      rootDirectoryHandle: rootHandle,
      rootDirectoryHandles: [],
      // Storage v5: empty map (no RootId registrations in these tests)
      rootIdByPath: new Map<string, string>(),
      selectRootDirectory: mockSelectRootDirectory,
      setAccessLoading: vi.fn(),
      setFocusedRoot: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      ...overrides,
    };
  }

  let initialFileTree: IFileNode[];
  let filteredTree: IFileNode[];
  let storeState: FileExplorerState;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module-level restoration lock between tests
    __resetRestorationLock();

    initialFileTree = [
      createFileNode({ name: 'file1.ts', path: '/file1.ts' }),
      createFileNode({ name: 'file2.js', path: '/file2.js' }),
    ];
    filteredTree = [initialFileTree[0] as IFileNode];
    mockApplyFileFilters.mockImplementation((tree, includeFiltersArg) => {
      // Return filteredTree when any filter is applied; otherwise return the original tree
      if (includeFiltersArg.length > 0) {
        return filteredTree;
      }
      return tree;
    });

    storeState = {
      // Multi-root (Phase 2+)
      activeRootIds: [],
      addActiveRoot: vi.fn(),
      addMultipleSelectedFiles: vi.fn(),
      addMultipleSelectedFilesChunked: vi.fn(async () => ({
        addedCount: 0,
        cancelled: false,
        limitReached: false,
      })),
      addSelectedFile: vi.fn(),
      clearAllFileContents: vi.fn(),
      clearDisabledFilters: vi.fn(),
      clearFileContents: vi.fn(),
      clearQuickFilter: vi.fn(),
      clearSelectedFiles: vi.fn(),
      collapseAllDirectories: vi.fn(),
      consumePersistenceRecoveryNotice: vi.fn(),
      currentFolderId: null,
      devInlineFixtureEnabled: false,
      disabledExcludeFilters: new Set<string>(),
      disabledIncludeFilters: new Set<string>(),
      evictOldFileContents: vi.fn(),
      excludeFilters: [],
      expandAllDirectories: vi.fn(),
      expandedDirectoryPaths: new Set<string>(),
      explorerScrollTop: 0,
      fileContents: {},
      folderAccessOrder: [],
      folderStates: {},
      folderSummaryThreshold: 5,
      getFileContent: vi.fn(),
      getFileContentCacheStats: vi.fn(() => ({
        entryCount: 0,
        evictionCount: 0,
        hitRate: 0,
        totalSize: 0,
      })),
      hydrateFolderState: vi.fn(),
      includeFilters: [],
      includeProjectTree: true,
      isAccessLoading: false,
      isFilterChipsVisible: true,
      isFiltersExpanded: true,
      lastActiveTab: 'files',
      maxSelectionCount: 10,
      persistenceRecoveryNotice: null,
      querySelectionManifest: null,
      quickFilter: '',
      reconcileSelectionWithDirectorySnapshot: vi.fn(),
      reconcileSelectionWithDirectorySnapshots: vi.fn(),
      removeActiveRoot: vi.fn(),
      removeMultipleSelectedFiles: vi.fn(),
      removeSelectedFile: vi.fn(),
      reportPersistedStateDiscard: vi.fn(),
      resetSelectionToExplicit: vi.fn(),
      rootDescriptors: {},
      selectedFilePaths: new Set<string>(),
      // Selection model actions (BST-142)
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit' as const,
        queryDescriptor: null,
      },
      selectionVersion: 0,
      setActiveRoots: vi.fn(),
      setCurrentFolderId: vi.fn(),
      setDevInlineFixtureEnabled: vi.fn(),
      setExpandedPaths: vi.fn(),
      setExplorerScrollTop: vi.fn(),
      setFileContent: vi.fn(),
      setFilterChipsVisible: vi.fn(),
      setFilters: vi.fn(),
      setFiltersExpanded: vi.fn(),
      setFolderSelection: vi.fn(),
      setFolderSummaryThreshold: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setIsAccessLoading: vi.fn(),
      setLastActiveTab: vi.fn(),
      setMainRoot: vi.fn(),
      setMaxSelectionCount: vi.fn(),
      setQuerySelection: vi.fn(),
      setQuerySelectionManifest: vi.fn(),
      setQuickFilter: vi.fn(),
      setSelectedFiles: vi.fn(),
      setSelectionMode: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      toggleDirectoryExpansion: vi.fn(),
      toggleFilterEnabled: vi.fn(),
      toggleSelectedFile: vi.fn(),
      useRegex: false,
      viewFilterPresetId: null,
    };
    // Mock store function to handle individual selector calls (split selector pattern)
    const mockStore = vi.fn((selector?: (state: FileExplorerState) => unknown) => {
      if (typeof selector === 'function') {
        return selector(storeState);
      }
      return storeState;
    }) as unknown as ReturnType<typeof useFileExplorerStoreContext>;
    // Add getState method for Zustand store compatibility
    (mockStore as unknown as { getState: () => FileExplorerState }).getState = () => storeState;
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore);

    vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock());

    vi.mocked(useFileTree).mockReturnValue({
      cancelChildLoading: vi.fn(),
      cancelExpandAll: vi.fn(),
      cancellable: false,
      cancelOperation: vi.fn(),
      cancelRecursiveSelect: vi.fn(),
      cancelSelectAll: vi.fn(),
      error: null,
      expandAllProgress: null,
      expandAllProgressively: vi.fn(),
      fileTree: initialFileTree,
      isCancelling: false,
      isExpandingAll: false,
      isLoading: false,
      isLoadingForSelectAll: false,
      isLoadingForSelection: false,
      loadChildren: vi.fn(),
      loadingPathForSelection: null,
      loadingPaths: new Set<string>(),
      loadingProgress: {
        isInitialLoading: false,
        loadingCount: 0,
      },
      loadSpecificPaths: vi.fn(),
      refreshDirectory: vi.fn(),
      refreshTree: mockRefreshTree,
      selectAllRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
      selectFolderRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
      workerPortRef: { current: null },
    });

    vi.mocked(useFileContentLoading).mockReturnValue({
      clearFileContents: mockClearFileContents,
      error: null,
      fileContents: { '/file1.ts': 'content' },
      handleFileContentLoading: mockHandleFileContentLoading,
      isLoading: false,
    });

    vi.mocked(useSharedFileContentLoading).mockReturnValue({
      canLoadWithoutTree: false,
      error: null,
      fileContentErrors: new Map(),
      fileContents: { '/file1.ts': 'content' },
      handleFileContentLoading: mockHandleFileContentLoading,
      isLoading: false,
      loadingFiles: new Set<string>(),
      reloadFileContents: vi.fn(),
    });

    const coreReturn = {
      error: null,
      filterError: null,
      isLoading: false,
      rootDirectoryHandle: rootHandle,
    } as unknown as ReturnType<typeof useCoreFileExplorer>;
    vi.mocked(useCoreFileExplorer).mockReturnValue(coreReturn);

    vi.mocked(useAdapters).mockReturnValue({
      fileSystemAdapter: {
        readDirectory: vi.fn(),
        readFile: vi.fn(),
      } as Partial<FileSystemAdapter> as FileSystemAdapter,
      storageAdapter: {} as StorageAdapter,
    });
  });

  it('returns values combined from context hooks', () => {
    const { result } = renderHook(() => useFileExplorer());

    // With no filters applied, fileTree should be the unfiltered tree
    expect(result.current.fileTree).toEqual(initialFileTree);
    expect(result.current.rootDirectoryHandle).toBe(rootHandle);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.fileContents['/file1.ts']).toBe('content');
    expect(mockApplyFileFilters).toHaveBeenCalledWith(initialFileTree, [], [], false);

    act(() => {
      result.current.handleRootDirectorySelect();
      result.current.loadFileContent('/file1.ts', 'interactive');
    });

    expect(mockSelectRootDirectory).toHaveBeenCalled();
    expect(mockHandleFileContentLoading).toHaveBeenCalledWith(['/file1.ts'], 'interactive');
  });

  it('applyFileFilters updates store filters and returns freshly filtered fileTree', () => {
    const { result } = renderHook(() => useFileExplorer());

    act(() => {
      // applyFileFilters updates store and returns freshly computed filteredTree
      const returned = result.current.applyFileFilters(['*.js'], [], false);
      expect(returned).toEqual(filteredTree);
    });

    // Verify store update functions were called
    expect(storeState.setFilters).toHaveBeenCalledWith(['*.js'], []);
    expect(storeState.setUseRegex).toHaveBeenCalledWith(false);
    expect(mockApplyFileFilters).toHaveBeenCalledWith(initialFileTree, ['*.js'], [], false);
  });

  it('refreshFileExplorer throws when no root directory is selected', async () => {
    vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock({ rootDirectoryHandle: null }));

    const { result } = renderHook(() => useFileExplorer());

    expect(result.current.rootDirectoryHandle).toBeNull();
    await expect(result.current.refreshFileExplorer()).rejects.toBeInstanceOf(Error);
    expect(mockRefreshTree).not.toHaveBeenCalled();
  });

  it.each(['completed', 'cancelled'] as const)(
    'refreshFileExplorer passes through a %s tree refresh outcome',
    async (status) => {
      mockRefreshTree.mockResolvedValueOnce({ status });
      const { result } = renderHook(() => useFileExplorer());

      await expect(result.current.refreshFileExplorer()).resolves.toEqual({ status });
      expect(mockRefreshTree).toHaveBeenCalledOnce();
    }
  );

  it('refreshFileExplorer passes through the exact tree refresh error', async () => {
    const refreshError = new Error('tree refresh failed');
    mockRefreshTree.mockRejectedValueOnce(refreshError);
    const { result } = renderHook(() => useFileExplorer());

    await expect(result.current.refreshFileExplorer()).rejects.toBe(refreshError);
    expect(mockRefreshTree).toHaveBeenCalledOnce();
  });

  it('loadMultipleFileContents calls handleFileContentLoading with array of keys', async () => {
    const { result } = renderHook(() => useFileExplorer());

    await act(async () => {
      await result.current.loadMultipleFileContents(
        ['/file1.ts', '/file2.js', '/file3.tsx'],
        'background'
      );
    });

    expect(mockHandleFileContentLoading).toHaveBeenCalledWith(
      ['/file1.ts', '/file2.js', '/file3.tsx'],
      'background'
    );
  });

  describe('stale state clearing behavior', () => {
    it('should NOT clear persisted state while isAccessLoading is true', () => {
      // This tests the fix for the race condition where persisted state was being
      // cleared before the file system had a chance to restore the root directory.

      // Setup: no root directory handle but still loading (restore in progress)
      // Still loading/restoring — isAccessLoading: true
      vi.mocked(useFileSystem).mockReturnValue(
        makeFileSystemMock({ isAccessLoading: true, rootDirectoryHandle: null })
      );

      // Add some "persisted" state that should NOT be cleared while loading
      storeState.selectedFilePaths = new Set(['folder|@|file1.ts', 'folder|@|file2.ts']);
      storeState.expandedDirectoryPaths = new Set(['/src', '/src/components']);

      renderHook(() => useFileExplorer());

      // clearSelectedFiles and setExpandedPaths should NOT have been called
      // because isAccessLoading is true
      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).not.toHaveBeenCalled();
    });

    it('should clear stale state only after isAccessLoading becomes false with no root handle', async () => {
      // Setup: no root directory handle and not loading (restore failed or web platform)
      // Loading complete, no handle restored — isAccessLoading: false
      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock({ rootDirectoryHandle: null }));

      // Add some "stale" state that should be cleared
      storeState.selectedFilePaths = new Set(['folder|@|file1.ts']);
      storeState.expandedDirectoryPaths = new Set(['/src']);

      // Use fake timers to control the 1500ms delay
      vi.useFakeTimers();

      renderHook(() => useFileExplorer());

      // State should NOT be cleared immediately (waiting for timer)
      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).not.toHaveBeenCalled();

      // Advance past the 1500ms delay
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });

      // Now state should be cleared since timer has elapsed
      expect(storeState.clearSelectedFiles).toHaveBeenCalled();
      expect(storeState.setExpandedPaths).toHaveBeenCalledWith(new Set());

      vi.useRealTimers();
    });

    it('preserves recoverable persisted folder state while no web root handle is selected', async () => {
      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock({ rootDirectoryHandle: null }));

      storeState.currentFolderId = 'brainstrike';
      storeState.selectedFilePaths = new Set(['brainstrike|@|src/file-0.ts']);
      storeState.expandedDirectoryPaths = new Set(['src']);
      storeState.folderStates = {
        brainstrike: {
          excludeFilters: [],
          expandedDirectoryPaths: new Set(['src']),
          folderSummaryThreshold: 5,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: Date.now(),
          lastActiveTab: 'files',
          maxSelectionCount: 2000,
          selectedFilePaths: new Set(['brainstrike|@|src/file-0.ts']),
          selectionModel: {
            explicitPaths: new Set(['brainstrike|@|src/file-0.ts']),
            materializedAt: null,
            materializedPaths: null,
            mode: 'explicit',
            queryDescriptor: null,
          },
          useRegex: false,
          viewFilterPresetId: null,
        },
      };

      vi.useFakeTimers();

      renderHook(() => useFileExplorer());

      await act(async () => {
        vi.advanceTimersByTime(1500);
      });

      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).not.toHaveBeenCalledWith(new Set());

      vi.useRealTimers();
    });

    it('should NOT clear state when root directory handle exists (regardless of loading state)', () => {
      // Setup: root directory handle exists
      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock());

      // Add state that should be preserved
      storeState.selectedFilePaths = new Set(['folder|@|file1.ts']);
      storeState.expandedDirectoryPaths = new Set(['/src']);

      renderHook(() => useFileExplorer());

      // State should NOT be cleared because we have a valid root handle
      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).not.toHaveBeenCalled();
    });

    it('should preserve selection/expansion state when transitioning from loading to restored handle', () => {
      // This simulates the desktop auto-restore flow where state persists correctly

      // Initial state: loading in progress
      const useFileSystemMock = vi.mocked(useFileSystem);
      useFileSystemMock.mockReturnValue(
        makeFileSystemMock({ isAccessLoading: true, rootDirectoryHandle: null })
      );

      storeState.selectedFilePaths = new Set(['folder|@|file1.ts']);
      storeState.expandedDirectoryPaths = new Set(['/src']);

      const { rerender } = renderHook(() => useFileExplorer());

      // State should NOT be cleared during loading
      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).not.toHaveBeenCalled();

      // Simulate restore completing successfully
      useFileSystemMock.mockReturnValue(makeFileSystemMock());

      act(() => {
        rerender();
      });

      // State should STILL not be cleared because we now have a valid handle
      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).not.toHaveBeenCalled();
    });

    it('cancels pending stale-state clearing when access loading restarts before the timer fires', async () => {
      const useFileSystemMock = vi.mocked(useFileSystem);
      useFileSystemMock.mockReturnValue(makeFileSystemMock({ rootDirectoryHandle: null }));

      storeState.selectedFilePaths = new Set(['folder|@|file1.ts']);
      storeState.expandedDirectoryPaths = new Set(['/src']);

      vi.useFakeTimers();

      const { rerender } = renderHook(() => useFileExplorer());

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      useFileSystemMock.mockReturnValue(
        makeFileSystemMock({ isAccessLoading: true, rootDirectoryHandle: null })
      );
      storeState.isAccessLoading = true;

      act(() => {
        rerender();
      });

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).not.toHaveBeenCalledWith(new Set());

      vi.useRealTimers();
    });

    it('reads stale selection and expansion state from the store when the timer fires', async () => {
      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock({ rootDirectoryHandle: null }));

      storeState.selectedFilePaths = new Set(['folder|@|file1.ts']);
      storeState.expandedDirectoryPaths = new Set(['/src']);

      vi.useFakeTimers();

      renderHook(() => useFileExplorer());

      storeState.selectedFilePaths = new Set();

      await act(async () => {
        vi.advanceTimersByTime(1500);
      });

      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).toHaveBeenCalledWith(new Set());

      vi.useRealTimers();
    });

    it('does not clear restored state when the file-system hook restores a root before the timer fires', async () => {
      const useFileSystemMock = vi.mocked(useFileSystem);
      useFileSystemMock.mockReturnValue(makeFileSystemMock({ rootDirectoryHandle: null }));

      storeState.selectedFilePaths = new Set(['folder|@|file1.ts']);
      storeState.expandedDirectoryPaths = new Set(['/src']);

      vi.useFakeTimers();

      const { rerender } = renderHook(() => useFileExplorer());

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      useFileSystemMock.mockReturnValue(makeFileSystemMock());

      act(() => {
        rerender();
      });

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).not.toHaveBeenCalledWith(new Set());

      vi.useRealTimers();
    });
  });

  describe('isInitialLoad', () => {
    it('is true only when a root handle exists and the tree is still loading', () => {
      vi.mocked(useFileTree).mockReturnValue({
        cancelChildLoading: vi.fn(),
        cancelExpandAll: vi.fn(),
        cancellable: false,
        cancelOperation: vi.fn(),
        cancelRecursiveSelect: vi.fn(),
        cancelSelectAll: vi.fn(),
        error: null,
        expandAllProgress: null,
        expandAllProgressively: vi.fn(),
        fileTree: [],
        isCancelling: false,
        isExpandingAll: false,
        isLoading: true,
        isLoadingForSelectAll: false,
        isLoadingForSelection: false,
        loadChildren: vi.fn(),
        loadingPathForSelection: null,
        loadingPaths: new Set<string>(),
        loadingProgress: {
          isInitialLoading: true,
          loadingCount: 1,
        },
        loadSpecificPaths: vi.fn(),
        refreshDirectory: vi.fn(),
        refreshTree: mockRefreshTree,
        selectAllRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        selectFolderRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        workerPortRef: { current: null },
      });

      const { result } = renderHook(() => useFileExplorer());
      expect(result.current.isInitialLoad).toBe(true);
    });
  });

  describe('restoration effect with module-level lock', () => {
    // These tests verify the fix for the concurrent restoration bug where
    // React's concurrent rendering caused multiple effect instances to run
    // before any of them could set refs, resulting in duplicate loadSpecificPaths calls.

    it('should expose isRestoringExpandedPaths state for UI feedback', () => {
      // Setup: root directory exists with a loaded tree
      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock());

      const { result } = renderHook(() => useFileExplorer());

      // The hook should expose restoration state
      expect(typeof result.current.isRestoringExpandedPaths).toBe('boolean');
      expect(
        result.current.restorationProgress === null ||
          typeof result.current.restorationProgress === 'object'
      ).toBe(true);
    });

    it('should expose restoration progress with correct shape', () => {
      // Setup with root handle and tree
      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock());

      const { result } = renderHook(() => useFileExplorer());

      // Restoration progress should either be null or have the correct shape
      if (result.current.restorationProgress !== null) {
        expect(result.current.restorationProgress).toMatchObject({
          loaded: expect.any(Number),
          total: expect.any(Number),
        });
      }
    });

    it('should not trigger restoration when there are no persisted expanded paths', async () => {
      // Setup: root handle exists, tree is loaded, but no expanded paths
      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock());

      // Empty expanded paths - no restoration needed
      storeState.expandedDirectoryPaths = new Set();

      const loadSpecificPathsMock = vi.fn();
      vi.mocked(useFileTree).mockReturnValue({
        cancelChildLoading: vi.fn(),
        cancelExpandAll: vi.fn(),
        cancellable: false,
        cancelOperation: vi.fn(),
        cancelRecursiveSelect: vi.fn(),
        cancelSelectAll: vi.fn(),
        error: null,
        expandAllProgress: null,
        expandAllProgressively: vi.fn(),
        fileTree: initialFileTree,
        isCancelling: false,
        isExpandingAll: false,
        isLoading: false,
        isLoadingForSelectAll: false,
        isLoadingForSelection: false,
        loadChildren: vi.fn(),
        loadingPathForSelection: null,
        loadingPaths: new Set<string>(),
        loadingProgress: { isInitialLoading: false, loadingCount: 0 },
        loadSpecificPaths: loadSpecificPathsMock,
        refreshDirectory: vi.fn(),
        refreshTree: mockRefreshTree,
        selectAllRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        selectFolderRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        workerPortRef: { current: null },
      });

      renderHook(() => useFileExplorer());

      // loadSpecificPaths should NOT be called when there are no paths to restore
      expect(loadSpecificPathsMock).not.toHaveBeenCalled();
    });

    it('should include parent directories of selected files in restoration (BST-308)', async () => {
      // BST-308: When files are restored from persistence, their parent directories
      // must be loaded so that file nodes (with handles and sizes) appear in the file tree.
      // Without this, token counting and file size display fail for restored selections.

      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock());

      // Setup: selected files in various directories, but those directories are NOT expanded
      storeState.selectedFilePaths = new Set([
        'root|@|/root/src/components/Button.tsx',
        'root|@|/root/src/utils/helpers.ts',
        'root|@|/root/lib/api/client.ts',
        'root|@|/root/package.json',
      ]);
      storeState.expandedDirectoryPaths = new Set(['/root/src']);

      const loadSpecificPathsMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useFileTree).mockReturnValue({
        cancelChildLoading: vi.fn(),
        cancelExpandAll: vi.fn(),
        cancellable: false,
        cancelOperation: vi.fn(),
        cancelRecursiveSelect: vi.fn(),
        cancelSelectAll: vi.fn(),
        error: null,
        expandAllProgress: null,
        expandAllProgressively: vi.fn(),
        fileTree: initialFileTree,
        isCancelling: false,
        isExpandingAll: false,
        isLoading: false,
        isLoadingForSelectAll: false,
        isLoadingForSelection: false,
        loadChildren: vi.fn(),
        loadingPathForSelection: null,
        loadingPaths: new Set<string>(),
        loadingProgress: { isInitialLoading: false, loadingCount: 0 },
        loadSpecificPaths: loadSpecificPathsMock,
        refreshDirectory: vi.fn(),
        refreshTree: mockRefreshTree,
        selectAllRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        selectFolderRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        workerPortRef: { current: null },
      });

      renderHook(() => useFileExplorer());

      // Wait for the effect to run
      await act(async () => {
        await Promise.resolve();
      });

      // loadSpecificPaths should be called with merged paths:
      // - '/root/src' (from expandedDirectoryPaths)
      // - '/root/src/components' (parent of Button.tsx)
      // - '/root/src/utils' (parent of helpers.ts)
      // - '/root/lib/api' (parent of client.ts)
      // - '/root/lib' is NOT needed because '/root/lib/api' loads it first
      // - '/root' is the common selected-file ancestor
      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);

      const calledPaths = loadSpecificPathsMock.mock.calls[0]?.[0] as string[];
      expect(calledPaths).toContain('/root');
      expect(calledPaths).toContain('/root/src');
      expect(calledPaths).toContain('/root/src/components');
      expect(calledPaths).toContain('/root/src/utils');
      expect(calledPaths).toContain('/root/lib/api');
      expect(calledPaths).not.toContain('');
    });

    it('reruns restoration when selected files change after the root is already settled', async () => {
      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock());

      storeState.selectedFilePaths = new Set<string>();
      storeState.expandedDirectoryPaths = new Set<string>();

      const loadSpecificPathsMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useFileTree).mockReturnValue({
        cancelChildLoading: vi.fn(),
        cancelExpandAll: vi.fn(),
        cancellable: false,
        cancelOperation: vi.fn(),
        cancelRecursiveSelect: vi.fn(),
        cancelSelectAll: vi.fn(),
        error: null,
        expandAllProgress: null,
        expandAllProgressively: vi.fn(),
        fileTree: initialFileTree,
        isCancelling: false,
        isExpandingAll: false,
        isLoading: false,
        isLoadingForSelectAll: false,
        isLoadingForSelection: false,
        loadChildren: vi.fn(),
        loadingPathForSelection: null,
        loadingPaths: new Set<string>(),
        loadingProgress: { isInitialLoading: false, loadingCount: 0 },
        loadSpecificPaths: loadSpecificPathsMock,
        refreshDirectory: vi.fn(),
        refreshTree: mockRefreshTree,
        selectAllRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        selectFolderRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        workerPortRef: { current: null },
      });

      const { rerender } = renderHook(() => useFileExplorer());

      await act(async () => {
        await Promise.resolve();
      });

      expect(loadSpecificPathsMock).not.toHaveBeenCalled();

      storeState.selectedFilePaths = new Set(['root|@|/root/src/assistant/tools.ts']);
      storeState.selectionVersion = 1;

      rerender();

      await act(async () => {
        await Promise.resolve();
      });

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);
      expect(loadSpecificPathsMock.mock.calls[0]?.[0]).toEqual([
        '/root',
        '/root/src',
        '/root/src/assistant',
      ]);
    });

    it('retries restoration when selected files change while ancestor loading is in flight', async () => {
      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock());

      storeState.selectedFilePaths = new Set(['root|@|/root/src/initial.ts']);
      storeState.expandedDirectoryPaths = new Set<string>();

      let resolveLoad: () => void = () => {};
      const loadSpecificPathsMock = vi.fn<(paths: string[]) => Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            resolveLoad = resolve;
          })
      );
      vi.mocked(useFileTree).mockReturnValue({
        cancelChildLoading: vi.fn(),
        cancelExpandAll: vi.fn(),
        cancellable: false,
        cancelOperation: vi.fn(),
        cancelRecursiveSelect: vi.fn(),
        cancelSelectAll: vi.fn(),
        error: null,
        expandAllProgress: null,
        expandAllProgressively: vi.fn(),
        fileTree: initialFileTree,
        isCancelling: false,
        isExpandingAll: false,
        isLoading: false,
        isLoadingForSelectAll: false,
        isLoadingForSelection: false,
        loadChildren: vi.fn(),
        loadingPathForSelection: null,
        loadingPaths: new Set<string>(),
        loadingProgress: { isInitialLoading: false, loadingCount: 0 },
        loadSpecificPaths: loadSpecificPathsMock,
        refreshDirectory: vi.fn(),
        refreshTree: mockRefreshTree,
        selectAllRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        selectFolderRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        workerPortRef: { current: null },
      });

      const { rerender } = renderHook(() => useFileExplorer());

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);
      expect(loadSpecificPathsMock.mock.calls[0]?.[0]).toEqual(['/root', '/root/src']);

      storeState.selectedFilePaths = new Set(['root|@|/root/packages/agent/runtime.ts']);
      storeState.selectionVersion = 1;

      act(() => {
        rerender();
      });

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveLoad();
      });

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(2);
      expect(loadSpecificPathsMock.mock.calls[1]?.[0]).toEqual([
        '/root',
        '/root/packages',
        '/root/packages/agent',
      ]);
    });

    it('should not duplicate paths when parent dir is already in expanded paths', async () => {
      // If a parent directory of a selected file is already in expandedDirectoryPaths,
      // it should not be duplicated in the restoration call.

      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock());

      // 'src/components' is both an expanded path AND parent of a selected file
      storeState.selectedFilePaths = new Set(['root|@|/root/src/components/Button.tsx']);
      storeState.expandedDirectoryPaths = new Set(['/root/src', '/root/src/components']);

      const loadSpecificPathsMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useFileTree).mockReturnValue({
        cancelChildLoading: vi.fn(),
        cancelExpandAll: vi.fn(),
        cancellable: false,
        cancelOperation: vi.fn(),
        cancelRecursiveSelect: vi.fn(),
        cancelSelectAll: vi.fn(),
        error: null,
        expandAllProgress: null,
        expandAllProgressively: vi.fn(),
        fileTree: initialFileTree,
        isCancelling: false,
        isExpandingAll: false,
        isLoading: false,
        isLoadingForSelectAll: false,
        isLoadingForSelection: false,
        loadChildren: vi.fn(),
        loadingPathForSelection: null,
        loadingPaths: new Set<string>(),
        loadingProgress: { isInitialLoading: false, loadingCount: 0 },
        loadSpecificPaths: loadSpecificPathsMock,
        refreshDirectory: vi.fn(),
        refreshTree: mockRefreshTree,
        selectAllRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        selectFolderRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        workerPortRef: { current: null },
      });

      renderHook(() => useFileExplorer());

      await act(async () => {
        await Promise.resolve();
      });

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);

      const calledPaths = loadSpecificPathsMock.mock.calls[0]?.[0] as string[];
      // Using Set ensures no duplicates - 'src/components' should appear only once
      expect(calledPaths.filter((p) => p === '/root/src/components').length).toBe(1);
    });

    it('re-commits restored expansion paths even without restored selected files', async () => {
      vi.mocked(useFileSystem).mockReturnValue(makeFileSystemMock());

      storeState.selectedFilePaths = new Set();
      storeState.expandedDirectoryPaths = new Set(['/root/src', '/root/src/components']);

      const loadSpecificPathsMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useFileTree).mockReturnValue({
        cancelChildLoading: vi.fn(),
        cancelExpandAll: vi.fn(),
        cancellable: false,
        cancelOperation: vi.fn(),
        cancelRecursiveSelect: vi.fn(),
        cancelSelectAll: vi.fn(),
        error: null,
        expandAllProgress: null,
        expandAllProgressively: vi.fn(),
        fileTree: initialFileTree,
        isCancelling: false,
        isExpandingAll: false,
        isLoading: false,
        isLoadingForSelectAll: false,
        isLoadingForSelection: false,
        loadChildren: vi.fn(),
        loadingPathForSelection: null,
        loadingPaths: new Set<string>(),
        loadingProgress: { isInitialLoading: false, loadingCount: 0 },
        loadSpecificPaths: loadSpecificPathsMock,
        refreshDirectory: vi.fn(),
        refreshTree: mockRefreshTree,
        selectAllRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        selectFolderRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        workerPortRef: { current: null },
      });

      renderHook(() => useFileExplorer());

      await act(async () => {
        await Promise.resolve();
      });

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);
      expect(storeState.setExpandedPaths).toHaveBeenCalledWith(
        new Set(['/root/src', '/root/src/components'])
      );
    });

    it('does not commit restored expansion paths after the root changes mid-restore', async () => {
      const otherRootHandle: DirectoryHandle = {
        _internal: {} as FileSystemDirectoryHandle,
        kind: 'directory',
        name: 'other',
        path: '/other',
        platform: 'web',
      };
      let resolveLoadSpecificPaths: (() => void) | null = null;
      const loadSpecificPathsMock = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveLoadSpecificPaths = resolve;
          })
      );

      storeState.expandedDirectoryPaths = new Set(['/root/src']);
      vi.mocked(useFileTree).mockReturnValue({
        cancelChildLoading: vi.fn(),
        cancelExpandAll: vi.fn(),
        cancellable: false,
        cancelOperation: vi.fn(),
        cancelRecursiveSelect: vi.fn(),
        cancelSelectAll: vi.fn(),
        error: null,
        expandAllProgress: null,
        expandAllProgressively: vi.fn(),
        fileTree: initialFileTree,
        isCancelling: false,
        isExpandingAll: false,
        isLoading: false,
        isLoadingForSelectAll: false,
        isLoadingForSelection: false,
        loadChildren: vi.fn(),
        loadingPathForSelection: null,
        loadingPaths: new Set<string>(),
        loadingProgress: { isInitialLoading: false, loadingCount: 0 },
        loadSpecificPaths: loadSpecificPathsMock,
        refreshDirectory: vi.fn(),
        refreshTree: mockRefreshTree,
        selectAllRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        selectFolderRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
        workerPortRef: { current: null },
      });

      const { rerender } = renderHook(() => useFileExplorer());

      await act(async () => {
        await Promise.resolve();
      });
      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);

      vi.mocked(useFileSystem).mockReturnValue(
        makeFileSystemMock({ rootDirectoryHandle: otherRootHandle })
      );

      rerender();

      await act(async () => {
        resolveLoadSpecificPaths?.();
        await Promise.resolve();
      });

      expect(storeState.setExpandedPaths).not.toHaveBeenCalled();
    });
  });
});
