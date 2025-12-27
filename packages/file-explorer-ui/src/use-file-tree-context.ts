/**
 * File Tree Hook (Context-aware)
 *
 * This hook provides file tree functionality using only the context-based store,
 * avoiding dependencies on the file-explorer-hooks package that uses the old global store.
 *
 * Includes IndexedDB caching for improved startup performance on subsequent loads.
 */

import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readFullTree as readFullTreeUtil } from './utils/read-full-tree';

const logger = createLogger('useFileTree');

export type LoadingProgressState = {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
  /** Monotonically increasing percentage (0-100), never decreases */
  percentage: number;
};

export type CancellableFileTreeHook = {
  fileTree: IFileNode[];
  isLoading: boolean;
  error: Error | null;
  refreshTree: () => Promise<void>;
  loadingProgress: LoadingProgressState;
  /** Whether the current operation can be cancelled */
  cancellable: boolean;
  /** Cancel the current loading operation */
  cancelOperation: () => void;
  /** Whether the operation is currently being cancelled */
  isCancelling: boolean;
};

/**
 * Calculates the new total estimate when the current loaded count exceeds the estimate.
 * Ensures the total is always at least the loaded count, with a conservative buffer.
 * Uses a smaller buffer (10%) for more accurate progress display.
 */
export function calculateDynamicTotal(currentTotal: number, loaded: number): number {
  if (loaded <= currentTotal) {
    return currentTotal;
  }

  // Use a smaller buffer (10%) for more accurate progress estimates
  // This prevents the progress from jumping backwards too much
  const bufferPercentage = 0.1; // 10% buffer (down from 25%)
  const minBuffer = 50; // Reduced minimum buffer

  const buffer = Math.max(Math.ceil(loaded * bufferPercentage), minBuffer);

  return loaded + buffer;
}

/**
 * Maximum percentage to show during loading.
 * We cap at 95% to avoid the "long tail" problem where progress sits at 99% for extended periods.
 * Only the final completion state sets 100%.
 */
const MAX_IN_PROGRESS_PERCENTAGE = 95;

/**
 * Safely calculates percentage avoiding division by zero.
 * Clamps result between 0 and MAX_IN_PROGRESS_PERCENTAGE during loading.
 * The final 100% is only set explicitly when loading completes.
 */
export function calculateProgressPercentage(loaded: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  const rawPercentage = Math.round((loaded / total) * 100);
  // Cap at MAX_IN_PROGRESS_PERCENTAGE during loading - final 100% is set explicitly on completion
  return Math.min(MAX_IN_PROGRESS_PERCENTAGE, Math.max(0, rawPercentage));
}

/**
 * Calculates a monotonically increasing progress percentage.
 * Ensures the percentage never decreases, providing a smooth user experience.
 * Capped at MAX_IN_PROGRESS_PERCENTAGE until explicitly completed.
 */
export function calculateMonotonicProgress(
  loaded: number,
  total: number,
  previousPercentage: number
): number {
  const currentPercentage = calculateProgressPercentage(loaded, total);
  // Never go backwards - always return the higher value, but cap at MAX_IN_PROGRESS_PERCENTAGE
  return Math.min(MAX_IN_PROGRESS_PERCENTAGE, Math.max(currentPercentage, previousPercentage));
}

/**
 * Checks if an error is a cancellation error
 */
const isCancellationError = (error: unknown): boolean => {
  // DOMException with name 'AbortError' is the canonical cancel signal
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  // Some environments surface AbortError as a regular Error
  return error instanceof Error && error.name === 'AbortError';
};

/**
 * Safely converts any error to an Error instance
 */
const ensureError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/**
 * Result of attempting to load from cache
 */
type CacheLoadResult = { success: true; nodes: IFileNode[] } | { success: false };

/**
 * Attempts to load tree from IndexedDB cache.
 * Returns cached nodes on hit, or signals to continue with normal loading.
 */
async function tryLoadFromCache(cacheKey: string): Promise<CacheLoadResult> {
  try {
    const { getCachedTree } = await import('./cache/tree-cache');
    const cacheResult = await getCachedTree(cacheKey);

    if (cacheResult.hit) {
      return { success: true, nodes: cacheResult.nodes };
    }
  } catch {
    // Cache access failed, proceed with normal loading
  }
  return { success: false };
}

/**
 * Attempts to save tree to IndexedDB cache (fire-and-forget).
 */
function saveToCache(cacheKey: string, tree: IFileNode[]): void {
  import('./cache/tree-cache')
    .then(({ setCachedTree }) => setCachedTree(cacheKey, tree))
    .catch(() => {
      // Ignore cache write failures
    });
}

/**
 * Handles errors during tree loading.
 * Returns true if the error was a cancellation (should clear tree without error state).
 */
function handleLoadError(
  err: unknown,
  setError: (error: Error | null) => void,
  setFileTree: (tree: IFileNode[]) => void
): void {
  const error = ensureError(err);

  if (isCancellationError(error)) {
    setFileTree([]); // Clear the tree on cancellation
  } else {
    setError(error);
    setFileTree([]);
  }
}

export function useFileTree(rootDirectoryHandle: DirectoryHandle | null): CancellableFileTreeHook {
  const { fileSystemAdapter } = useAdapters();
  const [fileTree, setFileTree] = useState<IFileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgressState>({
    loaded: 0,
    total: 0,
    phase: 'counting',
    percentage: 0,
  });

  const progressRef = useRef<{
    loaded: number;
    total: number;
    currentPath: string;
    phase: LoadingProgressState['phase'];
    estimatedTotal: number;
    maxPercentage: number;
  }>({
    loaded: 0,
    total: 0,
    currentPath: '',
    phase: 'counting',
    estimatedTotal: 100,
    maxPercentage: 0,
  });

  // AbortController for cancelling operations
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancelOperation = useCallback(() => {
    if (abortControllerRef.current && isLoading && !isCancelling) {
      setIsCancelling(true);
      abortControllerRef.current.abort();
    }
  }, [isLoading, isCancelling]);

  const sortFileNodes = useCallback(
    (nodes: IFileNode[]): IFileNode[] =>
      [...nodes].sort((a, b) => {
        if (a.type !== b.type) {
          if (a.type === 'directory') {
            return -1;
          }
          if (b.type === 'directory') {
            return 1;
          }
        }
        return a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      }),
    []
  );

  // Use ref to avoid recreating the callback on every render
  const updateProgressRef = useRef(
    (() => {
      // throttle progress updates to reduce re-renders
      const batchSize = 25;
      let sinceLastCommit = 0;
      return (path?: string) => {
        progressRef.current.loaded += 1;
        sinceLastCommit += 1;
        if (path) {
          progressRef.current.currentPath = path;
        }

        // Dynamically adjust total if we exceed the current estimate
        progressRef.current.total = calculateDynamicTotal(
          progressRef.current.total,
          progressRef.current.loaded
        );

        // Calculate monotonically increasing percentage
        const currentPercentage = calculateProgressPercentage(
          progressRef.current.loaded,
          progressRef.current.total
        );
        progressRef.current.maxPercentage = Math.max(
          progressRef.current.maxPercentage,
          currentPercentage
        );

        if (sinceLastCommit >= batchSize) {
          sinceLastCommit = 0;
          setLoadingProgress({
            loaded: progressRef.current.loaded,
            total: progressRef.current.total,
            currentPath: progressRef.current.currentPath,
            phase: progressRef.current.phase,
            percentage: progressRef.current.maxPercentage,
          });
        }
      };
    })()
  );

  const readFullTree = useCallback(
    (
      directoryHandle: DirectoryHandle,
      rootHandle: DirectoryHandle,
      parentPath = '',
      isRoot = true,
      abortSignal?: AbortSignal
    ): Promise<IFileNode[]> => {
      if (!fileSystemAdapter) {
        setError(new Error('File system adapter is not available'));
        return Promise.resolve([]);
      }
      if (isRoot) {
        progressRef.current.phase = 'loading';
        progressRef.current.loaded = 0;
        progressRef.current.total = progressRef.current.estimatedTotal;
        progressRef.current.maxPercentage = 0;
        setLoadingProgress({
          loaded: 0,
          total: progressRef.current.estimatedTotal,
          phase: 'loading',
          percentage: 0,
        });
      }

      return readFullTreeUtil(
        fileSystemAdapter,
        directoryHandle,
        rootHandle,
        parentPath,
        isRoot,
        abortSignal,
        updateProgressRef.current,
        sortFileNodes
      );
    },
    [fileSystemAdapter, sortFileNodes]
  );

  const loadTree = useCallback(
    async (skipCache = false) => {
      if (!rootDirectoryHandle) {
        setFileTree([]);
        return;
      }
      if (!fileSystemAdapter) {
        setError(new Error('File system adapter is not available'));
        setFileTree([]);
        return;
      }

      // Set loading state immediately to avoid race conditions in tests
      // where waitFor(isLoading === false) could pass before loading starts
      setIsLoading(true);
      setIsCancelling(false);
      setError(null);

      const cacheKey = rootDirectoryHandle.name;

      // Try to load from cache first (unless explicitly skipping)
      if (!skipCache) {
        const cacheResult = await tryLoadFromCache(cacheKey);
        if (cacheResult.success) {
          // Display cached tree immediately for instant UI
          // Handles are not cached (not serializable to IndexedDB)
          // They will be acquired lazily when files are opened
          setFileTree(cacheResult.nodes);
          setLoadingProgress({ loaded: 1, total: 1, phase: 'loading', percentage: 100 });
          setIsLoading(false);
          logger.debug(`Loaded tree from cache: ${cacheKey} (handles will be acquired on-demand)`);
          return;
        }
      }

      // Create new AbortController for this operation
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const tree = await readFullTree(
          rootDirectoryHandle,
          rootDirectoryHandle,
          '',
          true,
          abortController.signal
        );

        // Only update state if not cancelled
        if (!abortController.signal.aborted) {
          setFileTree(tree);
          // Final progress commit - set to 100% when complete
          setLoadingProgress({
            loaded: progressRef.current.loaded,
            total: progressRef.current.loaded, // Use loaded as total for accurate 100%
            currentPath: progressRef.current.currentPath,
            phase: progressRef.current.phase,
            percentage: 100,
          });

          // Cache the tree for future loads
          saveToCache(cacheKey, tree);
        }
      } catch (err) {
        handleLoadError(err, setError, setFileTree);
      } finally {
        setIsLoading(false);
        setIsCancelling(false);
        abortControllerRef.current = null;
      }
    },
    [rootDirectoryHandle, readFullTree, fileSystemAdapter]
  );

  const refreshTree = useCallback(async () => {
    // Skip cache on manual refresh to ensure fresh data
    await loadTree(true);
  }, [loadTree]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  return {
    fileTree,
    isLoading,
    error,
    refreshTree,
    loadingProgress,
    cancellable: isLoading && !isCancelling,
    cancelOperation,
    isCancelling,
  };
}
