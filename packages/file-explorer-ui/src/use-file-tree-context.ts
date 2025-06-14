/**
 * File Tree Hook (Context-aware)
 *
 * This hook provides file tree functionality using only the context-based store,
 * avoiding dependencies on the file-explorer-hooks package that uses the old global store.
 */

import { FileCacheService, FolderService } from '@brainstrike/file-cache';
import { useAdapters, useDatabaseFileLoading } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { fileFilter } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';

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
 * Determines the final path based on platform and entry information
 */
const getFinalPath = (
  directoryHandle: DirectoryHandle,
  entry: IFileNode,
  relativePath: string
): string => {
  // For Electron, preserve the absolute path from the adapter
  // For web, use the relative path for security/consistency
  return directoryHandle.platform === 'electron' ? entry.path : relativePath;
};

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

/**
 * Builds a hierarchical file tree from flat database results
 */
const buildFileTreeFromDatabase = (
  databaseFiles: Array<{
    path: string;
    fileType: string;
    fileSize: number;
    lastModified: Date;
  }>,
  rootFolderId: string
): IFileNode[] => {
  const pathToNode = new Map<string, IFileNode>();
  const rootNodes: IFileNode[] = [];

  // Sort paths to ensure parent directories are processed before children
  const sortedFiles = [...databaseFiles].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const pathParts = file.path.split('/');

    // Build each path segment as a node
    for (let i = 0; i < pathParts.length; i++) {
      const partialPath = pathParts.slice(0, i + 1).join('/');
      const name = pathParts[i] || '';
      const isFile = i === pathParts.length - 1 && file.fileType !== 'directory';

      if (!pathToNode.has(partialPath)) {
        const node: IFileNode = {
          name,
          path: partialPath,
          type: isFile ? 'file' : 'directory',
          handle: {} as FileSystemFileHandle | FileSystemDirectoryHandle, // Dummy handle for database nodes
          depth: i,
          selectionState: 'unchecked',
          rootFolderId,
          isVisible: true,
          ...(isFile ? {} : { children: [] as IFileNode[] }),
          ...(isFile && file.fileSize !== undefined ? { size: file.fileSize } : {}),
          ...(isFile && file.lastModified ? { lastModified: file.lastModified.getTime() } : {}),
        };

        pathToNode.set(partialPath, node);

        // Add to parent's children or root
        if (i === 0) {
          rootNodes.push(node);
        } else {
          const parentPath = pathParts.slice(0, i).join('/');
          const parent = pathToNode.get(parentPath);
          if (parent?.children) {
            parent.children.push(node);
          }
        }
      }
    }
  }

  // Sort nodes at each level (directories first, then alphabetical)
  const sortNodes = (nodes: IFileNode[]): IFileNode[] => {
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        if (a.type === 'directory') return -1;
        if (b.type === 'directory') return 1;
      }
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  };

  const applySortRecursively = (nodes: IFileNode[]): IFileNode[] => {
    const sorted = sortNodes(nodes);
    for (const node of sorted) {
      if (node.children) {
        node.children = applySortRecursively(node.children);
      }
    }
    return sorted;
  };

  return applySortRecursively(rootNodes);
};

export function useFileTree(rootDirectoryHandle: DirectoryHandle | null): CancellableFileTreeHook {
  const { fileSystemAdapter, storageAdapter } = useAdapters();
  // Keep for any future database loading state - we'll need this hook later for database sync
  useDatabaseFileLoading();
  const store = useFileExplorerStoreContext();
  const { databaseMode } = store((s) => ({ databaseMode: s.databaseMode }));

  // Create FolderService instance
  const folderService = useMemo(() => {
    if (storageAdapter) {
      // Create config for FileCacheService based on environment
      const isWeb = typeof window !== 'undefined' && typeof document !== 'undefined';
      const config = {
        dataDir: isWeb ? 'idb://brainstrike-cache' : './cache',
        pgOptions: {
          relaxedDurability: true,
          debug: false,
        },
        tableName: 'cached_files',
      };

      const cacheService = new FileCacheService(config);
      return new FolderService(cacheService);
    }
    return null;
  }, [storageAdapter]);

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

  const processFileEntry = useCallback(
    (
      entry: IFileNode,
      relativePath: string,
      directoryHandle: DirectoryHandle,
      rootFolderId: string
    ): IFileNode => {
      const finalPath = getFinalPath(directoryHandle, entry, relativePath);

      return {
        ...entry,
        path: finalPath,
        depth: relativePath.split('/').length - 1,
        selectionState: 'unchecked' as const,
        rootFolderId,
      };
    },
    []
  );

  const processDirectoryEntry = useCallback(
    async (
      entry: IFileNode,
      relativePath: string,
      directoryHandle: DirectoryHandle,
      rootHandle: DirectoryHandle,
      rootFolderId: string,
      abortSignal?: AbortSignal
    ): Promise<IFileNode> => {
      const finalPath = getFinalPath(directoryHandle, entry, relativePath);

      const dirHandle: DirectoryHandle = {
        path: finalPath,
        name: entry.name,
        kind: 'directory',
        platform: directoryHandle.platform,
        _internal: entry.handle,
      };

      const children = await readFullTree(dirHandle, rootHandle, relativePath, false, abortSignal);

      return {
        ...entry,
        path: finalPath,
        depth: relativePath.split('/').length - 1,
        children: sortFileNodes(children),
        selectionState: 'unchecked' as const,
        rootFolderId,
      };
    },
    [sortFileNodes]
  );

  const readFullTree = useCallback(
    async (
      directoryHandle: DirectoryHandle,
      rootHandle: DirectoryHandle,
      parentPath = '',
      isRoot = true,
      abortSignal?: AbortSignal
    ): Promise<IFileNode[]> => {
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

      // Check for cancellation
      if (abortSignal?.aborted) {
        throw new Error('Operation was cancelled');
      }

      try {
        const entries = await fileSystemAdapter.readDirectory(directoryHandle);
        const processedEntries: IFileNode[] = [];

        for (const entry of entries) {
          // Check for cancellation before processing each entry
          if (abortSignal?.aborted) {
            throw new Error('Operation was cancelled');
          }

          const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

          if (fileFilter.shouldIgnorePath(relativePath)) continue;

          try {
            if (entry.type === 'file') {
              const fileNode = processFileEntry(entry, relativePath, directoryHandle, rootFolderId);
              processedEntries.push(fileNode);
              updateProgress(relativePath);
            } else if (entry.type === 'directory') {
              const dirNode = await processDirectoryEntry(
                entry,
                relativePath,
                directoryHandle,
                rootHandle,
                rootFolderId,
                abortSignal
              );
              processedEntries.push(dirNode);
              updateProgress(relativePath);
            }
          } catch (err) {
            // If it's a cancellation error, re-throw it
            if (isCancellationError(err)) {
              throw err;
            }
            console.error(`Error processing ${relativePath}:`, err);
          }
        }

        return sortFileNodes(processedEntries);
      } catch (err) {
        // If it's a cancellation error, re-throw it
        if (isCancellationError(err)) {
          throw err;
        }
        console.error('Error reading directory:', err);
        throw err;
      }
    },
    [fileSystemAdapter, sortFileNodes, updateProgress, processFileEntry, processDirectoryEntry]
  );

  const loadTreeFromDatabase = useCallback(
    async (folderId: string) => {
      try {
        setLoadingProgress({
          loaded: 0,
          total: 100,
          phase: 'loading',
        });

        if (!folderService) {
          throw new Error('FolderService not available');
        }

        // Access the cache through reflection since it's private
        // biome-ignore lint/suspicious/noExplicitAny: FolderService cache is private, need to access via reflection
        const cacheService = (folderService as any).cache as FileCacheService;
        const databaseFiles = await cacheService.getFolderContents(folderId);

        if (databaseFiles.length === 0) {
          setFileTree([]);
          return;
        }

        const tree = buildFileTreeFromDatabase(databaseFiles, folderId);
        setFileTree(tree);

        setLoadingProgress({
          loaded: databaseFiles.length,
          total: databaseFiles.length,
          phase: 'loading',
        });
      } catch (err) {
        const error = ensureError(err);
        console.error('Error loading tree from database:', error);
        setError(error);
        setFileTree([]);
      }
    },
    [folderService]
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
      const folderId = rootDirectoryHandle.name;

      // Check if we should load from database first
      if (databaseMode && folderService) {
        try {
          await loadTreeFromDatabase(folderId);
          return; // Successfully loaded from database
        } catch (err) {
          console.warn('Failed to load from database, falling back to file system:', err);
          // Continue to file system loading below
        }
      }

      // Load from file system (either not in database mode or database failed)
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
  }, [rootDirectoryHandle, databaseMode, folderService, loadTreeFromDatabase, readFullTree]);

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
    cancellable: isLoading && !isCancelling,
    cancelOperation,
    isCancelling,
  };
}
