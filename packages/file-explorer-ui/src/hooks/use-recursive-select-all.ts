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
 * @module use-recursive-select-all
 */

import type { FileTreeWorkerPort, WorkerFileNode } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import { createLogger, isAbortError } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { FileSystemHandle } from '../utils/worker-node-conversion';
import { rehydrateTree } from '../utils/worker-node-conversion';

const logger = createLogger('RecursiveSelectAll');

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
 * Collect all file paths from the tree.
 */
function collectAllFilePaths(nodes: IFileNode[]): string[] {
  const paths: string[] = [];

  function traverse(nodeList: IFileNode[]): void {
    for (const node of nodeList) {
      if (node.type === 'file') {
        paths.push(node.path);
      } else if (node.type === 'directory' && node.children) {
        traverse(node.children);
      }
    }
  }

  traverse(nodes);
  return paths;
}

/**
 * Select files from paths with limit enforcement.
 */
function selectFilesWithLimit(
  allFilePaths: string[],
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
  maxSelectionCount: number
): SelectAllResult {
  if (allFilePaths.length === 0) {
    return { success: true, filePaths: [], totalAvailable: 0 };
  }

  const pathsToSelect = allFilePaths.slice(0, maxSelectionCount);

  if (pathsToSelect.length > 0) {
    addMultipleSelectedFiles(folderId, pathsToSelect);
  }

  return {
    success: true,
    filePaths: pathsToSelect,
    totalAvailable: allFilePaths.length,
    limitReached: allFilePaths.length > maxSelectionCount,
  };
}

/**
 * Handle fast path selection when tree is fully loaded.
 */
function handleFastPathSelection(
  nodes: IFileNode[],
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
  maxSelectionCount: number
): SelectAllResult {
  logger.debug('selectAllRecursively: using fast path (fully loaded)');

  const allFilePaths = collectAllFilePaths(nodes);
  return selectFilesWithLimit(allFilePaths, folderId, addMultipleSelectedFiles, maxSelectionCount);
}

/**
 * Process loaded subtree result and select files.
 */
function processLoadedTree(
  result: { tree: WorkerFileNode[]; expandedPaths: string[]; loadedCount: number },
  handleMap: Map<string, FileSystemHandle>,
  onTreeUpdate: (tree: IFileNode[]) => void,
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
  maxSelectionCount: number
): SelectAllResult {
  // Rehydrate tree with handles
  const rehydratedTree = rehydrateTree(result.tree, handleMap);

  logger.debug('selectAllRecursively: tree loaded', {
    handleMapSize: handleMap.size,
    loadedCount: result.loadedCount,
  });

  onTreeUpdate(rehydratedTree);

  // Collect all file paths from the rehydrated tree
  const allFilePaths = collectAllFilePaths(rehydratedTree);

  logger.info('selectAllRecursively: complete', {
    fileCount: allFilePaths.length,
    loadedDirectories: result.loadedCount,
  });

  return selectFilesWithLimit(allFilePaths, folderId, addMultipleSelectedFiles, maxSelectionCount);
}

/**
 * Result of precondition checks for loading tree.
 */
type PreconditionResult<T extends FileTreeWorkerPort, U extends Map<string, FileSystemHandle>> =
  | { ready: true; workerPort: T; handleMap: U }
  | { ready: false; result: SelectAllResult };

/**
 * Check preconditions for loading tree (worker and handle map availability).
 */
function checkLoadPreconditions<
  T extends FileTreeWorkerPort,
  U extends Map<string, FileSystemHandle>,
>(
  workerPortRef: React.RefObject<T | null>,
  handleMapRef: React.RefObject<U | null>,
  isStartingRef: React.RefObject<boolean>
): PreconditionResult<T, U> {
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

  if (isStartingRef.current) {
    logger.debug('selectAllRecursively: blocked by double-click guard');
    return {
      ready: false,
      result: { success: false, filePaths: [], error: 'Operation already in progress' },
    };
  }

  return { ready: true, workerPort, handleMap };
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
  /** Current file tree */
  fileTree: IFileNode[];
  /** Callback when tree is updated after subtree load */
  onTreeUpdate: (tree: IFileNode[]) => void;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
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
  /** Select all files in the entire tree, loading unloaded directories first if needed */
  selectAllRecursively: (
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
  const { workerPortRef, handleMapRef, fileTree, onTreeUpdate, onError } = options;

  // State
  const [state, setState] = useState<RecursiveSelectAllState>(RESET_STATE);

  // Guard against double-clicks
  const isStartingRef = useRef(false);

  // Ref for checking loading state in effects
  const isLoadingForSelectAllRef = useRef(false);

  /**
   * Cancel select all operation.
   */
  const cancelSelectAll = useCallback(() => {
    workerPortRef.current?.abort();
    isStartingRef.current = false;
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
        let finalResult: {
          tree: WorkerFileNode[];
          expandedPaths: string[];
          loadedCount: number;
        } | null = null;
        let totalLoadedCount = 0;

        // Load each root directory's subtree
        for (const rootNode of rootNodes) {
          if (rootNode.type !== 'directory') {
            continue;
          }

          // Check if cancelled
          if (!isLoadingForSelectAllRef.current) {
            return { success: false, filePaths: [], cancelled: true };
          }

          logger.info('selectAllRecursively: loading subtree', { path: rootNode.path });

          const result = await workerPort.loadSubtree(rootNode.path);

          // Check if cancelled after load
          if (!isLoadingForSelectAllRef.current) {
            return { success: false, filePaths: [], cancelled: true };
          }

          totalLoadedCount += result.loadedCount;
          finalResult = result;
        }

        // If we loaded anything, use the final result
        if (finalResult && totalLoadedCount > 0) {
          return processLoadedTree(
            finalResult,
            handleMap,
            onTreeUpdate,
            folderId,
            addMultipleSelectedFiles,
            maxSelectionCount
          );
        }

        // No directories needed loading - use fast path
        const allFilePaths = collectAllFilePaths(rootNodes);
        return selectFilesWithLimit(
          allFilePaths,
          folderId,
          addMultipleSelectedFiles,
          maxSelectionCount
        );
      } finally {
        unsubProgress();
      }
    },
    [onTreeUpdate]
  );

  /**
   * Select all files in the tree, loading unloaded directories first if needed.
   */
  const selectAllRecursively = useCallback(
    async (
      folderId: string,
      addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
      maxSelectionCount: number
    ): Promise<SelectAllResult> => {
      // Check if tree is empty
      if (fileTree.length === 0) {
        return { success: false, filePaths: [], error: 'No files in tree' };
      }

      // Check if tree is fully loaded → fast path
      if (isTreeFullyLoaded(fileTree)) {
        return handleFastPathSelection(
          fileTree,
          folderId,
          addMultipleSelectedFiles,
          maxSelectionCount
        );
      }

      // Need to load tree first - check preconditions
      const preconditions = checkLoadPreconditions(workerPortRef, handleMapRef, isStartingRef);
      if (!preconditions.ready) {
        return preconditions.result;
      }

      const { workerPort, handleMap } = preconditions;

      // Mark operation as starting
      isStartingRef.current = true;
      isLoadingForSelectAllRef.current = true;
      setState({
        isLoadingForSelectAll: true,
        loadingProgress: null,
      });

      try {
        const result = await loadAndSelectAll(
          workerPort,
          handleMap,
          fileTree,
          folderId,
          addMultipleSelectedFiles,
          maxSelectionCount
        );

        setState(RESET_STATE);
        return result;
      } catch (err) {
        setState(RESET_STATE);
        return handleSelectAllError(err, onError);
      } finally {
        isStartingRef.current = false;
        isLoadingForSelectAllRef.current = false;
      }
    },
    [fileTree, workerPortRef, handleMapRef, loadAndSelectAll, onError]
  );

  return {
    isLoadingForSelectAll: state.isLoadingForSelectAll,
    loadingProgress: state.loadingProgress,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAllRef,
  };
}
