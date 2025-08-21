import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { PartialRefreshError } from '@brainstrike/types';
import { createLogger, fileFilter, finalPath as getFinalPath } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAdapters } from './adapters-context';
import { calculateDynamicTotal } from './progress-utils';

const logger = createLogger('useFileTree');

// Batch size for progress updates
const PROGRESS_BATCH_SIZE = 25;
// Default batch size for incremental directory loading
const DEFAULT_BATCH_SIZE = 100;

export interface LoadingProgressState {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
}

export interface UseFileTreeOptions {
  batchSize?: number;
}

interface ProcessingStats {
  successCount: number;
  failCount: number;
}

interface StackItem {
  handle: DirectoryHandle;
  parent: IFileNode[];
  isRoot: boolean;
  path: string;
}

interface ProcessingContext {
  rootFolderId: string;
  batchSize: number;
  fileSystemAdapter: ReturnType<typeof useAdapters>['fileSystemAdapter'];
  updateProgress: (path?: string) => void;
  processFile: (
    entry: IFileNode,
    relativePath: string,
    directoryHandle: DirectoryHandle,
    rootFolderId: string
  ) => IFileNode;
  processDirectory: (
    entry: IFileNode,
    relativePath: string,
    directoryHandle: DirectoryHandle,
    rootFolderId: string
  ) => IFileNode;
  setFileTree: (nodes: IFileNode[]) => void;
  sortFileNodes: (nodes: IFileNode[]) => IFileNode[];
  rootNodesRef: React.MutableRefObject<IFileNode[]>;
}

export function useFileTree(
  rootDirectoryHandle: DirectoryHandle | null,
  options: UseFileTreeOptions = {}
) {
  const [fileTree, setFileTree] = useState<IFileNode[]>([]);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
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
    estimatedTotal: number;
  }>({
    loaded: 0,
    total: 0,
    batchCount: 0,
    currentPath: '',
    phase: 'counting',
    estimatedTotal: 1000,
  });
  const rootNodesRef = useRef<IFileNode[]>([]);
  const refreshTrigger = useRef(0);
  const { fileSystemAdapter } = useAdapters();
  const abortControllerRef = useRef<AbortController | null>(null);

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

    // Dynamically adjust total if we exceed the current estimate
    progressRef.current.total = calculateDynamicTotal(
      progressRef.current.total,
      progressRef.current.loaded
    );

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

  const processFile = useCallback(
    (
      entry: IFileNode,
      relativePath: string,
      directoryHandle: DirectoryHandle,
      rootFolderId: string
    ): IFileNode => {
      const finalPath = getFinalPath(directoryHandle.platform, entry.path, relativePath);
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

  const processDirectory = useCallback(
    (
      entry: IFileNode,
      relativePath: string,
      directoryHandle: DirectoryHandle,
      rootFolderId: string
    ): IFileNode => {
      const finalPath = getFinalPath(directoryHandle.platform, entry.path, relativePath);
      return {
        ...entry,
        path: finalPath,
        depth: relativePath.split('/').length - 1,
        children: [],
        selectionState: 'unchecked' as const,
        rootFolderId,
      };
    },
    []
  );

  const initializeProgress = useCallback(() => {
    progressRef.current.phase = 'counting';
    setLoadingProgress({ loaded: 0, total: 0, phase: 'counting' });

    progressRef.current = {
      loaded: 0,
      total: progressRef.current.estimatedTotal,
      batchCount: 0,
      currentPath: '',
      phase: 'loading',
      estimatedTotal: progressRef.current.estimatedTotal,
    };

    setLoadingProgress({
      loaded: 0,
      total: progressRef.current.estimatedTotal,
      phase: 'loading',
    });
  }, []);

  const handleBatchUpdate = useCallback(
    async (batchCounter: number, isRoot: boolean): Promise<number> => {
      if (isRoot && batchCounter >= batchSize) {
        setFileTree(sortFileNodes([...rootNodesRef.current]));
        await new Promise((r) => setTimeout(r));
        return 0;
      }
      return batchCounter;
    },
    [batchSize, sortFileNodes]
  );

  const updateBatchAndProgress = useCallback(
    async (
      node: IFileNode,
      relativePath: string,
      isRoot: boolean,
      currentBatchCounter: number,
      context: ProcessingContext,
      stats: ProcessingStats
    ): Promise<number> => {
      if (isRoot) {
        context.rootNodesRef.current.push(node);
        const newBatchCounter = currentBatchCounter + 1;
        const updatedBatchCounter = await handleBatchUpdate(newBatchCounter, isRoot);
        // Count only files as successful content units
        if (node.type === 'file') {
          stats.successCount++;
        }
        context.updateProgress(relativePath);
        return updatedBatchCounter;
      }

      // Count only files as successful content units
      if (node.type === 'file') {
        stats.successCount++;
      }
      context.updateProgress(relativePath);
      return currentBatchCounter;
    },
    [handleBatchUpdate]
  );

  const processSingleEntry = useCallback(
    async (
      entry: IFileNode,
      stackItem: StackItem,
      stack: StackItem[],
      currentBatchCounter: number,
      context: ProcessingContext,
      stats: ProcessingStats
    ): Promise<number> => {
      const { handle, parent, isRoot, path } = stackItem;
      const relativePath = path ? `${path}/${entry.name}` : entry.name;

      if (fileFilter.shouldIgnorePath(relativePath)) {
        return currentBatchCounter;
      }

      try {
        if (entry.type === 'file') {
          const node = context.processFile(entry, relativePath, handle, context.rootFolderId);
          parent.push(node);
          return await updateBatchAndProgress(
            node,
            relativePath,
            isRoot,
            currentBatchCounter,
            context,
            stats
          );
        }

        if (entry.type === 'directory') {
          const node = context.processDirectory(entry, relativePath, handle, context.rootFolderId);

          const dirHandle: DirectoryHandle = {
            path: node.path,
            name: entry.name,
            kind: 'directory',
            platform: handle.platform,
            _internal: entry.handle,
          };

          // Defer reading until the stack pop; failures handled centrally
          if (node.children) {
            stack.push({
              handle: dirHandle,
              parent: node.children,
              isRoot: false,
              path: relativePath,
            });
          }

          parent.push(node);
          return await updateBatchAndProgress(
            node,
            relativePath,
            isRoot,
            currentBatchCounter,
            context,
            stats
          );
        }

        return currentBatchCounter;
      } catch (err) {
        logger.error(`Error processing ${entry.type} ${relativePath}:`, err);
        stats.failCount++;
        return currentBatchCounter;
      }
    },
    [updateBatchAndProgress]
  );

  const processDirectoryEntries = useCallback(
    async (
      entries: IFileNode[],
      stackItem: StackItem,
      stack: StackItem[],
      initialBatchCounter: number,
      context: ProcessingContext,
      stats: ProcessingStats,
      abortSignal?: AbortSignal
    ): Promise<number> => {
      let currentBatchCounter = initialBatchCounter;

      for (const entry of entries) {
        if (abortSignal?.aborted) {
          throw new DOMException('Operation was cancelled', 'AbortError');
        }

        currentBatchCounter = await processSingleEntry(
          entry,
          stackItem,
          stack,
          currentBatchCounter,
          context,
          stats
        );
      }

      return currentBatchCounter;
    },
    [processSingleEntry]
  );

  const processDirectoryStack = useCallback(
    async (
      stack: StackItem[],
      context: ProcessingContext,
      stats: ProcessingStats,
      abortSignal?: AbortSignal
    ): Promise<void> => {
      let currentBatchCounter = 0;

      while (stack.length > 0) {
        if (abortSignal?.aborted) {
          throw new DOMException('Operation was cancelled', 'AbortError');
        }

        const stackItem = stack.pop();
        if (!stackItem) continue;

        let entries: IFileNode[];
        try {
          entries = await context.fileSystemAdapter.readDirectory(stackItem.handle);
        } catch (err) {
          logger.error('Error reading directory:', err);
          stats.failCount++;
          continue;
        }

        // Sort entries before processing them to ensure consistent ordering
        entries = context.sortFileNodes(entries);

        currentBatchCounter = await processDirectoryEntries(
          entries,
          stackItem,
          stack,
          currentBatchCounter,
          context,
          stats,
          abortSignal
        );
      }

      // Final batch update if needed
      if (context.rootNodesRef.current.length > 0 && currentBatchCounter > 0) {
        context.setFileTree(context.sortFileNodes([...context.rootNodesRef.current]));
      }
    },
    [processDirectoryEntries]
  );

  const handleProcessingResults = useCallback((stats: ProcessingStats) => {
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
  }, []);

  const readFullTree = useCallback(
    async (
      directoryHandle: DirectoryHandle,
      rootHandle: DirectoryHandle,
      parentPath = '',
      isRoot = true,
      abortSignal?: AbortSignal
    ): Promise<IFileNode[]> => {
      const rootFolderId = rootHandle.name;
      const stats: ProcessingStats = { successCount: 0, failCount: 0 };

      if (abortSignal?.aborted) {
        throw new DOMException('Operation was cancelled', 'AbortError');
      }

      if (isRoot) {
        initializeProgress();
      }

      try {
        const stack: StackItem[] = [
          { handle: directoryHandle, parent: [], isRoot, path: parentPath },
        ];

        const context: ProcessingContext = {
          rootFolderId,
          batchSize,
          fileSystemAdapter,
          updateProgress,
          processFile,
          processDirectory,
          setFileTree,
          sortFileNodes,
          rootNodesRef,
        };

        await processDirectoryStack(stack, context, stats, abortSignal);

        handleProcessingResults(stats);

        return sortFileNodes(rootNodesRef.current);
      } catch (err) {
        logger.error('Error reading directory:', err);
        throw err;
      }
    },
    [
      initializeProgress,
      processDirectoryStack,
      handleProcessingResults,
      sortFileNodes,
      updateProgress,
      fileSystemAdapter,
      batchSize,
      processFile,
      processDirectory,
    ]
  );

  const loadTree = useCallback(async () => {
    if (!rootDirectoryHandle) {
      setFileTree([]);
      return;
    }

    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsLoading(true);
    setError(null);
    rootNodesRef.current = [];
    setFileTree([]);
    progressRef.current = {
      loaded: 0,
      total: 0,
      batchCount: 0,
      currentPath: '',
      phase: 'counting',
      estimatedTotal: progressRef.current.estimatedTotal,
    };
    setLoadingProgress({ loaded: 0, total: 0, phase: 'counting' });

    try {
      const newTree = await readFullTree(
        rootDirectoryHandle,
        rootDirectoryHandle,
        '',
        true,
        abortController.signal
      );

      if (!abortController.signal.aborted) {
        setFileTree(newTree);
      }
    } catch (err) {
      logger.error('Error loading file tree:', err);
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  }, [rootDirectoryHandle, readFullTree]);

  // Reset loading state when root directory changes
  useEffect(() => {
    abortControllerRef.current?.abort();
    if (rootDirectoryHandle) {
      setIsLoading(true);
      setLoadingProgress({ loaded: 0, total: 0, phase: 'counting' });
    }
  }, [rootDirectoryHandle]);

  const refreshTree = useCallback(async () => {
    if (!rootDirectoryHandle) return;
    abortControllerRef.current?.abort();
    refreshTrigger.current += 1;
    await loadTree();
  }, [rootDirectoryHandle, loadTree]);

  useEffect(() => {
    loadTree().catch((err) => {
      logger.error('Error in initial tree load:', err);
    });
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [loadTree]);

  return {
    fileTree,
    isLoading,
    error,
    refreshTree,
    loadingProgress,
  };
}
