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
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { AddMultipleSelectedFilesChunked } from '../hooks/recursive-selection-utils';
import { useOptionalFileTreeContext } from '../tree/file-tree-provider';
import { type LoadingProgressState, useFileTree } from '../tree/use-file-tree-context';
import {
  type RestorationProgress,
  useExpandedPathRestoration,
} from '../use-expanded-path-restoration';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';
import { getRootFolderId } from '../utils/get-root-folder-id';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { useFileSystem } from './use-file-system-context';

const logger = createLogger('FileExplorerContext');

const selectIncludeFilters = (state: FileExplorerState) => state.includeFilters;
const selectExcludeFilters = (state: FileExplorerState) => state.excludeFilters;
const selectUseRegex = (state: FileExplorerState) => state.useRegex;
const selectSetFilters = (state: FileExplorerState) => state.setFilters;
const selectSetUseRegex = (state: FileExplorerState) => state.setUseRegex;
const selectClearFileContents = (state: FileExplorerState) => state.clearFileContents;
const selectClearSelectedFiles = (state: FileExplorerState) => state.clearSelectedFiles;
const selectSetExpandedPaths = (state: FileExplorerState) => state.setExpandedPaths;
const selectSelectedFilePaths = (state: FileExplorerState) => state.selectedFilePaths;
const selectExpandedDirectoryPaths = (state: FileExplorerState) => state.expandedDirectoryPaths;
const selectSelectionVersion = (state: FileExplorerState) => state.selectionVersion;
const selectIsAccessLoading = (state: FileExplorerState) => state.isAccessLoading;
const selectSetIsAccessLoading = (state: FileExplorerState) => state.setIsAccessLoading;
const selectDisabledIncludeFilters = (state: FileExplorerState) => state.disabledIncludeFilters;
const selectDisabledExcludeFilters = (state: FileExplorerState) => state.disabledExcludeFilters;

type UseFileExplorerProps = Record<string, never>;

interface UseFileExplorerReturn {
  applyFileFilters: (
    includeFilters: string[],
    excludeFilters: string[],
    useRegex: boolean
  ) => IFileNode[];
  /** Cancel loading for a specific directory (e.g., on collapse) */
  cancelChildLoading: (path: string) => void;
  /** Cancel expand-all operation */
  cancelExpandAll: () => void;
  /** Whether the current operation can be cancelled */
  cancellable: boolean;
  /** Cancel the current loading operation */
  cancelOperation: () => void;
  /** Cancel the current recursive selection operation */
  cancelRecursiveSelect: () => void;
  /** Cancel the current select all operation */
  cancelSelectAll: () => void;
  /**
   * Whether files can be loaded without a file tree (Electron with readFileByPath).
   * When true, tab content loading can proceed even before the tree is loaded.
   */
  canLoadWithoutTree: boolean;
  clearFileContents: (compositeKeys: string[]) => void;
  clearRootDirectory: () => void;
  error: Error | null;
  /** Progress of expand-all operation */
  expandAllProgress: { loaded: number; total: number } | null;
  /** Progressively expand all directories (loads everything) */
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
    currentExpandedPaths?: ReadonlySet<string>
  ) => Promise<void>;
  fileContents: { [path: string]: string };
  /** Filtered tree currently visible in the explorer */
  fileTree: IFileNode[];
  filterError: string | null;
  handleRootDirectorySelect: () => Promise<DirectoryHandle | null>;
  /** Whether the operation is currently being cancelled */
  isCancelling: boolean;
  /** Whether expand-all is in progress */
  isExpandingAll: boolean;
  isFileSystemAccessSupported: () => { supported: boolean; reason: string };
  isInitialLoad: boolean;
  isLoading: boolean;
  /** Whether the tree is being loaded for select all */
  isLoadingForSelectAll: boolean;
  /** Whether a subtree is being loaded for selection */
  isLoadingForSelection: boolean;
  /** Whether expanded directories are being restored from persisted state */
  isRestoringExpandedPaths: boolean;
  /** Load children of a directory on expand (lazy loading) */
  loadChildren: (path: string) => Promise<void>;
  loadFileContent: (path: string) => Promise<void>;
  loadingFiles: Set<string>;
  /** Path of the folder being loaded for selection (if any) */
  loadingPathForSelection: string | null;
  /** Set of paths currently loading their children (lazy loading) */
  loadingPaths: Set<string>;
  loadingProgress: LoadingProgressState | null;
  /** Load content for multiple files at once (batch loading for report generation) */
  loadMultipleFileContents: (compositeKeys: string[]) => Promise<void>;
  /** Refresh a specific directory */
  refreshDirectory: (path: string) => Promise<void>;
  refreshFileExplorer: () => Promise<void>;
  /** Progress of expanded directory restoration */
  restorationProgress: RestorationProgress | null;
  rootDirectoryHandle: DirectoryHandle | null;
  /**
   * Select all files in the provided tree, loading if needed.
   * IMPORTANT: Pass the FILTERED tree (quickFilteredTree) to respect workspace filters.
   */
  selectAllRecursively: (
    filteredTree: IFileNode[],
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
  ) => Promise<{
    success: boolean;
    filePaths: string[];
    totalAvailable?: number;
    limitReached?: boolean;
    cancelled?: boolean;
    error?: string;
  }>;
  /** Select all files in a folder recursively, loading if needed */
  selectFolderRecursively: (
    node: IFileNode,
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    currentSelectionSize: number,
    currentDirectorySelectionSize?: number,
    addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
  ) => Promise<{ success: boolean; filePaths: string[]; cancelled?: boolean; error?: string }>;
  /**
   * Set the access loading state.
   * Used by restore flow to signal that a restore is in progress, which
   * prevents the stale state clearing effect from clearing expanded paths
   * while waiting for browser permission dialog.
   */
  setAccessLoading: (loading: boolean) => void;
  /** Set root directory handle from external source (e.g., restore banner) */
  setRootDirectoryHandle: (handle: DirectoryHandle | null) => void;
  /** Unfiltered tree from the file-system source */
  unfilteredFileTree?: IFileNode[];
}

export type { RestorationProgress } from '../use-expanded-path-restoration';
export { __resetRestorationLock } from '../use-expanded-path-restoration';

export function useFileExplorer(_: UseFileExplorerProps = {}): UseFileExplorerReturn {
  const store = useFileExplorerStoreContext();
  const includeFilters = useFileExplorerStoreSelector(selectIncludeFilters);
  const excludeFilters = useFileExplorerStoreSelector(selectExcludeFilters);
  const useRegex = useFileExplorerStoreSelector(selectUseRegex);
  const disabledIncludeFilters = useFileExplorerStoreSelector(selectDisabledIncludeFilters);
  const disabledExcludeFilters = useFileExplorerStoreSelector(selectDisabledExcludeFilters);

  // Compute active filters by excluding disabled ones
  const activeIncludeFilters = useMemo(
    () => includeFilters.filter((f) => !disabledIncludeFilters.has(f)),
    [includeFilters, disabledIncludeFilters]
  );
  const activeExcludeFilters = useMemo(
    () => excludeFilters.filter((f) => !disabledExcludeFilters.has(f)),
    [excludeFilters, disabledExcludeFilters]
  );

  // Defer filter values to prevent UI blocking during expensive tree filtering.
  // useDeferredValue allows React to show the old tree while filtering in background.
  // This is critical for large trees (180K+ files) where filtering takes 1-2 seconds.
  const deferredIncludeFilters = useDeferredValue(activeIncludeFilters);
  const deferredExcludeFilters = useDeferredValue(activeExcludeFilters);
  const deferredUseRegex = useDeferredValue(useRegex);
  const setFilters = useFileExplorerStoreSelector(selectSetFilters);
  const setUseRegex = useFileExplorerStoreSelector(selectSetUseRegex);
  const storeClearFileContents = useFileExplorerStoreSelector(selectClearFileContents);
  const clearSelectedFiles = useFileExplorerStoreSelector(selectClearSelectedFiles);
  const setExpandedPaths = useFileExplorerStoreSelector(selectSetExpandedPaths);
  // Subscribe to these values so effect fires when store rehydrates
  const selectedFilePaths = useFileExplorerStoreSelector(selectSelectedFilePaths);
  const expandedDirectoryPaths = useFileExplorerStoreSelector(selectExpandedDirectoryPaths);
  const selectionVersion = useFileExplorerStoreSelector(selectSelectionVersion);
  // Use isAccessLoading from store (shared state, not local hook state)
  const storeIsAccessLoading = useFileExplorerStoreSelector(selectIsAccessLoading);
  const setIsAccessLoading = useFileExplorerStoreSelector(selectSetIsAccessLoading);

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

  // Get file filters BEFORE useFileTree so we can pass filterTreeFn
  // This is critical for the slow path in selectAllRecursively to respect workspace filters
  const { applyFileFilters: applyFiltersUtil, filterError: localFilterError } = useFileFilters();

  // Create a memoized filter function for the slow path in selectAllRecursively.
  // This function is called when the worker returns an unfiltered tree after loading directories.
  // It ensures workspace include/exclude filters are applied before file selection.
  // Uses activeIncludeFilters/activeExcludeFilters to respect disabled filter toggles.
  const filterTreeFn = useCallback(
    (tree: IFileNode[]) =>
      applyFiltersUtil(tree, activeIncludeFilters, activeExcludeFilters, useRegex),
    [applyFiltersUtil, activeIncludeFilters, activeExcludeFilters, useRegex]
  );

  // Try to get shared tree state from FileTreeProvider context.
  // This ensures all components using useFileExplorer share the same tree
  // after expand-all completes - fixing the "file not found" bug.
  const sharedTreeContext = useOptionalFileTreeContext();

  // Always call useFileTree to maintain hook order (rules of hooks).
  // When sharedTreeContext is available, we use its values instead.
  // Pass filterTreeFn to ensure workspace filters are respected in the slow path.
  const localTreeState = useFileTree(rootDirectoryHandle, { filterTreeFn });

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

  // Unify filtered tree computation in useMemo to avoid state/effect complexity
  // Note: applyFiltersUtil is now obtained earlier to pass filterTreeFn to useFileTree
  // Uses DEFERRED filter values to prevent UI blocking on large trees (180K+ files).
  // React will show the old tree immediately while filtering happens in background,
  // then swap to the new filtered tree when complete.
  const filteredTree = useMemo(() => {
    if (fileTree.length > 0) {
      return applyFiltersUtil(
        fileTree,
        deferredIncludeFilters,
        deferredExcludeFilters,
        deferredUseRegex
      );
    }
    return [];
  }, [
    fileTree,
    deferredIncludeFilters,
    deferredExcludeFilters,
    deferredUseRegex,
    applyFiltersUtil,
  ]);

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
  const isInitialLoad = Boolean(rootDirectoryHandle) && isTreeLoading;
  const currentRootFolderId = getRootFolderId(rootDirectoryHandle);

  // Track the stale clearing timer ID so we can cancel it from outside the effect
  const staleClearingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentRootFolderIdRef = useRef<string | null>(currentRootFolderId);

  useLayoutEffect(() => {
    currentRootFolderIdRef.current = currentRootFolderId;
  }, [currentRootFolderId]);

  useLayoutEffect(() => {
    if (!(isAccessLoading && staleClearingTimerRef.current !== null)) {
      return;
    }
    logger.debug('Cancelling stale clearing timer - isAccessLoading became true');
    clearTimeout(staleClearingTimerRef.current);
    staleClearingTimerRef.current = null;
  }, [isAccessLoading]);

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
    if (currentRootFolderId) {
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
      if (currentRootFolderIdRef.current) {
        logger.debug('Skipping stale clearing - root directory restored before timer fired', {
          folderId: currentRootFolderIdRef.current,
        });
        return;
      }
      if (getRootFolderId(currentStoreState.rootDirectoryHandle)) {
        logger.debug('Skipping stale clearing - root directory handle restored before timer fired');
        return;
      }
      const recoverableFolderId = currentStoreState.currentFolderId;
      if (recoverableFolderId && currentStoreState.folderStates[recoverableFolderId]) {
        logger.debug('Skipping stale clearing - persisted folder state can be restored', {
          folderId: recoverableFolderId,
        });
        return;
      }

      const currentHasStaleSelection = currentStoreState.selectedFilePaths.size > 0;
      const currentHasStaleExpansion = currentStoreState.expandedDirectoryPaths.size > 0;

      logger.info('Clearing stale file explorer state - no root directory handle', {
        staleSelectedFiles: currentStoreState.selectedFilePaths.size,
        staleExpandedPaths: currentStoreState.expandedDirectoryPaths.size,
      });

      if (currentHasStaleSelection) {
        clearSelectedFiles();
      }
      if (currentHasStaleExpansion) {
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
    currentRootFolderId,
    isAccessLoading,
    isTreeLoading,
    selectedFilePaths,
    expandedDirectoryPaths,
    clearSelectedFiles,
    setExpandedPaths,
  ]);

  const localRestorationState = useExpandedPathRestoration({
    currentRootFolderId,
    disabled: sharedTreeContext !== null,
    fileTree,
    isTreeLoading,
    loadSpecificPaths,
    restorationKey: `selection:${selectionVersion}`,
    setExpandedPaths,
    store,
  });
  const isRestoringExpandedPaths =
    sharedTreeContext?.isRestoringExpandedPaths ?? localRestorationState.isRestoringExpandedPaths;
  const restorationProgress =
    sharedTreeContext?.restorationProgress ?? localRestorationState.restorationProgress;

  return {
    fileTree: filteredTree,
    unfilteredFileTree: fileTree,
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
