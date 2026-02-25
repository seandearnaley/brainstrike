/**
 * Expand All Hook
 *
 * Manages expand-all operation state and orchestration.
 * Works with the file tree worker to progressively expand all directories.
 * Includes error handling and abort support.
 *
 * @module use-expand-all
 */

import type { FileTreeWorkerPort } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import { createLogger, isAbortError } from '@brainstrike/utils';
import { startTransition, useCallback, useRef, useState } from 'react';

import type { FileSystemHandle } from '../utils/worker-node-conversion';
import { rehydrateTree } from '../utils/worker-node-conversion';

const logger = createLogger('ExpandAll');

/**
 * Count total nodes in a tree (used for logging).
 */
function countNodes(nodes: { children?: unknown[] }[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.children) {
      count += countNodes(node.children as { children?: unknown[] }[]);
    }
  }
  return count;
}

/**
 * Count files without handles (used for logging rehydration issues).
 */
function countFilesWithoutHandles(nodes: IFileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'file' && !node.handle) {
      count += 1;
    }
    if (node.children) {
      count += countFilesWithoutHandles(node.children);
    }
  }
  return count;
}

/**
 * Log and check for files without handles after tree rehydration.
 */
function logRehydrationResult(
  operation: string,
  handleMapSize: number,
  workerTreeNodes: number,
  rehydratedNodes: number,
  rehydratedTree: IFileNode[]
): void {
  logger.debug(`${operation} complete`, { handleMapSize, workerTreeNodes });
  logger.debug(`${operation} rehydrated`, { rehydratedNodes });

  const filesWithoutHandles = countFilesWithoutHandles(rehydratedTree);
  if (filesWithoutHandles > 0) {
    logger.warn(`${operation} files missing handles`, { filesWithoutHandles });
  }
}

/**
 * Process expand-all result - handle rehydration if needed.
 * Extracted to reduce complexity of main function.
 *
 * Uses startTransition to make tree update non-urgent, allowing React to
 * yield to browser for user input during large tree renders.
 *
 * @param result - The result from worker.expandAll()
 * @param handleMap - Map of path to FileSystemHandle
 * @param setExpandedPaths - Function to update expanded paths
 * @param onTreeUpdate - Callback to update tree state
 * @param onNodesIndexed - Optional callback to index nodes (for FileTreeIndex)
 */
function processExpandResult(
  result: { tree: unknown[]; expandedPaths: string[]; loadedCount: number },
  handleMap: Parameters<typeof rehydrateTree>[1],
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
  onTreeUpdate: (tree: IFileNode[]) => void,
  onNodesIndexed?: (nodes: IFileNode[], parentPath: string | null) => void
): void {
  // Skip rehydration when all directories were already cached
  if (result.loadedCount === 0) {
    logger.debug('expandAllProgressively: skipping rehydration (all cached)', {
      expandedPathsCount: result.expandedPaths.length,
    });
    // Use startTransition even for cached case - expanding many paths triggers re-renders
    startTransition(() => {
      setExpandedPaths(() => new Set(result.expandedPaths));
    });
    return;
  }

  // Rehydrate tree with handles and update - cast to expected type
  const rehydratedTree = rehydrateTree(
    result.tree as Parameters<typeof rehydrateTree>[0],
    handleMap
  );
  logRehydrationResult(
    'expand-all',
    handleMap.size,
    countNodes(result.tree as { children?: unknown[] }[]),
    countNodes(rehydratedTree),
    rehydratedTree
  );

  // Index all nodes from the rehydrated tree (FileTreeIndex.addNodes is recursive)
  if (onNodesIndexed && rehydratedTree.length > 0) {
    logger.debug('expandAllProgressively: indexing rehydrated nodes', {
      rootCount: rehydratedTree.length,
    });
    onNodesIndexed(rehydratedTree, null);
  }

  // Use startTransition to make tree update non-urgent - React can interrupt
  // and yield to browser for user input during large tree renders
  startTransition(() => {
    onTreeUpdate(rehydratedTree);
    setExpandedPaths(() => new Set(result.expandedPaths));
  });
}

/**
 * Check if expand-all can proceed. Returns true if should skip.
 * Extracted to reduce cognitive complexity.
 */
function shouldSkipExpandAll(
  workerPort: FileTreeWorkerPort | null,
  isAlreadyStarting: boolean
): { skip: boolean; reason?: string } {
  if (!workerPort) {
    return { skip: true, reason: 'worker not ready' };
  }
  if (isAlreadyStarting) {
    return { skip: true, reason: 'blocked by double-click guard' };
  }
  return { skip: false };
}

/**
 * Handle expand-all error with proper logging and callback.
 * Extracted to reduce cognitive complexity.
 */
function handleExpandError(err: unknown, onError?: (error: Error) => void): void {
  logger.error('expandAllProgressively: error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  const isCancelled = isAbortError(err);
  if (!isCancelled && onError) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export interface ExpandAllState {
  isExpandingAll: boolean;
}

export interface UseExpandAllOptions {
  /** Ref to handle map for rehydrating worker tree */
  handleMapRef: React.RefObject<Map<string, FileSystemHandle>>;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
  /**
   * Callback invoked when nodes are indexed after expand-all.
   * Used by FileTreeIndex for incremental indexing.
   * @param nodes - The root-level nodes (FileTreeIndex.addNodes is recursive)
   * @param parentPath - Always null for expand-all (starts from root)
   */
  onNodesIndexed?: (nodes: IFileNode[], parentPath: string | null) => void;
  /** Callback when tree is updated after expand-all */
  onTreeUpdate: (tree: IFileNode[]) => void;
  /** Root folder ID for expand-all scope */
  rootFolderId: string;
  /** Ref to worker port for expand-all commands (use ref to get current value at call time) */
  workerPortRef: React.RefObject<FileTreeWorkerPort | null>;
}

export interface UseExpandAllReturn {
  /** Cancel expand-all operation */
  cancelExpandAll: () => void;
  /** Start expand-all operation */
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
  ) => Promise<void>;
  /** Whether expand-all is in progress */
  isExpandingAll: boolean;
  /** Ref to check if expand-all is active (for use in effects) */
  isExpandingAllRef: React.RefObject<boolean>;
}

/**
 * Hook for managing expand-all operation.
 *
 * Orchestrates the expand-all process:
 * 1. Sends expandAll command to worker
 * 2. Worker requests directory loads as needed (handled by useFileTreeWorker)
 * 3. On completion, rehydrates tree with file handles
 * 4. Updates expanded paths in store
 *
 * @param options - Configuration options
 * @returns Expand-all state and controls
 */
export function useExpandAll(options: UseExpandAllOptions): UseExpandAllReturn {
  const { workerPortRef, handleMapRef, rootFolderId, onTreeUpdate, onError, onNodesIndexed } =
    options;

  // State
  const [state, setState] = useState<ExpandAllState>({
    isExpandingAll: false,
  });

  // Guard against double-clicks
  const isExpandAllStartingRef = useRef(false);

  // Ref for checking expand-all state in effects
  const isExpandingAllRef = useRef(false);

  // Ref to store setExpandedPaths callback
  const setExpandedPathsRef = useRef<
    ((updater: (prev: Set<string>) => Set<string>) => void) | null
  >(null);

  /**
   * Cancel expand-all operation.
   */
  const cancelExpandAll = useCallback(() => {
    workerPortRef.current?.abort();
    isExpandAllStartingRef.current = false;
    isExpandingAllRef.current = false;
    setExpandedPathsRef.current = null;
    setState({ isExpandingAll: false });
  }, [workerPortRef]);

  /**
   * Progressively expand all directories using the Web Worker.
   *
   * @param setExpandedPaths - Function to update expanded paths in the store
   */
  const expandAllProgressively = useCallback(
    async (
      setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
    ): Promise<void> => {
      // Get current values from refs at call time
      const workerPort = workerPortRef.current;
      const handleMap = handleMapRef.current;

      // Check if we should skip (pre-flight checks)
      const skipCheck = shouldSkipExpandAll(workerPort, isExpandAllStartingRef.current);
      if (skipCheck.skip || !workerPort) {
        if (skipCheck.reason) {
          logger.debug(`expandAllProgressively: ${skipCheck.reason}`);
        }
        return;
      }

      // Set guards and state
      isExpandAllStartingRef.current = true;
      isExpandingAllRef.current = true;
      setExpandedPathsRef.current = setExpandedPaths;
      setState({ isExpandingAll: true });

      try {
        const result = await workerPort.expandAll(rootFolderId);
        processExpandResult(result, handleMap, setExpandedPaths, onTreeUpdate, onNodesIndexed);
        setState({ isExpandingAll: false });
      } catch (err) {
        handleExpandError(err, onError);
        setState({ isExpandingAll: false });
      } finally {
        isExpandAllStartingRef.current = false;
        isExpandingAllRef.current = false;
        setExpandedPathsRef.current = null;
      }
    },
    [workerPortRef, handleMapRef, rootFolderId, onTreeUpdate, onError, onNodesIndexed]
  );

  return {
    isExpandingAll: state.isExpandingAll,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAllRef,
  };
}
