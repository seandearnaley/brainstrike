/**
 * Recursive Folder Select Hook
 *
 * Handles selecting all files within a folder, including loading unloaded children first.
 * Works with the file tree worker to progressively load directories before selection.
 *
 * IMPORTANT: This hook automatically applies workspace include/exclude filters when
 * used within a FileExplorerProvider context. If filterTreeFn is not explicitly
 * provided, the hook will access the store context to create its own filter function.
 *
 * @module use-recursive-folder-select
 */

import type { FileTreeWorkerPort, WorkerFileNode } from '@brainstrike/file-tree-worker';
import { useFileFilters } from '@brainstrike/hooks';
import type { IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useOptionalFileExplorerStoreContext,
  useOptionalFileExplorerStoreSelector,
} from '../file-explorer-provider';
import type { FileSystemHandle } from '../utils/worker-node-conversion';
import { rehydrateTree } from '../utils/worker-node-conversion';
import {
  selectExcludeFilters,
  selectIncludeFilters,
  selectUseRegex,
} from '../utils/workspace-filter-selectors';

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
 * Collect all file paths from a node, optionally applying a filter function first.
 *
 * If filterTreeFn is provided, it filters the node's subtree before collecting paths.
 * This ensures workspace include/exclude filters are respected during folder selection.
 *
 * Uses iterative approach for performance on large trees.
 */
function collectFilteredFilePaths(
  node: IFileNode,
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[]
): string[] {
  // If no filter, use the optimized utility
  if (!filterTreeFn) {
    return fileExplorer.getAllFilePathsInDirectory(node);
  }

  // Apply filter to the node's subtree
  // Wrap node in array since filterTreeFn expects array of nodes
  const filteredNodes = filterTreeFn([node]);

  // If the node itself was filtered out, return empty
  if (filteredNodes.length === 0) {
    return [];
  }

  // Collect all file paths from the filtered tree using iterative BFS
  const paths: string[] = [];
  const queue: IFileNode[] = [...filteredNodes];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const current = queue[queueIndex++];
    if (!current) {
      continue;
    }

    if (current.type === 'file') {
      paths.push(current.path);
    } else if (current.type === 'directory' && current.children) {
      queue.push(...current.children);
    }
  }

  return paths;
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
  currentSelectionSize: number,
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[]
): SelectionResult {
  logger.debug('selectFolderRecursively: using fast path (fully loaded)', {
    path: node.path,
    hasFilter: !!filterTreeFn,
  });

  const allFilePaths = collectFilteredFilePaths(node, filterTreeFn);
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
 *
 * Applies workspace filters to the loaded tree via filterTreeFn before collecting
 * file paths. This ensures include/exclude patterns are respected in the slow path.
 */
function processLoadedSubtree(
  result: { tree: WorkerFileNode[]; expandedPaths: string[]; loadedCount: number },
  handleMap: Map<string, FileSystemHandle>,
  onTreeUpdate: (tree: IFileNode[]) => void,
  nodePath: string,
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
  maxSelectionCount: number,
  currentSelectionSize: number,
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[],
  onNodesIndexed?: (nodes: IFileNode[], parentPath: string | null) => void
): SelectionResult {
  // Rehydrate tree with handles
  const rehydratedTree = rehydrateTree(result.tree, handleMap);

  logger.debug('subtree load complete', {
    handleMapSize: handleMap.size,
    loadedCount: result.loadedCount,
  });

  // Index all nodes from the rehydrated tree (FileTreeIndex.addNodes is recursive)
  // This must happen BEFORE consumers try to look up handles via FileTreeIndex
  if (onNodesIndexed && rehydratedTree.length > 0) {
    logger.debug('selectFolderRecursively: indexing rehydrated nodes', {
      rootCount: rehydratedTree.length,
    });
    onNodesIndexed(rehydratedTree, null);
  }

  onTreeUpdate(rehydratedTree);

  // Find the updated node in the rehydrated tree
  const updatedNode = findNodeByPath(rehydratedTree, nodePath);
  if (!updatedNode) {
    return { success: false, filePaths: [], error: 'Node not found after loading' };
  }

  // Get all file paths from the loaded tree, applying filter if provided
  const allFilePaths = collectFilteredFilePaths(updatedNode, filterTreeFn);

  logger.info('selectFolderRecursively: subtree loaded', {
    path: nodePath,
    fileCount: allFilePaths.length,
    loadedDirectories: result.loadedCount,
    hasFilter: !!filterTreeFn,
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
  /**
   * Filter function to apply workspace include/exclude filters to a tree.
   * Called before collecting file paths to ensure only filtered files are selected.
   * This ensures that selecting a folder respects the current workspace filters.
   */
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];
  /** Ref to handle map for rehydrating worker tree */
  handleMapRef: React.RefObject<Map<string, FileSystemHandle>>;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
  /**
   * Callback invoked when nodes are added to the tree.
   * Used by FileTreeIndex for incremental indexing after subtree loading.
   * @param nodes - The root-level nodes (FileTreeIndex.addNodes is recursive)
   * @param parentPath - Always null for folder selection (full subtree)
   */
  onNodesIndexed?: (nodes: IFileNode[], parentPath: string | null) => void;
  /** Callback when tree is updated after subtree load */
  onTreeUpdate: (tree: IFileNode[]) => void;
  /** Ref to worker port for loadSubtree commands */
  workerPortRef: React.RefObject<FileTreeWorkerPort | null>;
}

export interface SelectionResult {
  /** Whether the operation was cancelled */
  cancelled?: boolean;
  /** Error message if failed */
  error?: string;
  /** File paths that were selected (or would be selected) */
  filePaths: string[];
  /** Whether the operation was successful */
  success: boolean;
}

export interface UseRecursiveFolderSelectReturn {
  /** Cancel the current recursive selection operation */
  cancelRecursiveSelect: () => void;
  /** Whether a subtree is being loaded for selection */
  isLoadingForSelection: boolean;
  /** Ref to check if loading is active (for use in effects) */
  isLoadingForSelectionRef: React.RefObject<boolean>;
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
  const { workerPortRef, handleMapRef, onTreeUpdate, onError, filterTreeFn, onNodesIndexed } =
    options;

  // Access store context for workspace filters (optional - may be null outside FileExplorerProvider)
  const store = useOptionalFileExplorerStoreContext();

  // Get filter settings from store if available
  const includeFilters = useOptionalFileExplorerStoreSelector(selectIncludeFilters, []);
  const excludeFilters = useOptionalFileExplorerStoreSelector(selectExcludeFilters, []);
  const useRegex = useOptionalFileExplorerStoreSelector(selectUseRegex, false);

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
    // No filter available - return undefined
    return undefined;
  }, [filterTreeFn, store, applyFileFilters, includeFilters, excludeFilters, useRegex]);

  // State
  const [state, setState] = useState<RecursiveFolderSelectState>(RESET_STATE);

  /**
   * Synchronization guards using refs for immediate mutation.
   *
   * Thread Safety Model:
   * These refs act as synchronization primitives for async operations in React's
   * event-driven model. While JavaScript is single-threaded, multiple invocations
   * can interleave at await points. Refs provide immediate mutation/read (unlike
   * state which batches), ensuring guards are effective:
   *
   * 1. isStartingRef: Prevents double-click race conditions by blocking concurrent
   *    invocations of selectFolderRecursively. Set before any async work, cleared
   *    after completion or cancellation.
   *
   * 2. isLoadingForSelectionRef: Tracks active loading for cleanup on unmount.
   *    Read in useEffect cleanup to determine if abort is needed.
   *
   * Both refs are reset in cancelRecursiveSelect() and cleanup effect to ensure
   * consistent state after operations complete, error, or component unmounts.
   */
  const isStartingRef = useRef(false);
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
          currentSelectionSize,
          internalFilterTreeFn,
          onNodesIndexed
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
    [onTreeUpdate, onError, internalFilterTreeFn, onNodesIndexed]
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
          currentSelectionSize,
          internalFilterTreeFn
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
    [workerPortRef, handleMapRef, loadAndSelectSubtree, internalFilterTreeFn]
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
