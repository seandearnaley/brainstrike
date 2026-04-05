/**
 * Expand All Hook
 *
 * Manages expand-all operation state and orchestration.
 * Works with the file tree worker to progressively expand all directories.
 * Includes error handling and abort support.
 *
 * @module use-expand-all
 */

import type { IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { startTransition, useCallback, useRef, useState } from 'react';

import { traverseDirectoriesDirect } from './direct-directory-traversal';

const logger = createLogger('ExpandAll');

/**
 * Check if expand-all can proceed. Returns true if should skip.
 * Extracted to reduce cognitive complexity.
 */
function shouldSkipExpandAll(isAlreadyStarting: boolean): { skip: boolean; reason?: string } {
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

function applyExpandedPaths(
  expandedPaths: Set<string>,
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
): void {
  startTransition(() => {
    setExpandedPaths(() => new Set(expandedPaths));
  });
}

function beginExpandAllOperation(
  isExpandAllStartingRef: React.RefObject<boolean>,
  isExpandingAllRef: React.RefObject<boolean>,
  setExpandedPathsRef: React.RefObject<
    ((updater: (prev: Set<string>) => Set<string>) => void) | null
  >,
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
  setState: React.Dispatch<React.SetStateAction<ExpandAllState>>
): void {
  isExpandAllStartingRef.current = true;
  isExpandingAllRef.current = true;
  setExpandedPathsRef.current = setExpandedPaths;
  setState({ isExpandingAll: true });
}

function completeExpandAllOperation(
  expandedPaths: Set<string>,
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
  setState: React.Dispatch<React.SetStateAction<ExpandAllState>>
): void {
  applyExpandedPaths(expandedPaths, setExpandedPaths);
  setState({ isExpandingAll: false });
}

function resetExpandAllOperation(
  isExpandAllStartingRef: React.RefObject<boolean>,
  isExpandingAllRef: React.RefObject<boolean>,
  setExpandedPathsRef: React.RefObject<
    ((updater: (prev: Set<string>) => Set<string>) => void) | null
  >
): void {
  isExpandAllStartingRef.current = false;
  isExpandingAllRef.current = false;
  setExpandedPathsRef.current = null;
}

export interface ExpandAllState {
  isExpandingAll: boolean;
}

export interface UseExpandAllOptions {
  /** Cancel in-flight directory load operations */
  cancelLoadOperations: () => void;
  /** Look up current directory node state by path */
  getNodeByPath: (path: string) => IFileNode | undefined;
  /** Get current root nodes from canonical tree state */
  getRootNodes: () => IFileNode[];
  /** Load one directory into canonical tree state */
  loadDirectoryPath: (path: string) => Promise<void>;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
  /** Emit progress updates for UI feedback */
  onProgress?: (loaded: number, total: number) => void;
  /** Root folder ID for expand-all scope */
  rootFolderId: string;
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
  const {
    cancelLoadOperations,
    getNodeByPath,
    getRootNodes,
    loadDirectoryPath,
    onError,
    onProgress,
  } = options;

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
    cancelLoadOperations();
    isExpandAllStartingRef.current = false;
    isExpandingAllRef.current = false;
    setExpandedPathsRef.current = null;
    setState({ isExpandingAll: false });
  }, [cancelLoadOperations]);

  /**
   * Progressively expand all directories using the Web Worker.
   *
   * @param setExpandedPaths - Function to update expanded paths in the store
   */
  const expandAllProgressively = useCallback(
    async (
      setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
    ): Promise<void> => {
      // Check if we should skip (pre-flight checks)
      const skipCheck = shouldSkipExpandAll(isExpandAllStartingRef.current);
      if (skipCheck.skip) {
        if (skipCheck.reason) {
          logger.debug(`expandAllProgressively: ${skipCheck.reason}`);
        }
        return;
      }

      beginExpandAllOperation(
        isExpandAllStartingRef,
        isExpandingAllRef,
        setExpandedPathsRef,
        setExpandedPaths,
        setState
      );

      try {
        const initialPaths = getRootNodes()
          .filter((node) => node.type === 'directory')
          .map((node) => node.path);
        const traversalResult = await traverseDirectoriesDirect(initialPaths, {
          getDirectoryByPath: getNodeByPath,
          isActive: () => isExpandingAllRef.current,
          loadDirectoryPath,
          onProgress,
        });

        if (traversalResult.cancelled) {
          throw new DOMException('Operation aborted', 'AbortError');
        }

        completeExpandAllOperation(traversalResult.discoveredPaths, setExpandedPaths, setState);
      } catch (err) {
        handleExpandError(err, onError);
        setState({ isExpandingAll: false });
      } finally {
        resetExpandAllOperation(isExpandAllStartingRef, isExpandingAllRef, setExpandedPathsRef);
      }
    },
    [getRootNodes, getNodeByPath, loadDirectoryPath, onError, onProgress]
  );

  return {
    isExpandingAll: state.isExpandingAll,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAllRef,
  };
}
