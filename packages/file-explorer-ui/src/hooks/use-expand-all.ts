/**
 * Expand All Hook
 *
 * Manages expand-all operation state and orchestration.
 * Works with the file tree worker to progressively expand all directories.
 *
 * @module use-expand-all
 */

import type { FileTreeWorkerPort } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import { createLogger, isAbortError } from '@brainstrike/utils';
import { useCallback, useRef, useState } from 'react';

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
  logger.info(`${operation} complete`, { handleMapSize, workerTreeNodes });
  logger.info(`${operation} rehydrated`, { rehydratedNodes });

  const filesWithoutHandles = countFilesWithoutHandles(rehydratedTree);
  if (filesWithoutHandles > 0) {
    logger.warn(`${operation} files missing handles`, { filesWithoutHandles });
  }
}

export type ExpandAllState = {
  isExpandingAll: boolean;
};

export type UseExpandAllOptions = {
  /** Ref to worker port for expand-all commands (use ref to get current value at call time) */
  workerPortRef: React.RefObject<FileTreeWorkerPort | null>;
  /** Ref to handle map for rehydrating worker tree */
  handleMapRef: React.RefObject<Map<string, FileSystemHandle>>;
  /** Root folder ID for expand-all scope */
  rootFolderId: string;
  /** Callback when tree is updated after expand-all */
  onTreeUpdate: (tree: IFileNode[]) => void;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
};

export type UseExpandAllReturn = {
  /** Whether expand-all is in progress */
  isExpandingAll: boolean;
  /** Start expand-all operation */
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
  ) => Promise<void>;
  /** Cancel expand-all operation */
  cancelExpandAll: () => void;
  /** Ref to check if expand-all is active (for use in effects) */
  isExpandingAllRef: React.RefObject<boolean>;
};

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
  const { workerPortRef, handleMapRef, rootFolderId, onTreeUpdate, onError } = options;

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
      logger.info('expandAllProgressively called', {
        rootFolderId,
        isAlreadyStarting: isExpandAllStartingRef.current,
      });

      // Get current values from refs at call time (not at hook creation time)
      const workerPort = workerPortRef.current;
      const handleMap = handleMapRef.current;

      logger.info('expandAllProgressively refs', {
        hasWorkerPort: !!workerPort,
        handleMapSize: handleMap.size,
      });

      if (!workerPort) {
        logger.warn('expandAllProgressively: worker not ready');
        return;
      }

      // Synchronous guard against double-clicks
      if (isExpandAllStartingRef.current) {
        logger.info('expandAllProgressively: blocked by double-click guard');
        return;
      }
      isExpandAllStartingRef.current = true;
      isExpandingAllRef.current = true;
      logger.info('expandAllProgressively: starting expand-all');

      // Store setExpandedPaths for potential use in handlers
      setExpandedPathsRef.current = setExpandedPaths;

      setState({ isExpandingAll: true });
      logger.info('expandAllProgressively: state set to expanding, calling worker');

      try {
        // Delegate to worker - it will request loads as needed
        logger.info('expandAllProgressively: calling workerPort.expandAll', { rootFolderId });
        const result = await workerPort.expandAll(rootFolderId);
        logger.info('expandAllProgressively: worker returned', {
          treeLength: result.tree.length,
          expandedPathsCount: result.expandedPaths.length,
          loadedCount: result.loadedCount,
        });

        // OPTIMIZATION: Skip rehydration when all directories were already cached
        // Rehydration is O(n) for tree nodes and can take 10+ seconds for large trees (150k+ nodes)
        // When loadedCount === 0, the React tree already has correct handles, so just update paths
        if (result.loadedCount === 0) {
          logger.info('expandAllProgressively: skipping rehydration (all cached)', {
            expandedPathsCount: result.expandedPaths.length,
          });
          // Tree is already up-to-date with handles, just update expanded paths
          setExpandedPaths(() => new Set(result.expandedPaths));
        } else {
          // Rehydrate final tree with handles
          const rehydratedTree = rehydrateTree(result.tree, handleMap);
          logRehydrationResult(
            'expand-all',
            handleMap.size,
            countNodes(result.tree),
            countNodes(rehydratedTree),
            rehydratedTree
          );

          // Update tree
          onTreeUpdate(rehydratedTree);

          // Set all expanded paths
          setExpandedPaths(() => new Set(result.expandedPaths));
        }

        // Clear state
        setState({ isExpandingAll: false });
        logger.info('expandAllProgressively: completed successfully');
      } catch (err) {
        logger.error('expandAllProgressively: error', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        const isCancelled = isAbortError(err);
        setState({ isExpandingAll: false });
        if (!isCancelled && onError) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        isExpandAllStartingRef.current = false;
        isExpandingAllRef.current = false;
        setExpandedPathsRef.current = null;
        logger.info('expandAllProgressively: cleanup complete');
      }
    },
    [workerPortRef, handleMapRef, rootFolderId, onTreeUpdate, onError]
  );

  return {
    isExpandingAll: state.isExpandingAll,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAllRef,
  };
}
