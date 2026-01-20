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
import { createLogger, decodeFileSelection } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useFileExplorerStoreContext } from './file-explorer-provider';
import { useOptionalFileTreeContext } from './file-tree-provider';
import { useFileSystem } from './use-file-system-context';
import { type LoadingProgressState, useFileTree } from './use-file-tree-context';
import { useSharedFileContentLoading } from './use-shared-file-content-loading';

const logger = createLogger('FileExplorerContext');

/**
 * Module-level lock for restoration to prevent concurrent runs.
 * React's concurrent rendering can cause multiple effect instances to run
 * before any of them sets a ref, so we need a lock outside React's lifecycle.
 */
const restorationLock = {
  inProgress: false,
  folderId: null as string | null,
};

/**
 * Reset the restoration lock state.
 * @internal Exported only for test cleanup. Do not use in production code.
 */
export function __resetRestorationLock(): void {
  restorationLock.inProgress = false;
  restorationLock.folderId = null;
}

/**
 * Helper to get the depth of a path (number of path segments).
 * Used for sorting paths by depth (shallowest first) when restoring expanded directories.
 */
function getPathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

/**
 * Helper to get the parent directory of a file path.
 * Returns the path without the last segment (the filename).
 *
 * @param filePath - Full path to a file
 * @returns Parent directory path, or empty string for root-level files
 */
function getParentDirectory(filePath: string): string {
  const segments = filePath.split('/').filter(Boolean);
  // Remove the filename (last segment) to get the parent directory
  segments.pop();
  return segments.length > 0 ? segments.join('/') : '';
}

type UseFileExplorerProps = Record<string, never>;

/** Progress state for restoring expanded directories on app startup */
export interface RestorationProgress {
  /** Number of directories restored so far */
  loaded: number;
  /** Total number of directories to restore */
  total: number;
  /** Current directory path being restored */
  currentPath: string | null;
}

interface UseFileExplorerReturn {
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
  /** Set root directory handle from external source (e.g., restore banner) */
  setRootDirectoryHandle: (handle: DirectoryHandle | null) => void;
  /** Set of paths currently loading their children (lazy loading) */
  loadingPaths: Set<string>;
  /** Load children of a directory on expand (lazy loading) */
  loadChildren: (path: string) => Promise<void>;
  /** Cancel loading for a specific directory (e.g., on collapse) */
  cancelChildLoading: (path: string) => void;
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
  /** Whether expanded directories are being restored from persisted state */
  isRestoringExpandedPaths: boolean;
  /** Progress of expanded directory restoration */
  restorationProgress: RestorationProgress | null;
  /**
   * Set the access loading state.
   * Used by restore flow to signal that a restore is in progress, which
   * prevents the stale state clearing effect from clearing expanded paths
   * while waiting for browser permission dialog.
   */
  setAccessLoading: (loading: boolean) => void;
  /**
   * Whether files can be loaded without a file tree (Electron with readFileByPath).
   * When true, tab content loading can proceed even before the tree is loaded.
   */
  canLoadWithoutTree: boolean;
  /** Select all files in a folder recursively, loading if needed */
  selectFolderRecursively: (
    node: IFileNode,
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    currentSelectionSize: number
  ) => Promise<{ success: boolean; filePaths: string[]; cancelled?: boolean; error?: string }>;
  /** Cancel the current recursive selection operation */
  cancelRecursiveSelect: () => void;
  /** Whether a subtree is being loaded for selection */
  isLoadingForSelection: boolean;
  /** Path of the folder being loaded for selection (if any) */
  loadingPathForSelection: string | null;
  /** Select all files in the entire tree, loading if needed */
  selectAllRecursively: (
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number
  ) => Promise<{
    success: boolean;
    filePaths: string[];
    totalAvailable?: number;
    limitReached?: boolean;
    cancelled?: boolean;
    error?: string;
  }>;
  /** Cancel the current select all operation */
  cancelSelectAll: () => void;
  /** Whether the tree is being loaded for select all */
  isLoadingForSelectAll: boolean;
}

export function useFileExplorer(_: UseFileExplorerProps = {}): UseFileExplorerReturn {
  // Split Zustand selectors and hoist them to avoid recreating selector lambdas per render
  const selectIncludeFilters = (s: FileExplorerState) => s.includeFilters;
  const selectExcludeFilters = (s: FileExplorerState) => s.excludeFilters;
  const selectUseRegex = (s: FileExplorerState) => s.useRegex;
  const selectSetFilters = (s: FileExplorerState) => s.setFilters;
  const selectSetUseRegex = (s: FileExplorerState) => s.setUseRegex;
  const selectClearFileContents = (s: FileExplorerState) => s.clearFileContents;
  const selectClearSelectedFiles = (s: FileExplorerState) => s.clearSelectedFiles;
  const selectSetExpandedPaths = (s: FileExplorerState) => s.setExpandedPaths;
  // Subscribe to selection/expansion state for stale state detection
  const selectSelectedFilePaths = (s: FileExplorerState) => s.selectedFilePaths;
  const selectExpandedDirectoryPaths = (s: FileExplorerState) => s.expandedDirectoryPaths;
  // Subscribe to isAccessLoading from store (shared across all components)
  const selectIsAccessLoading = (s: FileExplorerState) => s.isAccessLoading;
  const selectSetIsAccessLoading = (s: FileExplorerState) => s.setIsAccessLoading;

  const store = useFileExplorerStoreContext();
  const includeFilters = store(selectIncludeFilters);
  const excludeFilters = store(selectExcludeFilters);
  const useRegex = store(selectUseRegex);
  const setFilters = store(selectSetFilters);
  const setUseRegex = store(selectSetUseRegex);
  const storeClearFileContents = store(selectClearFileContents);
  const clearSelectedFiles = store(selectClearSelectedFiles);
  const setExpandedPaths = store(selectSetExpandedPaths);
  // Subscribe to these values so effect fires when store rehydrates
  const selectedFilePaths = store(selectSelectedFilePaths);
  const expandedDirectoryPaths = store(selectExpandedDirectoryPaths);
  // Use isAccessLoading from store (shared state, not local hook state)
  const storeIsAccessLoading = store(selectIsAccessLoading);
  const setIsAccessLoading = store(selectSetIsAccessLoading);

  const {
    rootDirectoryHandle,
    isAccessLoading: _hookIsAccessLoading, // Ignore the hook's local state
    selectRootDirectory,
    isFileSystemAccessSupported,
    clearRootDirectory,
    setRootDirectoryHandle,
    setAccessLoading: _hookSetAccessLoading, // Ignore the hook's local setter
  } = useFileSystem();

  // Use the store's isAccessLoading (shared across all components)
  const isAccessLoading = storeIsAccessLoading;
  const setAccessLoading = setIsAccessLoading;

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
    cancelChildLoading,
    refreshDirectory,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll,
    expandAllProgress,
    loadSpecificPaths,
    selectFolderRecursively,
    cancelRecursiveSelect,
    isLoadingForSelection,
    loadingPathForSelection,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAll,
  } = sharedTreeContext ?? localTreeState;

  // storeClearFileContents is selected above to keep hook count constant

  // Use the shared file content loading hook
  const {
    fileContents,
    error: contentError,
    loadingFiles: contentLoadingFiles,
    handleFileContentLoading,
    canLoadWithoutTree,
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

  // Track which folder we've already restored expanded paths for
  const restoredForFolderRef = useRef<string | null>(null);
  // Track if restoration is in progress to prevent duplicate runs
  const isRestoringRef = useRef(false);
  // Track the stale clearing timer ID so we can cancel it from outside the effect
  const staleClearingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // State for restoration progress - exposed to UI for feedback
  const [isRestoringExpandedPaths, setIsRestoringExpandedPaths] = useState(false);
  const [restorationProgress, setRestorationProgress] = useState<RestorationProgress | null>(null);

  // CRITICAL: Cancel the stale clearing timer immediately when isAccessLoading becomes true.
  // This runs synchronously on every render, ensuring the timer is cancelled before it can fire.
  if (isAccessLoading && staleClearingTimerRef.current !== null) {
    logger.debug('Cancelling stale clearing timer - isAccessLoading became true');
    clearTimeout(staleClearingTimerRef.current);
    staleClearingTimerRef.current = null;
  }

  /**
   * Clear stale selection and expansion state when there's no root directory handle.
   *
   * On web, FileSystemHandle cannot be persisted to localStorage. When the app reloads:
   * 1. Store restores selectedFilePaths and expandedDirectoryPaths from persistence
   * 2. But rootDirectoryHandle is null (can't be serialized)
   * 3. Without rootDirectoryHandle, the file tree never loads
   * 4. This creates an inconsistent state where files appear "selected" but can't be acted upon
   *
   * IMPORTANT: We must wait for isAccessLoading to be false before clearing state.
   * On desktop, the file system adapter may be restoring the last folder asynchronously.
   * If we clear state while that restore is in progress, we lose persisted selections/expansions.
   *
   * ALSO IMPORTANT: On web, useRestoreAccess checks for stored handles with a 500ms delay.
   * We must wait longer before clearing state to allow the restore banner to show.
   * We use a 1500ms delay to give the restore banner time to check handles and render.
   *
   * This effect is REACTIVE - it subscribes to selectedFilePaths and expandedDirectoryPaths
   * so it fires when Zustand's persist middleware rehydrates the store. The effect is
   * self-limiting: once we clear the stale state, the sizes become 0 and the condition
   * no longer matches.
   */
  useEffect(() => {
    // Wait for initial mount to complete (not loading tree)
    if (isTreeLoading) {
      return;
    }

    // CRITICAL: Wait for file system access loading to complete.
    // On desktop, restoreLastFolder is called on startup and sets isAccessLoading=true.
    // We must not clear state until that restore attempt completes.
    if (isAccessLoading) {
      return;
    }

    // If we have a root directory handle, no cleanup needed - state is valid
    if (rootDirectoryHandle) {
      return;
    }

    // Check for stale state using subscribed values (reactive to store rehydration)
    const hasStaleSelection = selectedFilePaths.size > 0;
    const hasStaleExpansion = expandedDirectoryPaths.size > 0;

    if (!(hasStaleSelection || hasStaleExpansion)) {
      return;
    }

    // Delay clearing to allow useRestoreAccess hook time to check for stored handles
    // and show the restore banner. The restore hook has a 500ms delay, so we wait 1500ms.
    // Store the timer in a ref so it can be cancelled synchronously from render phase
    // if isAccessLoading becomes true before the timer fires.
    staleClearingTimerRef.current = setTimeout(() => {
      // Clear the ref since the timer is now executing
      staleClearingTimerRef.current = null;

      // CRITICAL: Check isAccessLoading directly from the store at callback time.
      // This ensures we see the current value, not a stale closure-captured value.
      // The store is shared across all components, so this check is reliable.
      const currentStoreState = store.getState();
      if (currentStoreState.isAccessLoading) {
        logger.debug('Skipping stale clearing - access loading now in progress (store check)');
        return;
      }

      logger.info('Clearing stale file explorer state - no root directory handle', {
        staleSelectedFiles: selectedFilePaths.size,
        staleExpandedPaths: expandedDirectoryPaths.size,
      });

      if (hasStaleSelection) {
        clearSelectedFiles();
      }
      if (hasStaleExpansion) {
        setExpandedPaths(new Set());
      }
    }, 1500);

    return () => {
      if (staleClearingTimerRef.current !== null) {
        clearTimeout(staleClearingTimerRef.current);
        staleClearingTimerRef.current = null;
      }
    };
  }, [
    rootDirectoryHandle,
    isAccessLoading,
    isTreeLoading,
    selectedFilePaths,
    expandedDirectoryPaths,
    clearSelectedFiles,
    setExpandedPaths,
  ]);

  /**
   * Auto-restore expanded directories from persisted state.
   *
   * When the app loads, the store restores expandedDirectoryPaths from storage,
   * but the lazy-loaded tree only has root-level nodes. This effect loads
   * children for previously expanded directories so the UI matches the persisted state.
   *
   * Algorithm:
   * 1. Wait for root to finish loading (fileTree has items, not loading)
   * 2. Get persisted expandedDirectoryPaths from store
   * 3. Sort paths by depth (shallowest first - parents before children)
   * 4. Load children for each directory in order
   */
  useEffect(() => {
    // Get current folder ID from root handle
    const currentFolderId = rootDirectoryHandle?.name ?? null;

    // Skip if no root, still loading, or no tree
    if (!currentFolderId || isTreeLoading || fileTree.length === 0) {
      logger.debug('[Restoration Effect] Skipped - prerequisites not met', {
        noFolderId: !currentFolderId,
        stillLoading: isTreeLoading,
        emptyTree: fileTree.length === 0,
      });
      return;
    }

    // Use module-level lock to prevent concurrent runs (React refs don't work in concurrent mode)
    // Check if already restored for this folder
    if (restorationLock.folderId === currentFolderId) {
      logger.debug('[Restoration Effect] Skipped - already restored for this folder');
      return;
    }

    // Check if restoration is in progress
    if (restorationLock.inProgress) {
      logger.debug('[Restoration Effect] Skipped - restoration in progress');
      return;
    }

    // IMMEDIATELY acquire module-level lock to prevent concurrent runs
    // This happens synchronously before any async operations
    restorationLock.inProgress = true;
    restorationLock.folderId = currentFolderId;
    // Also update refs for backwards compatibility
    restoredForFolderRef.current = currentFolderId;
    isRestoringRef.current = true;

    // Get persisted expanded paths AND selected files from store
    const storeState = store.getState();
    const expandedPaths = storeState.expandedDirectoryPaths;
    const selectedFiles = storeState.selectedFilePaths;

    // BST-308: Include parent directories of selected files in restoration.
    // When files are restored from persistence, their parent directories must be loaded
    // so that file nodes (with handles and sizes) appear in the file tree.
    // Without this, token counting and file size display fail for restored selections.
    const parentDirectoriesOfSelectedFiles = new Set<string>();
    for (const compositeKey of selectedFiles) {
      try {
        const { path } = decodeFileSelection(compositeKey);
        const parentDir = getParentDirectory(path);
        // Only add non-empty parent directories (empty means root-level file)
        if (parentDir) {
          parentDirectoriesOfSelectedFiles.add(parentDir);
        }
      } catch {
        // Ignore invalid composite keys
      }
    }

    // Merge expanded paths with parent directories of selected files
    const allPathsToRestore = new Set([...expandedPaths, ...parentDirectoriesOfSelectedFiles]);

    logger.debug('[Restoration Effect] Paths to restore', {
      folderId: currentFolderId,
      expandedPathCount: expandedPaths.size,
      selectedFileCount: selectedFiles.size,
      parentDirsOfSelectedFiles: parentDirectoriesOfSelectedFiles.size,
      totalPathsToRestore: allPathsToRestore.size,
      expandedPaths: [...expandedPaths].slice(0, 5),
      parentDirs: [...parentDirectoriesOfSelectedFiles].slice(0, 5),
    });

    // Skip if no paths to restore
    if (allPathsToRestore.size === 0) {
      logger.debug('[Restoration Effect] Skipped - no paths to restore');
      isRestoringRef.current = false;
      restorationLock.inProgress = false;
      return;
    }

    // Now safe to update state - we've locked restoration for this folder
    setIsRestoringExpandedPaths(true);

    logger.info('Restoring expanded directories and file parent directories', {
      folderId: currentFolderId,
      expandedPathCount: expandedPaths.size,
      parentDirsOfSelectedFilesCount: parentDirectoriesOfSelectedFiles.size,
      totalPathCount: allPathsToRestore.size,
    });

    // Sort paths by depth (shallowest first so parents load before children)
    const sortedPaths = [...allPathsToRestore].sort((a, b) => getPathDepth(a) - getPathDepth(b));
    const total = sortedPaths.length;

    // Initialize progress
    setRestorationProgress({ loaded: 0, total, currentPath: null });

    // Use worker-based loading for optimal performance
    // The worker batches I/O and only updates React state once at completion
    const restoreExpansions = async () => {
      try {
        await loadSpecificPaths(sortedPaths, (loaded, progressTotal, currentPath) => {
          setRestorationProgress({ loaded, total: progressTotal, currentPath });
        });

        logger.info('Restored expanded directories', {
          totalPaths: total,
        });
      } catch (error) {
        logger.warn('Failed to restore expanded directories', { error });
      } finally {
        // Release module-level lock
        restorationLock.inProgress = false;
        // Also update refs for backwards compatibility
        isRestoringRef.current = false;
        setIsRestoringExpandedPaths(false);
        setRestorationProgress(null);
      }
    };

    void restoreExpansions();
  }, [rootDirectoryHandle, isTreeLoading, fileTree.length, store, loadSpecificPaths]);

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
    setRootDirectoryHandle,
    loadingPaths,
    loadChildren,
    cancelChildLoading,
    refreshDirectory,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll,
    expandAllProgress,
    isRestoringExpandedPaths,
    restorationProgress,
    setAccessLoading,
    canLoadWithoutTree,
    selectFolderRecursively,
    cancelRecursiveSelect,
    isLoadingForSelection,
    loadingPathForSelection,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAll,
  };
}
