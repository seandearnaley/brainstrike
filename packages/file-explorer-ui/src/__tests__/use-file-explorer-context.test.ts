import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import { createFileNode } from '@brainstrike/test-utils';
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
vi.mock('../shell/use-file-system-context', () => ({
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
  useFileContentLoading: vi.fn(),
  useFileExplorer: vi.fn(),
  useAdapters: vi.fn(),
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
import { __resetRestorationLock, useFileExplorer } from '../shell/use-file-explorer-context';
import { useFileSystem } from '../shell/use-file-system-context';
import { useFileTree } from '../tree/use-file-tree-context';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

describe('useFileExplorer (context)', () => {
  const mockSelectRootDirectory = vi.fn();
  const mockRefreshTree = vi.fn();
  const mockHandleFileContentLoading = vi.fn();
  const mockClearFileContents = vi.fn();

  const rootHandle: DirectoryHandle = {
    path: '/root',
    name: 'root',
    kind: 'directory',
    platform: 'web',
    _internal: {} as FileSystemDirectoryHandle,
  };

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
      currentFolderId: null,
      folderStates: {},
      selectedFilePaths: new Set<string>(),
      querySelectionManifest: null,
      expandedDirectoryPaths: new Set<string>(),
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      includeProjectTree: true,
      tokenBudget: 100_000,
      folderSummaryThreshold: 5,
      maxSelectionCount: 10,
      lastActiveTab: 'files',
      folderAccessOrder: [],
      fileContents: {},
      quickFilter: '',
      setCurrentFolderId: vi.fn(),
      hydrateFolderState: vi.fn(),
      setSelectedFiles: vi.fn(),
      addSelectedFile: vi.fn(),
      removeSelectedFile: vi.fn(),
      toggleSelectedFile: vi.fn(),
      clearSelectedFiles: vi.fn(),
      addMultipleSelectedFiles: vi.fn(),
      addMultipleSelectedFilesChunked: vi.fn(async () => ({
        addedCount: 0,
        cancelled: false,
        limitReached: false,
      })),
      removeMultipleSelectedFiles: vi.fn(),
      setExpandedPaths: vi.fn(),
      toggleDirectoryExpansion: vi.fn(),
      expandAllDirectories: vi.fn(),
      collapseAllDirectories: vi.fn(),
      setFilters: vi.fn(),
      setUseRegex: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setTokenBudget: vi.fn(),
      setFolderSummaryThreshold: vi.fn(),
      setMaxSelectionCount: vi.fn(),
      setLastActiveTab: vi.fn(),
      devInlineFixtureEnabled: false,
      setDevInlineFixtureEnabled: vi.fn(),
      setFileContent: vi.fn(),
      getFileContent: vi.fn(),
      clearFileContents: vi.fn(),
      clearAllFileContents: vi.fn(),
      getFileContentCacheStats: vi.fn(() => ({
        totalSize: 0,
        entryCount: 0,
        hitRate: 0,
        evictionCount: 0,
      })),
      evictOldFileContents: vi.fn(),
      setQuickFilter: vi.fn(),
      clearQuickFilter: vi.fn(),
      rootDirectoryHandle: null,
      setRootDirectoryHandle: vi.fn(),
      // Selection model actions (BST-142)
      selectionModel: {
        mode: 'explicit' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
        queryDescriptor: null,
      },
      setSelectionMode: vi.fn(),
      setSelectionRules: vi.fn(),
      setQuerySelection: vi.fn(),
      setQuerySelectionManifest: vi.fn(),
      clearSelectionRules: vi.fn(),
      commitRulesToExplicit: vi.fn(),
      setMaterializedPaths: vi.fn(),
      isAccessLoading: false,
      selectionVersion: 0,
      setIsAccessLoading: vi.fn(),
      viewFilterPresetId: null,
      setViewFilterPresetId: vi.fn(),
      disabledIncludeFilters: new Set<string>(),
      disabledExcludeFilters: new Set<string>(),
      toggleFilterEnabled: vi.fn(),
      isFiltersExpanded: true,
      setFiltersExpanded: vi.fn(),
      // Multi-root (Phase 2+)
      activeRootIds: [],
      rootDescriptors: {},
      addActiveRoot: vi.fn(),
      setActiveRoots: vi.fn(),
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

    vi.mocked(useFileSystem).mockReturnValue({
      rootDirectoryHandle: rootHandle,
      isAccessLoading: false,
      selectRootDirectory: mockSelectRootDirectory,
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
      clearRootDirectory: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setAccessLoading: vi.fn(),
    });

    vi.mocked(useFileTree).mockReturnValue({
      fileTree: initialFileTree,
      isLoading: false,
      error: null,
      refreshTree: mockRefreshTree,
      loadingProgress: {
        loadingCount: 0,
        isInitialLoading: false,
      },
      cancellable: false,
      cancelOperation: vi.fn(),
      isCancelling: false,
      loadingPaths: new Set<string>(),
      loadChildren: vi.fn(),
      refreshDirectory: vi.fn(),
      expandAllProgressively: vi.fn(),
      cancelExpandAll: vi.fn(),
      isExpandingAll: false,
      expandAllProgress: null,
      loadSpecificPaths: vi.fn(),
      cancelChildLoading: vi.fn(),
      selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
      cancelRecursiveSelect: vi.fn(),
      isLoadingForSelection: false,
      loadingPathForSelection: null,
      selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
      cancelSelectAll: vi.fn(),
      isLoadingForSelectAll: false,
      workerPortRef: { current: null },
    });

    vi.mocked(useFileContentLoading).mockReturnValue({
      fileContents: { '/file1.ts': 'content' },
      isLoading: false,
      error: null,
      handleFileContentLoading: mockHandleFileContentLoading,
      clearFileContents: mockClearFileContents,
    });

    vi.mocked(useSharedFileContentLoading).mockReturnValue({
      fileContents: { '/file1.ts': 'content' },
      isLoading: false,
      error: null,
      loadingFiles: new Set<string>(),
      handleFileContentLoading: mockHandleFileContentLoading,
      canLoadWithoutTree: false,
    });

    const coreReturn = {
      isLoading: false,
      rootDirectoryHandle: rootHandle,
      error: null,
      filterError: null,
    } as unknown as ReturnType<typeof useCoreFileExplorer>;
    vi.mocked(useCoreFileExplorer).mockReturnValue(coreReturn);

    vi.mocked(useAdapters).mockReturnValue({
      fileSystemAdapter: {
        readFile: vi.fn(),
        readDirectory: vi.fn(),
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
      result.current.loadFileContent('/file1.ts');
    });

    expect(mockSelectRootDirectory).toHaveBeenCalled();
    expect(mockHandleFileContentLoading).toHaveBeenCalledWith(['/file1.ts']);
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
    vi.mocked(useFileSystem).mockReturnValue({
      rootDirectoryHandle: null,
      isAccessLoading: false,
      selectRootDirectory: mockSelectRootDirectory,
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
      clearRootDirectory: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setAccessLoading: vi.fn(),
    });

    const { result } = renderHook(() => useFileExplorer());

    expect(result.current.rootDirectoryHandle).toBeNull();
    await expect(result.current.refreshFileExplorer()).rejects.toBeInstanceOf(Error);
    expect(mockRefreshTree).not.toHaveBeenCalled();
  });

  it('loadMultipleFileContents calls handleFileContentLoading with array of keys', async () => {
    const { result } = renderHook(() => useFileExplorer());

    await act(async () => {
      await result.current.loadMultipleFileContents(['/file1.ts', '/file2.js', '/file3.tsx']);
    });

    expect(mockHandleFileContentLoading).toHaveBeenCalledWith([
      '/file1.ts',
      '/file2.js',
      '/file3.tsx',
    ]);
  });

  describe('stale state clearing behavior', () => {
    it('should NOT clear persisted state while isAccessLoading is true', () => {
      // This tests the fix for the race condition where persisted state was being
      // cleared before the file system had a chance to restore the root directory.

      // Setup: no root directory handle but still loading (restore in progress)
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: null,
        isAccessLoading: true, // Still loading/restoring
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

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
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: null,
        isAccessLoading: false, // Loading complete, no handle restored
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

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
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: null,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      storeState.currentFolderId = 'brainstrike';
      storeState.selectedFilePaths = new Set(['brainstrike|@|src/file-0.ts']);
      storeState.expandedDirectoryPaths = new Set(['src']);
      storeState.folderStates = {
        brainstrike: {
          selectedFilePaths: new Set(['brainstrike|@|src/file-0.ts']),
          selectionModel: {
            mode: 'explicit',
            explicitPaths: new Set(['brainstrike|@|src/file-0.ts']),
            ruleSetJson: null,
            materializedPaths: null,
            materializedAt: null,
            queryDescriptor: null,
          },
          expandedDirectoryPaths: new Set(['src']),
          includeFilters: [],
          excludeFilters: [],
          useRegex: false,
          includeProjectTree: true,
          tokenBudget: 100_000,
          folderSummaryThreshold: 5,
          maxSelectionCount: 2000,
          lastActiveTab: 'files',
          lastAccessed: Date.now(),
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
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

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
      useFileSystemMock.mockReturnValue({
        rootDirectoryHandle: null,
        isAccessLoading: true,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      storeState.selectedFilePaths = new Set(['folder|@|file1.ts']);
      storeState.expandedDirectoryPaths = new Set(['/src']);

      const { rerender } = renderHook(() => useFileExplorer());

      // State should NOT be cleared during loading
      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).not.toHaveBeenCalled();

      // Simulate restore completing successfully
      useFileSystemMock.mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      act(() => {
        rerender();
      });

      // State should STILL not be cleared because we now have a valid handle
      expect(storeState.clearSelectedFiles).not.toHaveBeenCalled();
      expect(storeState.setExpandedPaths).not.toHaveBeenCalled();
    });

    it('cancels pending stale-state clearing when access loading restarts before the timer fires', async () => {
      const useFileSystemMock = vi.mocked(useFileSystem);
      useFileSystemMock.mockReturnValue({
        rootDirectoryHandle: null,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      storeState.selectedFilePaths = new Set(['folder|@|file1.ts']);
      storeState.expandedDirectoryPaths = new Set(['/src']);

      vi.useFakeTimers();

      const { rerender } = renderHook(() => useFileExplorer());

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      useFileSystemMock.mockReturnValue({
        rootDirectoryHandle: null,
        isAccessLoading: true,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });
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
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: null,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

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
      useFileSystemMock.mockReturnValue({
        rootDirectoryHandle: null,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      storeState.selectedFilePaths = new Set(['folder|@|file1.ts']);
      storeState.expandedDirectoryPaths = new Set(['/src']);
      storeState.rootDirectoryHandle = null;

      vi.useFakeTimers();

      const { rerender } = renderHook(() => useFileExplorer());

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      useFileSystemMock.mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

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
        fileTree: [],
        isLoading: true,
        loadingProgress: {
          loadingCount: 1,
          isInitialLoading: true,
        },
        error: null,
        refreshTree: mockRefreshTree,
        cancellable: false,
        cancelOperation: vi.fn(),
        isCancelling: false,
        loadingPaths: new Set<string>(),
        loadChildren: vi.fn(),
        refreshDirectory: vi.fn(),
        expandAllProgressively: vi.fn(),
        cancelExpandAll: vi.fn(),
        isExpandingAll: false,
        expandAllProgress: null,
        loadSpecificPaths: vi.fn(),
        cancelChildLoading: vi.fn(),
        selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelRecursiveSelect: vi.fn(),
        isLoadingForSelection: false,
        loadingPathForSelection: null,
        selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelSelectAll: vi.fn(),
        isLoadingForSelectAll: false,
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
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

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
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

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
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      // Empty expanded paths - no restoration needed
      storeState.expandedDirectoryPaths = new Set();

      const loadSpecificPathsMock = vi.fn();
      vi.mocked(useFileTree).mockReturnValue({
        fileTree: initialFileTree,
        isLoading: false,
        error: null,
        refreshTree: mockRefreshTree,
        loadingProgress: { loadingCount: 0, isInitialLoading: false },
        cancellable: false,
        cancelOperation: vi.fn(),
        isCancelling: false,
        loadingPaths: new Set<string>(),
        loadChildren: vi.fn(),
        refreshDirectory: vi.fn(),
        expandAllProgressively: vi.fn(),
        cancelExpandAll: vi.fn(),
        isExpandingAll: false,
        expandAllProgress: null,
        loadSpecificPaths: loadSpecificPathsMock,
        cancelChildLoading: vi.fn(),
        selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelRecursiveSelect: vi.fn(),
        isLoadingForSelection: false,
        loadingPathForSelection: null,
        selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelSelectAll: vi.fn(),
        isLoadingForSelectAll: false,
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

      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      // Setup: selected files in various directories, but those directories are NOT expanded
      storeState.selectedFilePaths = new Set([
        'root|@|src/components/Button.tsx',
        'root|@|src/utils/helpers.ts',
        'root|@|lib/api/client.ts',
        'root|@|package.json', // root-level file - should not add empty parent dir
      ]);
      storeState.expandedDirectoryPaths = new Set(['src']); // Only 'src' is expanded

      const loadSpecificPathsMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useFileTree).mockReturnValue({
        fileTree: initialFileTree,
        isLoading: false,
        error: null,
        refreshTree: mockRefreshTree,
        loadingProgress: { loadingCount: 0, isInitialLoading: false },
        cancellable: false,
        cancelOperation: vi.fn(),
        isCancelling: false,
        loadingPaths: new Set<string>(),
        loadChildren: vi.fn(),
        refreshDirectory: vi.fn(),
        expandAllProgressively: vi.fn(),
        cancelExpandAll: vi.fn(),
        isExpandingAll: false,
        expandAllProgress: null,
        loadSpecificPaths: loadSpecificPathsMock,
        cancelChildLoading: vi.fn(),
        selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelRecursiveSelect: vi.fn(),
        isLoadingForSelection: false,
        loadingPathForSelection: null,
        selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelSelectAll: vi.fn(),
        isLoadingForSelectAll: false,
        workerPortRef: { current: null },
      });

      renderHook(() => useFileExplorer());

      // Wait for the effect to run
      await act(async () => {
        await Promise.resolve();
      });

      // loadSpecificPaths should be called with merged paths:
      // - 'src' (from expandedDirectoryPaths)
      // - 'src/components' (parent of Button.tsx)
      // - 'src/utils' (parent of helpers.ts)
      // - 'lib/api' (parent of client.ts)
      // - 'lib' is NOT needed because 'lib/api' implicitly requires 'lib' to be loaded first
      // Note: package.json has no parent dir (root level), so nothing added for it
      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);

      const calledPaths = loadSpecificPathsMock.mock.calls[0]?.[0] as string[];
      expect(calledPaths).toContain('src');
      expect(calledPaths).toContain('src/components');
      expect(calledPaths).toContain('src/utils');
      expect(calledPaths).toContain('lib/api');
      // Should NOT contain empty string (for root-level files)
      expect(calledPaths).not.toContain('');
    });

    it('reruns restoration when selected files change after the root is already settled', async () => {
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      storeState.selectedFilePaths = new Set<string>();
      storeState.expandedDirectoryPaths = new Set<string>();

      const loadSpecificPathsMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useFileTree).mockReturnValue({
        fileTree: initialFileTree,
        isLoading: false,
        error: null,
        refreshTree: mockRefreshTree,
        loadingProgress: { loadingCount: 0, isInitialLoading: false },
        cancellable: false,
        cancelOperation: vi.fn(),
        isCancelling: false,
        loadingPaths: new Set<string>(),
        loadChildren: vi.fn(),
        refreshDirectory: vi.fn(),
        expandAllProgressively: vi.fn(),
        cancelExpandAll: vi.fn(),
        isExpandingAll: false,
        expandAllProgress: null,
        loadSpecificPaths: loadSpecificPathsMock,
        cancelChildLoading: vi.fn(),
        selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelRecursiveSelect: vi.fn(),
        isLoadingForSelection: false,
        loadingPathForSelection: null,
        selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelSelectAll: vi.fn(),
        isLoadingForSelectAll: false,
        workerPortRef: { current: null },
      });

      const { rerender } = renderHook(() => useFileExplorer());

      await act(async () => {
        await Promise.resolve();
      });

      expect(loadSpecificPathsMock).not.toHaveBeenCalled();

      storeState.selectedFilePaths = new Set(['root|@|src/assistant/tools.ts']);
      storeState.selectionVersion = 1;

      rerender();

      await act(async () => {
        await Promise.resolve();
      });

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);
      expect(loadSpecificPathsMock.mock.calls[0]?.[0]).toEqual(['src', 'src/assistant']);
    });

    it('retries restoration when selected files change while ancestor loading is in flight', async () => {
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      storeState.selectedFilePaths = new Set(['root|@|src/initial.ts']);
      storeState.expandedDirectoryPaths = new Set<string>();

      let resolveLoad: () => void = () => {};
      const loadSpecificPathsMock = vi.fn<(paths: string[]) => Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            resolveLoad = resolve;
          })
      );
      vi.mocked(useFileTree).mockReturnValue({
        fileTree: initialFileTree,
        isLoading: false,
        error: null,
        refreshTree: mockRefreshTree,
        loadingProgress: { loadingCount: 0, isInitialLoading: false },
        cancellable: false,
        cancelOperation: vi.fn(),
        isCancelling: false,
        loadingPaths: new Set<string>(),
        loadChildren: vi.fn(),
        refreshDirectory: vi.fn(),
        expandAllProgressively: vi.fn(),
        cancelExpandAll: vi.fn(),
        isExpandingAll: false,
        expandAllProgress: null,
        loadSpecificPaths: loadSpecificPathsMock,
        cancelChildLoading: vi.fn(),
        selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelRecursiveSelect: vi.fn(),
        isLoadingForSelection: false,
        loadingPathForSelection: null,
        selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelSelectAll: vi.fn(),
        isLoadingForSelectAll: false,
        workerPortRef: { current: null },
      });

      const { rerender } = renderHook(() => useFileExplorer());

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);
      expect(loadSpecificPathsMock.mock.calls[0]?.[0]).toEqual(['src']);

      storeState.selectedFilePaths = new Set(['root|@|packages/agent/runtime.ts']);
      storeState.selectionVersion = 1;

      act(() => {
        rerender();
      });

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveLoad();
      });

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(2);
      expect(loadSpecificPathsMock.mock.calls[1]?.[0]).toEqual(['packages', 'packages/agent']);
    });

    it('should not duplicate paths when parent dir is already in expanded paths', async () => {
      // If a parent directory of a selected file is already in expandedDirectoryPaths,
      // it should not be duplicated in the restoration call.

      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      // 'src/components' is both an expanded path AND parent of a selected file
      storeState.selectedFilePaths = new Set(['root|@|src/components/Button.tsx']);
      storeState.expandedDirectoryPaths = new Set(['src', 'src/components']);

      const loadSpecificPathsMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useFileTree).mockReturnValue({
        fileTree: initialFileTree,
        isLoading: false,
        error: null,
        refreshTree: mockRefreshTree,
        loadingProgress: { loadingCount: 0, isInitialLoading: false },
        cancellable: false,
        cancelOperation: vi.fn(),
        isCancelling: false,
        loadingPaths: new Set<string>(),
        loadChildren: vi.fn(),
        refreshDirectory: vi.fn(),
        expandAllProgressively: vi.fn(),
        cancelExpandAll: vi.fn(),
        isExpandingAll: false,
        expandAllProgress: null,
        loadSpecificPaths: loadSpecificPathsMock,
        cancelChildLoading: vi.fn(),
        selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelRecursiveSelect: vi.fn(),
        isLoadingForSelection: false,
        loadingPathForSelection: null,
        selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelSelectAll: vi.fn(),
        isLoadingForSelectAll: false,
        workerPortRef: { current: null },
      });

      renderHook(() => useFileExplorer());

      await act(async () => {
        await Promise.resolve();
      });

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);

      const calledPaths = loadSpecificPathsMock.mock.calls[0]?.[0] as string[];
      // Using Set ensures no duplicates - 'src/components' should appear only once
      expect(calledPaths.filter((p) => p === 'src/components').length).toBe(1);
    });

    it('re-commits restored expansion paths even without restored selected files', async () => {
      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: rootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      storeState.selectedFilePaths = new Set();
      storeState.expandedDirectoryPaths = new Set(['src', 'src/components']);

      const loadSpecificPathsMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useFileTree).mockReturnValue({
        fileTree: initialFileTree,
        isLoading: false,
        error: null,
        refreshTree: mockRefreshTree,
        loadingProgress: { loadingCount: 0, isInitialLoading: false },
        cancellable: false,
        cancelOperation: vi.fn(),
        isCancelling: false,
        loadingPaths: new Set<string>(),
        loadChildren: vi.fn(),
        refreshDirectory: vi.fn(),
        expandAllProgressively: vi.fn(),
        cancelExpandAll: vi.fn(),
        isExpandingAll: false,
        expandAllProgress: null,
        loadSpecificPaths: loadSpecificPathsMock,
        cancelChildLoading: vi.fn(),
        selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelRecursiveSelect: vi.fn(),
        isLoadingForSelection: false,
        loadingPathForSelection: null,
        selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelSelectAll: vi.fn(),
        isLoadingForSelectAll: false,
        workerPortRef: { current: null },
      });

      renderHook(() => useFileExplorer());

      await act(async () => {
        await Promise.resolve();
      });

      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);
      expect(storeState.setExpandedPaths).toHaveBeenCalledWith(new Set(['src', 'src/components']));
    });

    it('does not commit restored expansion paths after the root changes mid-restore', async () => {
      const otherRootHandle: DirectoryHandle = {
        path: '/other',
        name: 'other',
        kind: 'directory',
        platform: 'web',
        _internal: {} as FileSystemDirectoryHandle,
      };
      let resolveLoadSpecificPaths: (() => void) | null = null;
      const loadSpecificPathsMock = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveLoadSpecificPaths = resolve;
          })
      );

      storeState.expandedDirectoryPaths = new Set(['src']);
      vi.mocked(useFileTree).mockReturnValue({
        fileTree: initialFileTree,
        isLoading: false,
        error: null,
        refreshTree: mockRefreshTree,
        loadingProgress: { loadingCount: 0, isInitialLoading: false },
        cancellable: false,
        cancelOperation: vi.fn(),
        isCancelling: false,
        loadingPaths: new Set<string>(),
        loadChildren: vi.fn(),
        refreshDirectory: vi.fn(),
        expandAllProgressively: vi.fn(),
        cancelExpandAll: vi.fn(),
        isExpandingAll: false,
        expandAllProgress: null,
        loadSpecificPaths: loadSpecificPathsMock,
        cancelChildLoading: vi.fn(),
        selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelRecursiveSelect: vi.fn(),
        isLoadingForSelection: false,
        loadingPathForSelection: null,
        selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
        cancelSelectAll: vi.fn(),
        isLoadingForSelectAll: false,
        workerPortRef: { current: null },
      });

      const { rerender } = renderHook(() => useFileExplorer());

      await act(async () => {
        await Promise.resolve();
      });
      expect(loadSpecificPathsMock).toHaveBeenCalledTimes(1);

      vi.mocked(useFileSystem).mockReturnValue({
        rootDirectoryHandle: otherRootHandle,
        isAccessLoading: false,
        selectRootDirectory: mockSelectRootDirectory,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
        clearRootDirectory: vi.fn(),
        setRootDirectoryHandle: vi.fn(),
        setAccessLoading: vi.fn(),
      });

      rerender();

      await act(async () => {
        resolveLoadSpecificPaths?.();
        await Promise.resolve();
      });

      expect(storeState.setExpandedPaths).not.toHaveBeenCalled();
    });
  });
});
