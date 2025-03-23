import type { IFileNode } from '@/lib/file/types';
import { fileFilter } from '@/lib/utils/filter';
import { PartialRefreshError } from '@/types/errors';
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

  // Special function to handle Electron path
  const loadElectronTree = useCallback(async (rootHandle: FileSystemDirectoryHandle) => {
    // Check if this is an Electron handle
    if (!('_electronPath' in rootHandle)) {
      return null; // Not an Electron handle
    }
    
    setIsLoading(true);
    setError(null);
    progressRef.current = { 
      loaded: 0, 
      total: 0, 
      batchCount: 0, 
      currentPath: '',
      phase: 'loading' 
    };
    
    try {
      // Get the path from our special _electronPath property
      const dirPath = (rootHandle as any)._electronPath;
      console.log('Loading Electron directory tree from:', dirPath);
      
      // Use our Electron API to list the directory
      if (!window.electronAPI) {
        throw new Error('Electron API not available');
      }
      
      const result = await window.electronAPI.listDirectory(dirPath);
      if (result.error || !result.files) {
        throw new Error(result.error || 'Failed to list directory');
      }
      
      // Convert the flat file list to a tree structure
      const fileNodes: IFileNode[] = [];
      const rootFolderId = rootHandle.name;
      
      // Process files first
      const files = result.files.filter(f => f.type === 'file');
      setLoadingProgress({
        loaded: 0,
        total: files.length,
        phase: 'loading'
      });
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const mockFileHandle = {
          kind: 'file' as 'file',
          name: file.name,
          _electronPath: file.path,
          async getFile() {
            return {
              name: file.name,
              size: file.size,
              lastModified: file.lastModified
            };
          }
        };
        
        fileNodes.push({
          name: file.name,
          path: file.path,
          depth: 1, // Direct children of root
          type: 'file',
          handle: mockFileHandle as unknown as FileSystemFileHandle,
          selectionState: 'unchecked',
          rootFolderId,
          size: file.size,
          lastModified: file.lastModified
        });
        
        // Update progress
        progressRef.current.loaded = i + 1;
        progressRef.current.total = files.length;
        setLoadingProgress({
          loaded: i + 1,
          total: files.length,
          phase: 'loading'
        });
      }
      
      // Process directories (not recursive in this simple implementation)
      const dirs = result.files.filter(f => f.type === 'directory');
      
      for (const dir of dirs) {
        const mockDirHandle = {
          kind: 'directory' as 'directory',
          name: dir.name,
          _electronPath: dir.path,
          async *entries() {
            yield ['_electron_mock_', { kind: 'file', name: '_electron_mock_'}];
          }
        };
        
        fileNodes.push({
          name: dir.name,
          path: dir.path,
          depth: 1, // Direct children of root
          type: 'directory',
          handle: mockDirHandle as unknown as FileSystemDirectoryHandle,
          selectionState: 'unchecked',
          rootFolderId,
          children: [] // Empty for now, we're not recursively loading
        });
      }
      
      return sortFileNodes(fileNodes);
    } catch (error) {
      console.error('Error loading Electron file tree:', error);
      setError(error as Error);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [sortFileNodes]);
  
  const loadTree = useCallback(async () => {
    if (!rootDirectoryHandle) {
      setFileTree([]);
      return;
    }
    
    // Check if this is an Electron handle
    if ('_electronPath' in rootDirectoryHandle) {
      const electronTree = await loadElectronTree(rootDirectoryHandle);
      if (electronTree) {
        setFileTree(electronTree);
        return;
      }
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
