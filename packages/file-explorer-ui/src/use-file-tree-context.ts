/**
 * File Tree Hook (Context-aware)
 *
 * This hook provides file tree functionality using only the context-based store,
 * avoiding dependencies on the file-explorer-hooks package that uses the old global store.
 */

import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readFullTree as readFullTreeUtil } from './utils/read-full-tree';

export interface LoadingProgressState {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
}

export interface CancellableFileTreeHook {
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
}

/**
 * Calculates the new total estimate when the current loaded count exceeds the estimate.
 * Ensures the total is always at least the loaded count, with some buffer.
 */
export function calculateDynamicTotal(currentTotal: number, loaded: number): number {
  if (loaded <= currentTotal) {
    return currentTotal;
  }

  // Ensure total is at least the loaded count plus a buffer
  const bufferPercentage = 0.25; // 25% buffer
  const minBuffer = 100;

  const buffer = Math.max(Math.ceil(loaded * bufferPercentage), minBuffer);

  return loaded + buffer;
}

/**
 * Safely calculates percentage avoiding division by zero.
 */
export function calculateProgressPercentage(loaded: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((loaded / total) * 100);
}

/**
 * Checks if an error is a cancellation error
 */
const isCancellationError = (error: unknown): boolean => {
  return error instanceof Error && error.message === 'Operation was cancelled';
};

/**
 * Safely converts any error to an Error instance
 */
const ensureError = (err: unknown): Error => {
  return err instanceof Error ? err : new Error(String(err));
};

export function useFileTree(rootDirectoryHandle: DirectoryHandle | null): CancellableFileTreeHook {
  const { fileSystemAdapter } = useAdapters();

  if (!fileSystemAdapter) {
    throw new Error('File system adapter is not available');
  }
  const [fileTree, setFileTree] = useState<IFileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgressState>({
    loaded: 0,
    total: 0,
    phase: 'counting',
  });

  const progressRef = useRef<{
    loaded: number;
    total: number;
    currentPath: string;
    phase: LoadingProgressState['phase'];
    estimatedTotal: number;
  }>({
    loaded: 0,
    total: 0,
    currentPath: '',
    phase: 'counting',
    estimatedTotal: 100,
  });

  // AbortController for cancelling operations
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancelOperation = useCallback(() => {
    if (abortControllerRef.current && isLoading && !isCancelling) {
      setIsCancelling(true);
      abortControllerRef.current.abort();
    }
  }, [isLoading, isCancelling]);

  const sortFileNodes = useCallback((nodes: IFileNode[]): IFileNode[] => {
    return [...nodes].sort((a, b) => {
      if (a.type !== b.type) {
        if (a.type === 'directory') return -1;
        if (b.type === 'directory') return 1;
      }
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }, []);

  const updateProgress = useCallback((path?: string) => {
    progressRef.current.loaded += 1;
    if (path) {
      progressRef.current.currentPath = path;
    }

    // Dynamically adjust total if we exceed the current estimate
    progressRef.current.total = calculateDynamicTotal(
      progressRef.current.total,
      progressRef.current.loaded
    );

    setLoadingProgress({
      loaded: progressRef.current.loaded,
      total: progressRef.current.total,
      currentPath: progressRef.current.currentPath,
      phase: progressRef.current.phase,
    });
  }, []);

  const readFullTree = useCallback(
    (
      directoryHandle: DirectoryHandle,
      rootHandle: DirectoryHandle,
      parentPath = '',
      isRoot = true,
      abortSignal?: AbortSignal
    ): Promise<IFileNode[]> => {
      if (isRoot) {
        progressRef.current.phase = 'loading';
        progressRef.current.loaded = 0;
        progressRef.current.total = progressRef.current.estimatedTotal;
        setLoadingProgress({
          loaded: 0,
          total: progressRef.current.estimatedTotal,
          phase: 'loading',
        });
      }

      return readFullTreeUtil(
        fileSystemAdapter,
        directoryHandle,
        rootHandle,
        parentPath,
        isRoot,
        abortSignal,
        updateProgress,
        sortFileNodes
      );
    },
    [fileSystemAdapter, sortFileNodes, updateProgress]
  );

  const loadTree = useCallback(async () => {
    if (!rootDirectoryHandle) {
      setFileTree([]);
      return;
    }

    // Create new AbortController for this operation
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsLoading(true);
    setIsCancelling(false);
    setError(null);

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
      }
    } catch (err) {
      const error = ensureError(err);

      // Handle cancellation differently from other errors
      if (isCancellationError(error)) {
        setFileTree([]); // Clear the tree on cancellation
      } else {
        setError(error);
        setFileTree([]);
      }
    } finally {
      setIsLoading(false);
      setIsCancelling(false);
      abortControllerRef.current = null;
    }
  }, [rootDirectoryHandle, readFullTree]);

  const refreshTree = useCallback(async () => {
    await loadTree();
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
