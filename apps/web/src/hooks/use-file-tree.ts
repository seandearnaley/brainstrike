import type { IFileNode } from '@brainstrike/types';
import { PartialRefreshError } from '@brainstrike/types';
import { fileFilter } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

// Batch size for progress updates
const PROGRESS_BATCH_SIZE = 25;

export interface LoadingProgressState {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
}

export function useFileTree(rootDirectoryHandle: FileSystemDirectoryHandle | null) {
  const [fileTree, setFileTree] = useState<IFileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgressState>({
    loaded: 0,
    total: 0,
    phase: 'counting',
  });
  const progressRef = useRef<{
    loaded: number;
    total: number;
    batchCount: number;
    currentPath: string;
    phase: LoadingProgressState['phase'];
  }>({
    loaded: 0,
    total: 0,
    batchCount: 0,
    currentPath: '',
    phase: 'counting',
  });
  const refreshTrigger = useRef(0);

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
    progressRef.current.batchCount += 1;
    if (path) {
      progressRef.current.currentPath = path;
    }

    // Update UI when batch size reached or at 100%
    if (
      progressRef.current.batchCount >= PROGRESS_BATCH_SIZE ||
      progressRef.current.loaded === progressRef.current.total ||
      path // Always update when path changes
    ) {
      setLoadingProgress({
        loaded: progressRef.current.loaded,
        total: progressRef.current.total,
        currentPath: progressRef.current.currentPath,
        phase: progressRef.current.phase,
      });
      progressRef.current.batchCount = 0;
    }
  }, []);

  const readFullTree = useCallback(
    async (
      directoryHandle: FileSystemDirectoryHandle,
      rootHandle: FileSystemDirectoryHandle,
      parentPath = '',
      isRoot = true
    ): Promise<IFileNode[]> => {
      const entries: IFileNode[] = [];
      const rootFolderId = rootHandle.name;
      const stats = { successCount: 0, failCount: 0 };

      // For root directory, count total entries first
      if (isRoot) {
        progressRef.current.phase = 'counting';
        setLoadingProgress({
          loaded: 0,
          total: 0,
          phase: 'counting',
        });

        let totalEntries = 0;
        const countStack = [directoryHandle];

        while (countStack.length > 0) {
          const currentDir = countStack.pop();
          if (!currentDir) continue;

          for await (const [name, handle] of currentDir.entries()) {
            const path = parentPath ? `${parentPath}/${name}` : name;
            if (fileFilter.shouldIgnorePath(path)) continue;

            totalEntries++; // Count both files and directories
            if (handle.kind === 'directory') {
              countStack.push(handle as FileSystemDirectoryHandle);
            }
          }
        }

        progressRef.current = {
          loaded: 0,
          total: totalEntries,
          batchCount: 0,
          currentPath: '',
          phase: 'loading',
        };
        setLoadingProgress({
          loaded: 0,
          total: totalEntries,
          phase: 'loading',
        });
      }

      // Process entries
      for await (const [name, handle] of directoryHandle.entries()) {
        const path = parentPath ? `${parentPath}/${name}` : name;
        if (fileFilter.shouldIgnorePath(path)) continue;

        try {
          if (handle.kind === 'file') {
            await (handle as FileSystemFileHandle).getFile();
            entries.push({
              name,
              path,
              depth: path.split('/').length - 1,
              type: 'file',
              handle: handle as FileSystemFileHandle,
              selectionState: 'unchecked',
              rootFolderId,
            });
            stats.successCount++;
            updateProgress(path);
          } else if (handle.kind === 'directory') {
            const children = await readFullTree(
              handle as FileSystemDirectoryHandle,
              rootHandle,
              path,
              false
            );
            entries.push({
              name,
              path,
              depth: path.split('/').length - 1,
              type: 'directory',
              children: sortFileNodes(children),
              handle: handle as FileSystemDirectoryHandle,
              selectionState: 'unchecked',
              rootFolderId,
            });
            updateProgress(path);
          }
        } catch (err) {
          console.error(`Error processing ${path}:`, err);
          stats.failCount++;
        }
      }

      // Handle errors
      if (stats.failCount > 0 && stats.successCount > 0) {
        throw new PartialRefreshError(
          `Partially refreshed file tree. ${stats.successCount} files processed successfully, ${stats.failCount} failed.`,
          stats.successCount,
          stats.failCount
        );
      }

      if (stats.failCount > 0 && stats.successCount === 0) {
        throw new Error('Failed to refresh file tree. No files were processed successfully.');
      }

      return sortFileNodes(entries);
    },
    [sortFileNodes, updateProgress]
  );

  const loadTree = useCallback(async () => {
    if (!rootDirectoryHandle) {
      setFileTree([]);
      return;
    }

    setIsLoading(true);
    setError(null);
    progressRef.current = {
      loaded: 0,
      total: 0,
      batchCount: 0,
      currentPath: '',
      phase: 'counting',
    };
    setLoadingProgress({ loaded: 0, total: 0, phase: 'counting' });

    try {
      const newTree = await readFullTree(rootDirectoryHandle, rootDirectoryHandle);
      setFileTree(newTree);
    } catch (err) {
      console.error('Error loading file tree:', err);
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [rootDirectoryHandle, readFullTree]);

  // Reset loading state when root directory changes
  useEffect(() => {
    if (rootDirectoryHandle) {
      setIsLoading(true);
      setLoadingProgress({ loaded: 0, total: 0, phase: 'counting' });
    }
  }, [rootDirectoryHandle]);

  const refreshTree = useCallback(async () => {
    if (!rootDirectoryHandle) return;
    refreshTrigger.current += 1;
    await loadTree();
  }, [rootDirectoryHandle, loadTree]);

  useEffect(() => {
    loadTree().catch((err) => {
      console.error('Error in initial tree load:', err);
    });
  }, [loadTree]);

  return {
    fileTree,
    isLoading,
    error,
    refreshTree,
    loadingProgress,
  };
}
