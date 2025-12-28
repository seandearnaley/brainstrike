/**
 * File Explorer Hook (Context-aware)
 *
 * This hook provides file explorer functionality using the context-based store.
 * Uses lazy loading for instant initial display and on-demand directory loading.
 *
 * IMPORTANT: When used within a FileTreeProvider, all components share the same
 * tree state. This ensures that when expand-all completes, all consumers see the
 * updated tree for file content loading.
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import { useFileFilters } from '@brainstrike/hooks';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { useCallback, useMemo } from 'react';

import { useFileExplorerStoreContext } from './file-explorer-provider';
import { useOptionalFileTreeContext } from './file-tree-provider';
import { useFileSystem } from './use-file-system-context';
import { type LoadingProgressState, useFileTree } from './use-file-tree-context';
import { useSharedFileContentLoading } from './use-shared-file-content-loading';

type UseFileExplorerProps = Record<string, never>;

type UseFileExplorerReturn = {
  fileTree: IFileNode[];
  handleRootDirectorySelect: () => Promise<DirectoryHandle | null>;
  isLoading: boolean;
  error: Error | null;
  fileContents: { [path: string]: string };
  loadingFiles: Set<string>;
  applyFileFilters: (
    includeFilters: string[],
    excludeFilters: string[],
    useRegex: boolean
  ) => IFileNode[];
  filterError: string | null;
  rootDirectoryHandle: DirectoryHandle | null;
  isFileSystemAccessSupported: () => { supported: boolean; reason: string };
  loadFileContent: (path: string) => Promise<void>;
  /** Load content for multiple files at once (batch loading for report generation) */
  loadMultipleFileContents: (compositeKeys: string[]) => Promise<void>;
  refreshFileExplorer: () => Promise<void>;
  isInitialLoad: boolean;
  clearFileContents: (compositeKeys: string[]) => void;
  loadingProgress: LoadingProgressState | null;
  /** Whether the current operation can be cancelled */
  cancellable: boolean;
  /** Cancel the current loading operation */
  cancelOperation: () => void;
  /** Whether the operation is currently being cancelled */
  isCancelling: boolean;
  clearRootDirectory: () => void;
  /** Set of paths currently loading their children (lazy loading) */
  loadingPaths: Set<string>;
  /** Load children of a directory on expand (lazy loading) */
  loadChildren: (path: string) => Promise<void>;
  /** Refresh a specific directory */
  refreshDirectory: (path: string) => Promise<void>;
  /** Progressively expand all directories (loads everything) */
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
  ) => Promise<void>;
  /** Cancel expand-all operation */
  cancelExpandAll: () => void;
  /** Whether expand-all is in progress */
  isExpandingAll: boolean;
  /** Progress of expand-all operation */
  expandAllProgress: { loaded: number; total: number } | null;
};

export function useFileExplorer(_: UseFileExplorerProps = {}): UseFileExplorerReturn {
  // Split Zustand selectors and hoist them to avoid recreating selector lambdas per render
  const selectIncludeFilters = (s: FileExplorerState) => s.includeFilters;
  const selectExcludeFilters = (s: FileExplorerState) => s.excludeFilters;
  const selectUseRegex = (s: FileExplorerState) => s.useRegex;
  const selectSetFilters = (s: FileExplorerState) => s.setFilters;
  const selectSetUseRegex = (s: FileExplorerState) => s.setUseRegex;
  const selectClearFileContents = (s: FileExplorerState) => s.clearFileContents;

  const store = useFileExplorerStoreContext();
  const includeFilters = store(selectIncludeFilters);
  const excludeFilters = store(selectExcludeFilters);
  const useRegex = store(selectUseRegex);
  const setFilters = store(selectSetFilters);
  const setUseRegex = store(selectSetUseRegex);
  const storeClearFileContents = store(selectClearFileContents);

  const {
    rootDirectoryHandle,
    selectRootDirectory,
    isFileSystemAccessSupported,
    clearRootDirectory,
  } = useFileSystem();

  // Try to get shared tree state from FileTreeProvider context.
  // This ensures all components using useFileExplorer share the same tree
  // after expand-all completes - fixing the "file not found" bug.
  const sharedTreeContext = useOptionalFileTreeContext();

  // Always call useFileTree to maintain hook order (rules of hooks).
  // When sharedTreeContext is available, we use its values instead.
  const localTreeState = useFileTree(rootDirectoryHandle);

  // Use shared context if available, otherwise use local tree state
  const {
    fileTree,
    isLoading: isTreeLoading,
    error: treeError,
    refreshTree,
    loadingProgress,
    cancellable,
    cancelOperation,
    isCancelling,
    loadingPaths,
    loadChildren,
    refreshDirectory,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll,
    expandAllProgress,
  } = sharedTreeContext ?? localTreeState;

  // storeClearFileContents is selected above to keep hook count constant

  // Use the shared file content loading hook
  const {
    fileContents,
    error: contentError,
    loadingFiles: contentLoadingFiles,
    handleFileContentLoading,
  } = useSharedFileContentLoading(fileTree);

  const { applyFileFilters: applyFiltersUtil, filterError: localFilterError } = useFileFilters();

  // Unify filtered tree computation in useMemo to avoid state/effect complexity
  const filteredTree = useMemo(() => {
    if (fileTree.length > 0) {
      return applyFiltersUtil(fileTree, includeFilters, excludeFilters, useRegex);
    }
    return [];
  }, [fileTree, includeFilters, excludeFilters, useRegex, applyFiltersUtil]);

  const loadFileContent = useCallback(
    async (compositeKey: string) => {
      await handleFileContentLoading([compositeKey]);
    },
    [handleFileContentLoading]
  );

  const handleRootDirectorySelect = useCallback(
    async () => selectRootDirectory(),
    [selectRootDirectory]
  );

  const refreshFileExplorer = useCallback(async () => {
    if (!rootDirectoryHandle) {
      throw new Error('No root directory selected');
    }
    await refreshTree();
  }, [rootDirectoryHandle, refreshTree]);

  // Wrapper for external filter application (maintains API compatibility)
  // Updates store filters, which causes filteredTree useMemo to recompute on next render
  // Returns a synchronously filtered tree so callers receive immediately filtered results
  const wrappedApplyFileFilters = useCallback(
    (
      currentIncludeFilters: string[],
      currentExcludeFilters: string[],
      currentUseRegex: boolean
    ) => {
      // Update the store filters - filteredTree useMemo will recompute on next render
      setFilters(currentIncludeFilters, currentExcludeFilters);
      setUseRegex(currentUseRegex);

      // Compute and return filtered results immediately for API compatibility
      return applyFiltersUtil(
        fileTree,
        currentIncludeFilters,
        currentExcludeFilters,
        currentUseRegex
      );
    },
    [applyFiltersUtil, fileTree, setFilters, setUseRegex]
  );

  // Derive error from tree, content, and filter errors
  const deriveDisplayError = (): Error | null => {
    if (treeError) {
      return treeError;
    }
    if (contentError) {
      return contentError;
    }
    if (localFilterError) {
      return new Error(localFilterError);
    }
    return null;
  };
  const displayError = deriveDisplayError();

  // Initial load is when we have a root but tree is still loading
  const isInitialLoad = !rootDirectoryHandle && isTreeLoading;

  return {
    fileTree: filteredTree,
    handleRootDirectorySelect,
    isLoading: isTreeLoading,
    error: displayError,
    fileContents,
    loadingFiles: contentLoadingFiles,
    applyFileFilters: wrappedApplyFileFilters,
    filterError: localFilterError,
    rootDirectoryHandle,
    isFileSystemAccessSupported,
    loadFileContent,
    loadMultipleFileContents: handleFileContentLoading,
    refreshFileExplorer,
    isInitialLoad,
    clearFileContents: storeClearFileContents,
    loadingProgress,
    cancellable,
    cancelOperation,
    isCancelling,
    clearRootDirectory,
    loadingPaths,
    loadChildren,
    refreshDirectory,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll,
    expandAllProgress,
  };
}
