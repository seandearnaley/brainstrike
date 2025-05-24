import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { PartialRefreshError } from '@brainstrike/types';
import { fileFilter } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAdapters } from './adapters-context';

// Batch size for progress updates
const PROGRESS_BATCH_SIZE = 25;

export interface LoadingProgressState {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
}

export function useFileTree(rootDirectoryHandle: DirectoryHandle | null) {
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
  const { fileSystemAdapter } = useAdapters();

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
      directoryHandle: DirectoryHandle,
      rootHandle: DirectoryHandle,
      parentPath = '',
      isRoot = true
    ): Promise<IFileNode[]> => {
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

        // Note: We can't easily count entries with the adapter pattern
        // without reading them, so we'll estimate or read progressively
        progressRef.current = {
          loaded: 0,
          total: 1000, // Rough estimate, will adjust as we go
          batchCount: 0,
          currentPath: '',
          phase: 'loading',
        };
        setLoadingProgress({
          loaded: 0,
          total: 1000,
          phase: 'loading',
        });
      }

      try {
        // Use the adapter to read directory contents
        const entries = await fileSystemAdapter.readDirectory(directoryHandle);

        const processedEntries: IFileNode[] = [];

        for (const entry of entries) {
          const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;

          if (fileFilter.shouldIgnorePath(path)) continue;

          try {
            if (entry.type === 'file') {
              processedEntries.push({
                ...entry,
                path,
                depth: path.split('/').length - 1,
                selectionState: 'unchecked',
                rootFolderId,
              });
              stats.successCount++;
              updateProgress(path);
            } else if (entry.type === 'directory') {
              // For directories, we need to create a DirectoryHandle from the IFileNode
              const dirHandle: DirectoryHandle = {
                path,
                name: entry.name,
                kind: 'directory',
                platform: directoryHandle.platform,
                _internal: entry.handle,
              };

              const children = await readFullTree(dirHandle, rootHandle, path, false);
              processedEntries.push({
                ...entry,
                path,
                depth: path.split('/').length - 1,
                children: sortFileNodes(children),
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

        return sortFileNodes(processedEntries);
      } catch (err) {
        console.error('Error reading directory:', err);
        throw err;
      }
    },
    [sortFileNodes, updateProgress, fileSystemAdapter]
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
