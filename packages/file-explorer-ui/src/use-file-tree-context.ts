/**
 * File Tree Hook (Context-aware)
 *
 * This hook provides file tree functionality using only the context-based store,
 * avoiding dependencies on the file-explorer-hooks package that uses the old global store.
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { fileFilter } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface LoadingProgressState {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
}

// Mock adapters context since we can't import the real one easily
const mockFileSystemAdapter = {
  async readDirectory(handle: DirectoryHandle) {
    if (!handle._internal) {
      throw new Error('No internal handle available');
    }

    const entries: Array<{ name: string; type: 'file' | 'directory'; handle?: FileSystemHandle }> =
      [];

    try {
      // Use the File System Access API directly
      for await (const [name, entryHandle] of (
        handle._internal as FileSystemDirectoryHandle
      ).entries()) {
        entries.push({
          name,
          type: entryHandle.kind,
          handle: entryHandle,
        });
      }
    } catch (error) {
      console.error('Error reading directory:', error);
      throw error;
    }

    return entries;
  },
};

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
    currentPath: string;
    phase: LoadingProgressState['phase'];
  }>({
    loaded: 0,
    total: 0,
    currentPath: '',
    phase: 'counting',
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
      parentPath = '',
      isRoot = true
    ): Promise<IFileNode[]> => {
      const rootFolderId = rootHandle.name;

      if (isRoot) {
        progressRef.current.phase = 'loading';
        progressRef.current.loaded = 0;
        progressRef.current.total = 100; // Estimate
        setLoadingProgress({
          loaded: 0,
          total: 100,
          phase: 'loading',
        });
      }

      try {
        const entries = await mockFileSystemAdapter.readDirectory(directoryHandle);
        const processedEntries: IFileNode[] = [];

        for (const entry of entries) {
          const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;

          if (fileFilter.shouldIgnorePath(path)) continue;

          try {
            if (entry.type === 'file') {
              processedEntries.push({
                name: entry.name,
                path,
                type: 'file',
                depth: path.split('/').length - 1,
                selectionState: 'unchecked',
                rootFolderId,
                handle: entry.handle as FileSystemFileHandle,
              });
              updateProgress(path);
            } else if (entry.type === 'directory') {
              const dirHandle: DirectoryHandle = {
                path,
                name: entry.name,
                kind: 'directory',
                platform: directoryHandle.platform,
                _internal: entry.handle,
              };

              const children = await readFullTree(dirHandle, rootHandle, path, false);
              processedEntries.push({
                name: entry.name,
                path,
                type: 'directory',
                depth: path.split('/').length - 1,
                children: sortFileNodes(children),
                selectionState: 'unchecked',
                rootFolderId,
                handle: entry.handle as FileSystemDirectoryHandle,
              });
              updateProgress(path);
            }
          } catch (err) {
            console.error(`Error processing ${path}:`, err);
          }
        }

        return sortFileNodes(processedEntries);
      } catch (err) {
        console.error('Error reading directory:', err);
        throw err;
      }
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

    try {
      const tree = await readFullTree(rootDirectoryHandle, rootDirectoryHandle);
      setFileTree(tree);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      setFileTree([]);
    } finally {
      setIsLoading(false);
    }
  }, [rootDirectoryHandle, readFullTree]);

  const refreshTree = useCallback(async () => {
    await loadTree();
  }, [loadTree]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  return {
    fileTree,
    isLoading,
    error,
    refreshTree,
    loadingProgress,
  };
}
