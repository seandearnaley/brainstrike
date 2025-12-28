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

export type ExpandAllProgress = {
  loaded: number;
  total: number;
};

export type ExpandAllState = {
  isExpandingAll: boolean;
  expandAllProgress: ExpandAllProgress | null;
};

export type UseExpandAllOptions = {
  /** Worker port for expand-all commands */
  workerPort: FileTreeWorkerPort | null;
  /** Handle map for rehydrating worker tree */
  handleMap: Map<string, FileSystemHandle>;
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
  /** Progress of expand-all operation */
  expandAllProgress: ExpandAllProgress | null;
  /** Start expand-all operation */
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
  ) => Promise<void>;
  /** Cancel expand-all operation */
  cancelExpandAll: () => void;
  /** Ref to check if expand-all is active (for use in effects) */
  isExpandingAllRef: React.RefObject<boolean>;
  /** Update progress (called by worker progress handler) */
  updateProgress: (loaded: number, total: number) => void;
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
  const { workerPort, handleMap, rootFolderId, onTreeUpdate, onError } = options;

  // State
  const [state, setState] = useState<ExpandAllState>({
    isExpandingAll: false,
    expandAllProgress: null,
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
   * Update progress (called by worker progress handler).
   */
  const updateProgress = useCallback((loaded: number, total: number) => {
    setState((s) => ({
      ...s,
      expandAllProgress: { loaded, total },
    }));
  }, []);

  /**
   * Cancel expand-all operation.
   */
  const cancelExpandAll = useCallback(() => {
    workerPort?.abort();
    isExpandAllStartingRef.current = false;
    isExpandingAllRef.current = false;
    setExpandedPathsRef.current = null;
    setState({
      isExpandingAll: false,
      expandAllProgress: null,
    });
  }, [workerPort]);

  /**
   * Progressively expand all directories using the Web Worker.
   *
   * @param setExpandedPaths - Function to update expanded paths in the store
   */
  const expandAllProgressively = useCallback(
    async (
      setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
    ): Promise<void> => {
      if (!workerPort) {
        return;
      }

      // Synchronous guard against double-clicks
      if (isExpandAllStartingRef.current) {
        return;
      }
      isExpandAllStartingRef.current = true;
      isExpandingAllRef.current = true;

      // Store setExpandedPaths for potential use in handlers
      setExpandedPathsRef.current = setExpandedPaths;

      setState({
        isExpandingAll: true,
        expandAllProgress: { loaded: 0, total: 0 },
      });

      try {
        // Delegate to worker - it will request loads as needed
        const result = await workerPort.expandAll(rootFolderId);

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

        // Clear state
        setState({
          isExpandingAll: false,
          expandAllProgress: null,
        });
      } catch (err) {
        const isCancelled = isAbortError(err);
        setState({
          isExpandingAll: false,
          expandAllProgress: null,
        });
        if (!isCancelled && onError) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        isExpandAllStartingRef.current = false;
        isExpandingAllRef.current = false;
        setExpandedPathsRef.current = null;
      }
    },
    [workerPort, rootFolderId, handleMap, onTreeUpdate, onError]
  );

  return {
    isExpandingAll: state.isExpandingAll,
    expandAllProgress: state.expandAllProgress,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAllRef,
    updateProgress,
  };
}
