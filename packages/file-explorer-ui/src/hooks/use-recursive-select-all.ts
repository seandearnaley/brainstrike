/**
 * Recursive Select All Hook
 *
 * Handles selecting all files in the entire file tree, including loading unloaded
 * directories first. Works with the file tree worker to progressively load the
 * entire tree before selection.
 *
 * This is similar to useRecursiveFolderSelect but operates on all root directories
 * instead of a single folder.
 *
 * IMPORTANT: This hook automatically applies workspace include/exclude filters when
 * used within a FileExplorerProvider context. If filterTreeFn is not explicitly
 * provided, the hook will access the store context to create its own filter function.
 *
 * @module use-recursive-select-all
 */

import type { FileTreeWorkerPort, WorkerFileNode } from '@brainstrike/file-tree-worker';
import { useFileFilters } from '@brainstrike/hooks';
import type { IFileNode } from '@brainstrike/types';
import { createLogger, isAbortError } from '@brainstrike/utils';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useOptionalFileExplorerStoreContext } from '../file-explorer-provider';
import type { FileSystemHandle } from '../utils/worker-node-conversion';
import { rehydrateTree } from '../utils/worker-node-conversion';
import {
  selectExcludeFilters,
  selectIncludeFilters,
  selectUseRegex,
} from '../utils/workspace-filter-selectors';

// Logger respects VITE_LOG_LEVEL env var - debug/info logs are suppressed in production.
// See @brainstrike/utils createLogger() for level configuration.
const logger = createLogger('RecursiveSelectAll');

/** Number of sample paths to include in log output for debugging */
const LOG_SAMPLE_SIZE = 3;

/** Threshold above which to use chunked selection to avoid blocking main thread */
const CHUNKED_SELECTION_THRESHOLD = 100;

/** Number of files to process per chunk during selection */
const SELECTION_CHUNK_SIZE = 50;

/**
 * Check if the entire tree is fully loaded (all directories have loadState 'loaded').
 */
function isTreeFullyLoaded(nodes: IFileNode[]): boolean {
  for (const node of nodes) {
    if (node.type === 'directory') {
      if (node.loadState !== 'loaded') {
        return false;
      }
      if (node.children && !isTreeFullyLoaded(node.children)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Collect all VISIBLE file paths from the tree using BREADTH-FIRST traversal.
 *
 * Key behaviors:
 * 1. Respects `isVisible` property - skips files/directories where isVisible === false
 *    (these are hidden by workspace include/exclude filters)
 * 2. Breadth-first ensures files at shallower depths (like root-level files)
 *    are collected first. This is important when a selection limit is applied
 *    because users typically want to see visible/shallow files selected first.
 *
 * Example: For a tree with root files and subdirectories, breadth-first
 * collects all root-level files first, then files one level deep, etc.
 *
 * EDGE CASE NOTE: In the slow path (loadDirectoriesFromTree), workspace filters
 * are applied AFTER tree loading via filterTreeFn. If filters restructure the tree
 * by hiding root directories but exposing deep nested files, those deep files may
 * appear earlier in the queue than expected. This is acceptable because:
 * 1. The filtered tree represents what the user actually sees in the UI
 * 2. Breadth-first still respects the structure of the filtered tree
 * 3. The alternative (filtering during load) would require deep integration changes
 */
function collectAllFilePaths(nodes: IFileNode[]): string[] {
  const paths: string[] = [];
  const queue: IFileNode[] = [...nodes];

  // Use index-based iteration instead of shift() for O(1) dequeue performance.
  // Array.shift() is O(n) due to re-indexing; index tracking avoids this overhead
  // which matters for large trees (10k+ nodes).
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const node = queue[queueIndex++];
    // Type guard for undefined (shouldn't happen with index bounds)
    if (!node) {
      continue;
    }

    // Skip nodes hidden by workspace filters (isVisible === false)
    if (node.isVisible === false) {
      continue;
    }

    if (node.type === 'file') {
      paths.push(node.path);
    } else if (node.type === 'directory' && node.children) {
      // Add children to the END of the queue (breadth-first)
      queue.push(...node.children);
    }
  }

  return paths;
}

/**
 * Yield to the browser to keep UI responsive during large operations.
 * Uses requestAnimationFrame for smooth visual updates.
 */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Select files from paths with limit enforcement.
 * Uses chunked processing for large selections to avoid blocking the main thread.
 */
async function selectFilesWithLimit(
  allFilePaths: string[],
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
  maxSelectionCount: number
): Promise<SelectAllResult> {
  if (allFilePaths.length === 0) {
    logger.debug('selectFilesWithLimit: no files to select');
    return { success: true, filePaths: [], totalAvailable: 0 };
  }

  const pathsToSelect = allFilePaths.slice(0, maxSelectionCount);

  logger.debug('selectFilesWithLimit: selecting files', {
    totalFiles: allFilePaths.length,
    selectingCount: pathsToSelect.length,
    folderId,
    samplePaths: pathsToSelect.slice(0, LOG_SAMPLE_SIZE),
  });

  if (pathsToSelect.length > 0) {
    // Use chunked processing for large selections to avoid blocking main thread
    if (pathsToSelect.length > CHUNKED_SELECTION_THRESHOLD) {
      logger.debug('selectFilesWithLimit: using chunked selection', {
        totalPaths: pathsToSelect.length,
        chunkSize: SELECTION_CHUNK_SIZE,
        estimatedChunks: Math.ceil(pathsToSelect.length / SELECTION_CHUNK_SIZE),
      });

      for (let i = 0; i < pathsToSelect.length; i += SELECTION_CHUNK_SIZE) {
        const chunk = pathsToSelect.slice(i, i + SELECTION_CHUNK_SIZE);
        addMultipleSelectedFiles(folderId, chunk);

        // Yield to browser between chunks (except for last chunk)
        if (i + SELECTION_CHUNK_SIZE < pathsToSelect.length) {
          await yieldToBrowser();
        }
      }
    } else {
      // Small selection - process synchronously
      addMultipleSelectedFiles(folderId, pathsToSelect);
    }
  }

  return {
    success: true,
    filePaths: pathsToSelect,
    totalAvailable: allFilePaths.length,
    limitReached: allFilePaths.length > maxSelectionCount,
  };
}

/**
 * Process loaded subtree result and select files.
 *
 * Applies workspace filters to the loaded tree before collecting file paths.
 * This ensures that include/exclude patterns are respected even in the slow path
 * where the worker returns the full unfiltered tree.
 */
async function processLoadedTree(
  result: { tree: WorkerFileNode[]; expandedPaths: string[]; loadedCount: number },
  handleMap: Map<string, FileSystemHandle>,
  onTreeUpdate: (tree: IFileNode[]) => void,
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
  maxSelectionCount: number,
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[]
): Promise<SelectAllResult> {
  // Rehydrate tree with handles
  const rehydratedTree = rehydrateTree(result.tree, handleMap);

  logger.debug('selectAllRecursively: tree loaded', {
    handleMapSize: handleMap.size,
    loadedCount: result.loadedCount,
  });

  // Use startTransition to make tree update non-urgent - React can interrupt
  // and yield to browser for user input during large tree renders
  startTransition(() => {
    onTreeUpdate(rehydratedTree);
  });

  // Apply workspace filters to the loaded tree before collecting file paths
  // This ensures include/exclude patterns (e.g., *.ts, .turbo) are respected
  const treeForSelection = filterTreeFn ? filterTreeFn(rehydratedTree) : rehydratedTree;

  // Collect all file paths from the filtered tree
  const allFilePaths = collectAllFilePaths(treeForSelection);

  logger.info('selectAllRecursively: complete', {
    fileCount: allFilePaths.length,
    loadedDirectories: result.loadedCount,
    filtered: !!filterTreeFn,
  });

  return await selectFilesWithLimit(
    allFilePaths,
    folderId,
    addMultipleSelectedFiles,
    maxSelectionCount
  );
}

/**
 * Result of precondition checks for loading tree.
 *
 * Simplified from generic type - concrete types provide equivalent safety
 * since we only use FileTreeWorkerPort and FileSystemHandle Map in practice.
 */
type PreconditionResult =
  | { ready: true; workerPort: FileTreeWorkerPort; handleMap: Map<string, FileSystemHandle> }
  | { ready: false; result: SelectAllResult };

/**
 * Check preconditions for loading tree (worker and handle map availability).
 */
function checkLoadPreconditions(
  workerPortRef: React.RefObject<FileTreeWorkerPort | null>,
  handleMapRef: React.RefObject<Map<string, FileSystemHandle> | null>,
  isOperationInProgressRef: React.RefObject<boolean>
): PreconditionResult {
  const workerPort = workerPortRef.current;
  const handleMap = handleMapRef.current;

  if (!workerPort) {
    return { ready: false, result: { success: false, filePaths: [], error: 'Worker not ready' } };
  }

  if (!handleMap) {
    return {
      ready: false,
      result: { success: false, filePaths: [], error: 'Handle map not ready' },
    };
  }

  if (isOperationInProgressRef.current) {
    logger.debug('selectAllRecursively: blocked by double-click guard');
    return {
      ready: false,
      result: { success: false, filePaths: [], error: 'Operation already in progress' },
    };
  }

  return { ready: true, workerPort, handleMap };
}

/**
 * Result of loading directories for select all.
 */
interface DirectoryLoadResult {
  /** The final loaded tree result (last successful load) */
  finalResult: {
    tree: WorkerFileNode[];
    expandedPaths: string[];
    loadedCount: number;
  } | null;
  /** Total count of loaded directories across all calls */
  totalLoadedCount: number;
  /** Number of directories successfully loaded */
  loadedDirectories: number;
  /** Total number of directories attempted */
  totalDirectories: number;
  /** Last error encountered (null if no errors) */
  loadError: Error | null;
  /** Whether the operation was cancelled */
  cancelled: boolean;
}

/**
 * Load all directories in the tree via the worker.
 *
 * Handles partial failures gracefully - continues loading other directories
 * even if some fail. Returns aggregate results for further processing.
 */
async function loadDirectoriesFromTree(
  rootNodes: IFileNode[],
  workerPort: FileTreeWorkerPort,
  isLoadingRef: React.RefObject<boolean>
): Promise<DirectoryLoadResult> {
  let finalResult: DirectoryLoadResult['finalResult'] = null;
  let totalLoadedCount = 0;
  let loadError: Error | null = null;
  let loadedDirectories = 0;
  const totalDirectories = rootNodes.filter((n) => n.type === 'directory').length;

  for (const rootNode of rootNodes) {
    if (rootNode.type !== 'directory') {
      continue;
    }

    // Check if cancelled
    if (!isLoadingRef.current) {
      return {
        finalResult,
        totalLoadedCount,
        loadedDirectories,
        totalDirectories,
        loadError,
        cancelled: true,
      };
    }

    logger.info('selectAllRecursively: loading subtree', { path: rootNode.path });

    try {
      const result = await workerPort.loadSubtree(rootNode.path);

      // Check if cancelled after load
      if (!isLoadingRef.current) {
        return {
          finalResult,
          totalLoadedCount,
          loadedDirectories,
          totalDirectories,
          loadError,
          cancelled: true,
        };
      }

      totalLoadedCount += result.loadedCount;
      finalResult = result;
      loadedDirectories++;
    } catch (err) {
      // Log error but continue with partial results
      logger.warn('selectAllRecursively: failed to load subtree', {
        path: rootNode.path,
        error: err instanceof Error ? err.message : String(err),
        loadedSoFar: loadedDirectories,
        totalDirectories,
      });
      loadError = err instanceof Error ? err : new Error(String(err));
      // Continue to next directory - we'll use partial results
    }
  }

  return {
    finalResult,
    totalLoadedCount,
    loadedDirectories,
    totalDirectories,
    loadError,
    cancelled: false,
  };
}

/**
 * Log why no loading was needed.
 */
function logNoLoadingNeeded(rootNodes: IFileNode[]): void {
  const directoryCount = rootNodes.filter((n) => n.type === 'directory').length;
  if (directoryCount === 0) {
    logger.debug('selectAllRecursively: all root nodes are files, no directories to load', {
      rootNodeCount: rootNodes.length,
    });
  } else {
    logger.debug('selectAllRecursively: all directories already loaded', {
      directoryCount,
      rootNodeCount: rootNodes.length,
    });
  }
}

/**
 * Handle error in select all operation.
 */
function handleSelectAllError(err: unknown, onError?: (error: Error) => void): SelectAllResult {
  const isCancelled = isAbortError(err);

  if (!isCancelled) {
    logger.error('selectAllRecursively: error', {
      error: err instanceof Error ? err.message : String(err),
    });
    onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    success: false,
    filePaths: [],
    cancelled: isCancelled,
    error: err instanceof Error ? err.message : String(err),
  };
}

export interface RecursiveSelectAllState {
  isLoadingForSelectAll: boolean;
  loadingProgress: { loaded: number; total: number } | null;
}

export interface UseRecursiveSelectAllOptions {
  /** Ref to worker port for loadSubtree commands */
  workerPortRef: React.RefObject<FileTreeWorkerPort | null>;
  /** Ref to handle map for rehydrating worker tree */
  handleMapRef: React.RefObject<Map<string, FileSystemHandle>>;
  /** Callback when tree is updated after subtree load */
  onTreeUpdate: (tree: IFileNode[]) => void;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
  /**
   * Filter function to apply workspace include/exclude filters to a tree.
   * Called on the loaded tree in the slow path to ensure workspace filters are respected.
   */
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];
}

export interface SelectAllResult {
  /** Whether the operation was successful */
  success: boolean;
  /** File paths that were selected */
  filePaths: string[];
  /** Total files available (before limit applied) */
  totalAvailable?: number;
  /** Whether the selection limit was reached */
  limitReached?: boolean;
  /** Whether the operation was cancelled */
  cancelled?: boolean;
  /** Error message if failed */
  error?: string;
}

export interface UseRecursiveSelectAllReturn {
  /** Whether the tree is being loaded for select all */
  isLoadingForSelectAll: boolean;
  /** Loading progress (if available) */
  loadingProgress: { loaded: number; total: number } | null;
  /**
   * Select all files in the provided tree, loading unloaded directories first if needed.
   *
   * IMPORTANT: Pass the FILTERED tree (e.g., quickFilteredTree) to respect workspace
   * include/exclude filters. The hook operates only on nodes in the provided tree.
   *
   * @param filteredTree - The filtered file tree to select from (pass quickFilteredTree)
   * @param folderId - The folder ID for encoding file selections
   * @param addMultipleSelectedFiles - Store action to add selected files
   * @param maxSelectionCount - Maximum number of files to select
   */
  selectAllRecursively: (
    filteredTree: IFileNode[],
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number
  ) => Promise<SelectAllResult>;
  /** Cancel the current select all operation */
  cancelSelectAll: () => void;
  /** Ref to check if loading is active (for use in effects) */
  isLoadingForSelectAllRef: React.RefObject<boolean>;
}

const RESET_STATE: RecursiveSelectAllState = {
  isLoadingForSelectAll: false,
  loadingProgress: null,
};

/**
 * Hook for managing recursive select all with lazy loading.
 *
 * When selecting all:
 * 1. If tree is fully loaded → use fast path (collect all file paths)
 * 2. If not fully loaded → load all directories via worker, then select
 *
 * @param options - Configuration options
 * @returns Recursive select all state and controls
 */
export function useRecursiveSelectAll(
  options: UseRecursiveSelectAllOptions
): UseRecursiveSelectAllReturn {
  const { workerPortRef, handleMapRef, onTreeUpdate, onError, filterTreeFn } = options;

  // Access store context for workspace filters (optional - may be null outside FileExplorerProvider)
  const store = useOptionalFileExplorerStoreContext();

  // Get filter settings from store if available
  const includeFilters = store?.(selectIncludeFilters) ?? [];
  const excludeFilters = store?.(selectExcludeFilters) ?? [];
  const useRegex = store?.(selectUseRegex) ?? false;

  // Get the filter implementation
  const { applyFileFilters } = useFileFilters();

  // Create internal filter function from store context if filterTreeFn not provided.
  // This ensures workspace filters are applied in the slow path even when this hook
  // is used via the shared FileTreeProvider (which doesn't pass filterTreeFn).
  const internalFilterTreeFn = useMemo(() => {
    if (filterTreeFn) {
      // Use provided filterTreeFn (from use-file-explorer-context's local tree state)
      return filterTreeFn;
    }
    if (store) {
      // Create filter function from store context
      return (tree: IFileNode[]) =>
        applyFileFilters(tree, includeFilters, excludeFilters, useRegex);
    }
    // No filter available - return identity function
    return undefined;
  }, [filterTreeFn, store, applyFileFilters, includeFilters, excludeFilters, useRegex]);

  // State
  const [state, setState] = useState<RecursiveSelectAllState>(RESET_STATE);

  // LOADING STATE MANAGEMENT - Three complementary mechanisms:
  //
  // 1. isOperationInProgressRef: Guards against rapid clicks during the SYNC phase
  //    before async loading starts. Set true immediately on entry, cleared on exit.
  //    Used by checkLoadPreconditions() to reject overlapping operations.
  //
  // 2. isLoadingForSelectAllRef: Tracks the ASYNC loading phase for cancellation
  //    detection. Checked inside the loading loop to detect if user cancelled.
  //    Also used by cleanup effect to abort on unmount.
  //
  // 3. state.isLoadingForSelectAll: UI state for the button to show "Selecting..."
  //    and enable cancel behavior. Triggers re-renders for user feedback.
  //
  // All three are necessary: refs for sync/cancellation checks (no re-render cost),
  // state for UI updates. Consolidating would either add unnecessary renders or
  // lose the cancellation capability.

  // Guard against rapid clicks - prevents starting a new operation while one is initializing
  const isOperationInProgressRef = useRef(false);

  // Ref for checking loading state in effects and cancellation detection
  const isLoadingForSelectAllRef = useRef(false);

  /**
   * Cancel select all operation.
   */
  const cancelSelectAll = useCallback(() => {
    workerPortRef.current?.abort();
    isOperationInProgressRef.current = false;
    isLoadingForSelectAllRef.current = false;
    setState(RESET_STATE);
  }, [workerPortRef]);

  /**
   * Cleanup on unmount - abort any in-progress operations.
   */
  useEffect(() => {
    return () => {
      if (isLoadingForSelectAllRef.current) {
        logger.debug('useRecursiveSelectAll: cleaning up on unmount');
        workerPortRef.current?.abort();
      }
    };
  }, [workerPortRef]);

  /**
   * Load all directories and select files.
   *
   * Applies workspace filters to the loaded tree via internalFilterTreeFn to ensure
   * include/exclude patterns are respected in the slow path.
   */
  const loadAndSelectAll = useCallback(
    async (
      workerPort: FileTreeWorkerPort,
      handleMap: Map<string, FileSystemHandle>,
      rootNodes: IFileNode[],
      folderId: string,
      addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
      maxSelectionCount: number
    ): Promise<SelectAllResult> => {
      // Set up progress handler
      const unsubProgress = workerPort.onProgress((loaded, total) => {
        setState((s) => ({ ...s, loadingProgress: { loaded, total } }));
      });

      try {
        // Load directories using extracted helper
        const loadResult = await loadDirectoriesFromTree(
          rootNodes,
          workerPort,
          isLoadingForSelectAllRef
        );

        // Handle cancellation
        if (loadResult.cancelled) {
          return { success: false, filePaths: [], cancelled: true };
        }

        const { finalResult, totalLoadedCount, loadedDirectories, totalDirectories, loadError } =
          loadResult;

        // Log if we had partial failures
        if (loadError && loadedDirectories > 0) {
          logger.info('selectAllRecursively: proceeding with partial results', {
            loadedDirectories,
            totalDirectories,
            failedCount: totalDirectories - loadedDirectories,
          });
        }

        // If we loaded anything, process with filtering
        if (finalResult && totalLoadedCount > 0) {
          return await processLoadedTree(
            finalResult,
            handleMap,
            onTreeUpdate,
            folderId,
            addMultipleSelectedFiles,
            maxSelectionCount,
            internalFilterTreeFn
          );
        }

        // No directories needed loading - rootNodes is already filtered (passed in as filteredTree)
        // Log why we're falling through to direct selection
        logNoLoadingNeeded(rootNodes);

        const allFilePaths = collectAllFilePaths(rootNodes);

        return await selectFilesWithLimit(
          allFilePaths,
          folderId,
          addMultipleSelectedFiles,
          maxSelectionCount
        );
      } finally {
        unsubProgress();
      }
    },
    [onTreeUpdate, internalFilterTreeFn]
  );

  /**
   * Select all files in the provided tree, loading unloaded directories first if needed.
   *
   * IMPORTANT: Pass the FILTERED tree (quickFilteredTree) to respect workspace filters.
   * The function operates only on nodes in the provided tree, so excluded directories
   * won't be traversed or loaded.
   */
  const selectAllRecursively = useCallback(
    async (
      filteredTree: IFileNode[],
      folderId: string,
      addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
      maxSelectionCount: number
    ): Promise<SelectAllResult> => {
      logger.info('selectAllRecursively: starting', {
        folderId,
        maxSelectionCount,
        treeNodeCount: filteredTree.length,
        isFullyLoaded: isTreeFullyLoaded(filteredTree),
      });

      // Check if tree is empty
      if (filteredTree.length === 0) {
        logger.warn('selectAllRecursively: tree is empty');
        return { success: false, filePaths: [], error: 'No files in tree' };
      }

      // Check if tree is fully loaded → fast path
      if (isTreeFullyLoaded(filteredTree)) {
        // Collect all file paths from the filtered tree (already respects workspace filters)
        const allFilePaths = collectAllFilePaths(filteredTree);

        logger.info('selectAllRecursively: using fast path (fully loaded)', {
          folderId,
          nodeCount: filteredTree.length,
          fileCount: allFilePaths.length,
          samplePaths: allFilePaths.slice(0, LOG_SAMPLE_SIZE),
        });

        const result = await selectFilesWithLimit(
          allFilePaths,
          folderId,
          addMultipleSelectedFiles,
          maxSelectionCount
        );

        // CRITICAL: Force tree re-render by triggering a tree state update.
        // The virtualized list's renderedRows memo doesn't depend on selectedFilePaths,
        // so Zustand subscription updates alone don't trigger row re-renders.
        // Creating a shallow copy forces the tree state to change, which invalidates
        // the memo and causes rows to re-render with updated selection state.
        //
        // NOTE: Using startTransition makes this update non-urgent, allowing React to
        // interrupt and yield to browser for user input during large tree renders.
        // This prevents the UI from freezing when selecting 1000+ files.
        if (result.success && result.filePaths.length > 0) {
          // Yield to browser before triggering final tree re-render
          await yieldToBrowser();
          startTransition(() => {
            onTreeUpdate([...filteredTree]);
          });
        }

        return result;
      }

      // Need to load tree first - check preconditions
      const preconditions = checkLoadPreconditions(
        workerPortRef,
        handleMapRef,
        isOperationInProgressRef
      );
      if (!preconditions.ready) {
        return preconditions.result;
      }

      const { workerPort, handleMap } = preconditions;

      // Mark operation as starting
      isOperationInProgressRef.current = true;
      isLoadingForSelectAllRef.current = true;
      setState({
        isLoadingForSelectAll: true,
        loadingProgress: null,
      });

      try {
        // Load and select from the filtered tree - only visible directories will be processed
        const result = await loadAndSelectAll(
          workerPort,
          handleMap,
          filteredTree,
          folderId,
          addMultipleSelectedFiles,
          maxSelectionCount
        );

        // Wait for deferred renders to settle before hiding the indicator.
        // The tree update uses startTransition which defers rendering - we need to
        // ensure at least 2 paint cycles have occurred so the virtual list has
        // time to render with the new content before the indicator disappears.
        await yieldToBrowser();
        await yieldToBrowser();

        setState(RESET_STATE);
        return result;
      } catch (err) {
        // Allow any partial renders to settle before hiding indicator
        await yieldToBrowser();
        setState(RESET_STATE);
        return handleSelectAllError(err, onError);
      } finally {
        isOperationInProgressRef.current = false;
        isLoadingForSelectAllRef.current = false;
      }
    },
    [workerPortRef, handleMapRef, loadAndSelectAll, onError, onTreeUpdate]
  );

  return {
    isLoadingForSelectAll: state.isLoadingForSelectAll,
    loadingProgress: state.loadingProgress,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAllRef,
  };
}
