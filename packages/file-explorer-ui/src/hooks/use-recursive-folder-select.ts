/**
 * Recursive Folder Select Hook
 *
 * Handles selecting all files within a folder, including loading unloaded children first.
 * Works with the file tree worker to progressively load directories before selection.
 *
 * @module use-recursive-folder-select
 */

import type { FileTreeWorkerPort, WorkerFileNode } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import { createLogger, fileExplorer, isAbortError } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { FileSystemHandle } from '../utils/worker-node-conversion';
import { rehydrateTree } from '../utils/worker-node-conversion';

const logger = createLogger('RecursiveFolderSelect');

/**
 * WeakMap cache for isFolderFullyLoaded results.
 * Using WeakMap ensures cache entries are garbage collected when nodes are no longer referenced.
 * The cache is invalidated naturally when nodes are replaced (new object references).
 */
const folderLoadedCache = new WeakMap<IFileNode, boolean>();

/**
 * Check if a folder is fully loaded (all descendants have loadState 'loaded').
 * Results are cached per node reference for performance on large trees.
 */
function isFolderFullyLoaded(node: IFileNode): boolean {
  if (node.type !== 'directory') {
    return true;
  }
  if (node.loadState !== 'loaded') {
    return false;
  }
  if (!node.children) {
    return false;
  }

  // Check cache first
  const cached = folderLoadedCache.get(node);
  if (cached !== undefined) {
    return cached;
  }

  // Compute and cache result
  const result = node.children.every(
    (child) => child.type !== 'directory' || isFolderFullyLoaded(child)
  );
  folderLoadedCache.set(node, result);
  return result;
}

/**
 * Find a node by path in a tree.
 */
function findNodeByPath(nodes: IFileNode[], path: string): IFileNode | null {
  for (const n of nodes) {
    if (n.path === path) {
      return n;
    }
    if (n.children) {
      const found = findNodeByPath(n.children, path);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Select files from paths with limit enforcement.
 */
function selectFilesWithLimit(
  allFilePaths: string[],
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
  maxSelectionCount: number,
  currentSelectionSize: number
): SelectionResult {
  if (allFilePaths.length === 0) {
    return { success: true, filePaths: [] };
  }

  const availableSlots = maxSelectionCount - currentSelectionSize;
  const pathsToSelect = allFilePaths.slice(0, availableSlots);

  if (pathsToSelect.length > 0) {
    addMultipleSelectedFiles(folderId, pathsToSelect);
  }

  return { success: true, filePaths: pathsToSelect };
}

/**
 * Handle fast path selection when folder is fully loaded.
 */
function handleFastPathSelection(
  node: IFileNode,
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
  maxSelectionCount: number,
  currentSelectionSize: number
): SelectionResult {
  logger.debug('selectFolderRecursively: using fast path (fully loaded)', {
    path: node.path,
  });

  const allFilePaths = fileExplorer.getAllFilePathsInDirectory(node);
  return selectFilesWithLimit(
    allFilePaths,
    folderId,
    addMultipleSelectedFiles,
    maxSelectionCount,
    currentSelectionSize
  );
}

/**
 * Process loaded subtree and select files.
 */
function processLoadedSubtree(
  result: { tree: WorkerFileNode[]; expandedPaths: string[]; loadedCount: number },
  handleMap: Map<string, FileSystemHandle>,
  onTreeUpdate: (tree: IFileNode[]) => void,
  nodePath: string,
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
  maxSelectionCount: number,
  currentSelectionSize: number
): SelectionResult {
  // Rehydrate tree with handles
  const rehydratedTree = rehydrateTree(result.tree, handleMap);

  logger.debug('subtree load complete', {
    handleMapSize: handleMap.size,
    loadedCount: result.loadedCount,
  });

  onTreeUpdate(rehydratedTree);

  // Find the updated node in the rehydrated tree
  const updatedNode = findNodeByPath(rehydratedTree, nodePath);
  if (!updatedNode) {
    return { success: false, filePaths: [], error: 'Node not found after loading' };
  }

  // Now get all file paths from the loaded tree
  const allFilePaths = fileExplorer.getAllFilePathsInDirectory(updatedNode);

  logger.info('selectFolderRecursively: subtree loaded', {
    path: nodePath,
    fileCount: allFilePaths.length,
    loadedDirectories: result.loadedCount,
  });

  return selectFilesWithLimit(
    allFilePaths,
    folderId,
    addMultipleSelectedFiles,
    maxSelectionCount,
    currentSelectionSize
  );
}

/**
 * Handle selection error.
 */
function handleSelectionError(err: unknown, onError?: (error: Error) => void): SelectionResult {
  const isCancelled = isAbortError(err);

  if (!isCancelled) {
    logger.error('selectFolderRecursively: error', {
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

export interface RecursiveFolderSelectState {
  isLoadingForSelection: boolean;
  loadingPath: string | null;
  loadingProgress: { loaded: number; total: number } | null;
}

export interface UseRecursiveFolderSelectOptions {
  /** Ref to worker port for loadSubtree commands */
  workerPortRef: React.RefObject<FileTreeWorkerPort | null>;
  /** Ref to handle map for rehydrating worker tree */
  handleMapRef: React.RefObject<Map<string, FileSystemHandle>>;
  /** Callback when tree is updated after subtree load */
  onTreeUpdate: (tree: IFileNode[]) => void;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
}

export interface SelectionResult {
  /** Whether the operation was successful */
  success: boolean;
  /** File paths that were selected (or would be selected) */
  filePaths: string[];
  /** Whether the operation was cancelled */
  cancelled?: boolean;
  /** Error message if failed */
  error?: string;
}

export interface UseRecursiveFolderSelectReturn {
  /** Whether a subtree is being loaded for selection */
  isLoadingForSelection: boolean;
  /** Path of the folder being loaded (if any) */
  loadingPath: string | null;
  /** Loading progress (if available) */
  loadingProgress: { loaded: number; total: number } | null;
  /** Select all files in a folder, loading unloaded children first if needed */
  selectFolderRecursively: (
    node: IFileNode,
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    currentSelectionSize: number
  ) => Promise<SelectionResult>;
  /** Cancel the current recursive selection operation */
  cancelRecursiveSelect: () => void;
  /** Ref to check if loading is active (for use in effects) */
  isLoadingForSelectionRef: React.RefObject<boolean>;
}

const RESET_STATE: RecursiveFolderSelectState = {
  isLoadingForSelection: false,
  loadingPath: null,
  loadingProgress: null,
};

/**
 * Hook for managing recursive folder selection with lazy loading.
 *
 * When selecting a folder:
 * 1. If fully loaded → use fast path (getAllFilePathsInDirectory)
 * 2. If not fully loaded → load subtree via worker, then select
 *
 * @param options - Configuration options
 * @returns Recursive selection state and controls
 */
export function useRecursiveFolderSelect(
  options: UseRecursiveFolderSelectOptions
): UseRecursiveFolderSelectReturn {
  const { workerPortRef, handleMapRef, onTreeUpdate, onError } = options;

  // State
  const [state, setState] = useState<RecursiveFolderSelectState>(RESET_STATE);

  // Guard against double-clicks
  const isStartingRef = useRef(false);

  // Ref for checking loading state in effects
  const isLoadingForSelectionRef = useRef(false);

  /**
   * Cancel recursive selection operation.
   */
  const cancelRecursiveSelect = useCallback(() => {
    workerPortRef.current?.abort();
    isStartingRef.current = false;
    isLoadingForSelectionRef.current = false;
    setState(RESET_STATE);
  }, [workerPortRef]);

  /**
   * Cleanup on unmount - abort any in-progress operations.
   */
  useEffect(() => {
    return () => {
      if (isLoadingForSelectionRef.current) {
        logger.debug('useRecursiveFolderSelect: cleaning up on unmount');
        workerPortRef.current?.abort();
      }
    };
  }, [workerPortRef]);

  /**
   * Load subtree and select files.
   */
  const loadAndSelectSubtree = useCallback(
    async (
      node: IFileNode,
      workerPort: FileTreeWorkerPort,
      handleMap: Map<string, FileSystemHandle>,
      folderId: string,
      addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
      maxSelectionCount: number,
      currentSelectionSize: number
    ): Promise<SelectionResult> => {
      // Set up progress handler
      const unsubProgress = workerPort.onProgress((loaded, total) => {
        setState((s) => ({ ...s, loadingProgress: { loaded, total } }));
      });

      try {
        logger.info('selectFolderRecursively: loading subtree', { path: node.path });

        const result = await workerPort.loadSubtree(node.path);

        // Check if cancelled
        if (!isLoadingForSelectionRef.current) {
          return { success: false, filePaths: [], cancelled: true };
        }

        const selectionResult = processLoadedSubtree(
          result,
          handleMap,
          onTreeUpdate,
          node.path,
          folderId,
          addMultipleSelectedFiles,
          maxSelectionCount,
          currentSelectionSize
        );

        setState(RESET_STATE);
        return selectionResult;
      } catch (err) {
        setState(RESET_STATE);
        return handleSelectionError(err, onError);
      } finally {
        unsubProgress();
        isStartingRef.current = false;
        isLoadingForSelectionRef.current = false;
      }
    },
    [onTreeUpdate, onError]
  );

  /**
   * Select all files in a folder, loading unloaded children first if needed.
   */
  const selectFolderRecursively = useCallback(
    async (
      node: IFileNode,
      folderId: string,
      addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
      maxSelectionCount: number,
      currentSelectionSize: number
    ): Promise<SelectionResult> => {
      // Validate node
      if (node.type !== 'directory') {
        return { success: false, filePaths: [], error: 'Node is not a directory' };
      }

      // Check if folder is fully loaded → fast path
      if (isFolderFullyLoaded(node)) {
        return handleFastPathSelection(
          node,
          folderId,
          addMultipleSelectedFiles,
          maxSelectionCount,
          currentSelectionSize
        );
      }

      // Need to load subtree first
      const workerPort = workerPortRef.current;
      const handleMap = handleMapRef.current;

      if (!workerPort) {
        return { success: false, filePaths: [], error: 'Worker not ready' };
      }

      if (!handleMap) {
        return { success: false, filePaths: [], error: 'Handle map not ready' };
      }

      // Guard against double-clicks - set immediately before check to prevent race
      if (isStartingRef.current) {
        logger.debug('selectFolderRecursively: blocked by double-click guard');
        return { success: false, filePaths: [], error: 'Operation already in progress' };
      }
      isStartingRef.current = true;

      // Set remaining guards and state
      isLoadingForSelectionRef.current = true;
      setState({
        isLoadingForSelection: true,
        loadingPath: node.path,
        loadingProgress: null,
      });

      return loadAndSelectSubtree(
        node,
        workerPort,
        handleMap,
        folderId,
        addMultipleSelectedFiles,
        maxSelectionCount,
        currentSelectionSize
      );
    },
    [workerPortRef, handleMapRef, loadAndSelectSubtree]
  );

  return {
    isLoadingForSelection: state.isLoadingForSelection,
    loadingPath: state.loadingPath,
    loadingProgress: state.loadingProgress,
    selectFolderRecursively,
    cancelRecursiveSelect,
    isLoadingForSelectionRef,
  };
}
