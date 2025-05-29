/**
 * File Tree Hook (Context-aware)
 *
 * This hook provides file tree functionality using only the context-based store,
 * avoiding dependencies on the file-explorer-hooks package that uses the old global store.
 */

import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { useFileExplorerStore } from '@brainstrike/file-explorer';
import type { IFileNode } from '@brainstrike/types';
import { fileFilter } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface LoadingProgressState {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
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

export function useFileTree(rootDirectoryHandle: DirectoryHandle | null) {
  const { fileSystemAdapter } = useAdapters();
  const [fileTree, setFileTree] = useState<IFileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const errorRef = useRef<Error | null>(null); // To access error in finally
  const abortControllerRef = useRef<AbortController | null>(null);
  const { setLoadingCancellable, setCancelling, setCancelled } = useFileExplorerStore.getState();

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
    async (
      directoryHandle: DirectoryHandle,
      rootHandle: DirectoryHandle,
      signal: AbortSignal, // Added signal
      parentPath = '',
      isRoot = true
    ): Promise<IFileNode[]> => {
      if (signal.aborted) throw new Error('USER_CANCELLED'); // Check at the beginning

      const rootFolderId = rootHandle.name;

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

      try {
        const entries = await fileSystemAdapter.readDirectory(directoryHandle);
        const processedEntries: IFileNode[] = [];

        for (const entry of entries) {
          if (signal.aborted) throw new Error('USER_CANCELLED'); // Check in loop

          const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

          if (fileFilter.shouldIgnorePath(relativePath)) continue;

          try {
            if (entry.type === 'file') {
              // For Electron, preserve the absolute path from the adapter
              // For web, use the relative path for security/consistency
              const finalPath = directoryHandle.platform === 'electron' ? entry.path : relativePath;

              processedEntries.push({
                ...entry,
                path: finalPath,
                depth: relativePath.split('/').length - 1,
                selectionState: 'unchecked',
                rootFolderId,
              });
              updateProgress(relativePath);
            } else if (entry.type === 'directory') {
              // For Electron, preserve the absolute path from the adapter
              // For web, use the relative path for security/consistency
              const finalPath = directoryHandle.platform === 'electron' ? entry.path : relativePath;

              const dirHandle: DirectoryHandle = {
                path: finalPath,
                name: entry.name,
                kind: 'directory',
                platform: directoryHandle.platform,
                _internal: entry.handle,
              };

              // Pass signal recursively
              const children = await readFullTree(dirHandle, rootHandle, signal, relativePath, false);
              processedEntries.push({
                ...entry,
                path: finalPath,
                depth: relativePath.split('/').length - 1,
                children: sortFileNodes(children),
                selectionState: 'unchecked',
                rootFolderId,
              });
              updateProgress(relativePath);
            }
          } catch (err) {
            console.error(`Error processing ${relativePath}:`, err);
          }
        }

        return sortFileNodes(processedEntries);
      } catch (err) {
        console.error('Error reading directory:', err);
        throw err;
      }
    },
    [fileSystemAdapter, sortFileNodes, updateProgress]
  );

  const loadTree = useCallback(async () => {
    if (!rootDirectoryHandle) {
      setFileTree([]);
      return;
    }

    // Cancel any existing load
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setError(null);
    errorRef.current = null; // Reset error ref
    setLoadingCancellable(true);
    setCancelling(false);
    setCancelled(false);

    try {
      const tree = await readFullTree(rootDirectoryHandle, rootDirectoryHandle, controller.signal);
      if (!controller.signal.aborted) { // Only update tree if not aborted
        setFileTree(tree);
      }
    } catch (err) {
      const currentError = err instanceof Error ? err : new Error(String(err));
      errorRef.current = currentError; // Store error in ref
      if (currentError.message === 'USER_CANCELLED') {
        console.debug('File tree loading cancelled by user.');
        // Do not call setError or clear fileTree if it's a cancellation during refresh
      } else {
        setError(currentError);
        setFileTree([]); // Clear tree for other errors
      }
    } finally {
      setIsLoading(false);
      setLoadingCancellable(false);
      setCancelling(false);
      // Set cancelled based on the error stored in the ref
      setCancelled(errorRef.current?.message === 'USER_CANCELLED');
      if (abortControllerRef.current === controller) { // Clean up controller if it's the current one
        abortControllerRef.current = null;
      }
    }
  }, [rootDirectoryHandle, readFullTree, setLoadingCancellable, setCancelling, setCancelled]);

  const refreshTree = useCallback(async () => {
    // setError(null); // Clear previous non-cancellation errors before refresh
    await loadTree();
  }, [loadTree]);

  const cancelCurrentLoad = useCallback(() => {
    if (abortControllerRef.current) {
      setCancelling(true); // Indicate cancellation is in progress
      abortControllerRef.current.abort();
    }
  }, [setCancelling]);

  useEffect(() => {
    loadTree();
    // Cleanup on unmount
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [loadTree]); // loadTree dependency includes rootDirectoryHandle

  return {
    fileTree,
    isLoading,
    error,
    refreshTree,
    loadingProgress,
    cancelCurrentLoad, // Expose cancellation function
  };
}
