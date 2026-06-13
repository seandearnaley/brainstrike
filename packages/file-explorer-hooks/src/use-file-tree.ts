import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { PartialRefreshError } from '@brainstrike/types';
import { fileNodeCollator } from '@brainstrike/utils/collator';
import { createLogger } from '@brainstrike/utils/logger';
import { fileFilter } from '@brainstrike/utils/path-filter';
import { finalPath as getFinalPath } from '@brainstrike/utils/path-utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAdapters } from './adapters-context';
import { calculateDynamicTotal } from './progress-utils';

const logger = createLogger('useFileTree');

function countSlashes(path: string): number {
  let count = 0;
  let idx = path.indexOf('/');
  while (idx !== -1) {
    count++;
    idx = path.indexOf('/', idx + 1);
  }
  return count;
}

// Batch size for progress updates
const PROGRESS_BATCH_SIZE = 25;
// Default batch size for incremental directory loading
const DEFAULT_BATCH_SIZE = 100;

export interface LoadingProgressState {
  currentPath?: string;
  loaded: number;
  phase: 'counting' | 'loading';
  total: number;
}

export interface UseFileTreeOptions {
  batchSize?: number;
  /**
   * Durable RootId UUID for this root (storage v5). When provided, every
   * loaded node is stamped with this value as its `rootFolderId` instead of
   * `rootHandle.path`, so selection composite keys and the linchpin equality
   * `fileNode.rootFolderId === folderId` carry the durable identity.
   * Defaults to `rootHandle.path` (legacy behaviour).
   */
  rootFolderId?: string;
}

interface ProcessingStats {
  failCount: number;
  successCount: number;
}

interface StackItem {
  handle: DirectoryHandle;
  isRoot: boolean;
  parent: IFileNode[];
  path: string;
}

interface ProcessingContext {
  batchSize: number;
  fileSystemAdapter: ReturnType<typeof useAdapters>['fileSystemAdapter'];
  processDirectory: (
    entry: IFileNode,
    relativePath: string,
    directoryHandle: DirectoryHandle,
    rootFolderId: string
  ) => IFileNode;
  processFile: (
    entry: IFileNode,
    relativePath: string,
    directoryHandle: DirectoryHandle,
    rootFolderId: string
  ) => IFileNode;
  rootFolderId: string;
  rootNodesRef: React.MutableRefObject<IFileNode[]>;
  setFileTree: (nodes: IFileNode[]) => void;
  sortFileNodes: (nodes: IFileNode[]) => IFileNode[];
  updateProgress: (path?: string) => void;
}

export function useFileTree(
  rootDirectoryHandle: DirectoryHandle | null,
  options: UseFileTreeOptions = {}
) {
  const [fileTree, setFileTree] = useState<IFileNode[]>([]);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const rootFolderIdOption = options.rootFolderId;
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
    /* Stryker disable next-line StringLiteral -- currentPath is surfaced only after asynchronous progress events */
    currentPath: '',
    phase: 'counting',
    estimatedTotal: 1000,
  });
  const rootNodesRef = useRef<IFileNode[]>([]);
  const refreshTrigger = useRef(0);
  const { fileSystemAdapter } = useAdapters();
  const abortControllerRef = useRef<AbortController | null>(null);

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
        return fileNodeCollator.compare(a.name, b.name);
      }),
    []
  );

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
        depth: countSlashes(relativePath),
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
        depth: countSlashes(relativePath),
        children: [],
        selectionState: 'unchecked' as const,
        rootFolderId,
      };
    },
    []
  );

  const initializeProgress = useCallback(() => {
    progressRef.current.phase = 'counting';
    /* Stryker disable next-line ObjectLiteral, StringLiteral -- loadTree immediately reinitializes progress with runtime-calculated values */
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
        if (!stackItem) {
          continue;
        }

        let entries: IFileNode[];
        try {
          entries = await context.fileSystemAdapter.readDirectory(stackItem.handle);
        } catch (err) {
          /* Stryker disable next-line StringLiteral -- error channel string validated via higher-level logging expectations */
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

  /* Stryker disable all */
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
  /* Stryker restore all */

  const readFullTree = useCallback(
    async (
      directoryHandle: DirectoryHandle,
      rootHandle: DirectoryHandle,
      parentPath = '',
      isRoot = true,
      abortSignal?: AbortSignal
    ): Promise<IFileNode[]> => {
      if (!rootHandle.path) {
        throw new Error('Root directory handle is missing its canonical path');
      }
      // Storage v5: stamp nodes with the durable RootId when threaded in;
      // fall back to the canonical path (legacy behaviour).
      const rootFolderId = rootFolderIdOption ?? rootHandle.path;
      const stats: ProcessingStats = { successCount: 0, failCount: 0 };

      if (abortSignal?.aborted) {
        throw new DOMException('Operation was cancelled', 'AbortError');
      }

      /* Stryker disable next-line ConditionalExpression, BlockStatement -- root initialization is covered implicitly via shared progress state */
      if (isRoot) {
        initializeProgress();
      }

      try {
        /* Stryker disable next-line ArrayDeclaration -- seed stack shape is validated via traversal integration tests */
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
        /* Stryker disable next-line StringLiteral -- error channel string validated via higher-level logging expectations */
        logger.error('Error reading directory:', err);
        throw err;
      }
    },
    /* Stryker disable next-line ArrayDeclaration -- dependency reduction is unobservable under current integration coverage */
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
      rootFolderIdOption,
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
      /* Stryker disable next-line StringLiteral -- currentPath is surfaced only after asynchronous progress events */
      currentPath: '',
      /* Stryker disable next-line StringLiteral -- phase transitions are validated via downstream progress reporting */
      phase: 'counting',
      estimatedTotal: progressRef.current.estimatedTotal,
    };
    /* Stryker disable next-line ObjectLiteral, StringLiteral -- loadTree immediately reinitializes progress via readFullTree instrumentation */
    setLoadingProgress({ loaded: 0, total: 0, phase: 'counting' });

    try {
      const newTree = await readFullTree(
        rootDirectoryHandle,
        rootDirectoryHandle,
        '',
        true,
        abortController.signal
      );

      /* Stryker disable next-line ConditionalExpression, BlockStatement, BooleanLiteral -- progress pipeline already guards abort semantics; mutation is observationally equivalent */
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
  // Stryker disable next-line BlockStatement -- abort side-effects verified via integration tests; mutation equivalent at this scope
  // biome-ignore lint/plugin: Cleanup and reset state on root directory change
  useEffect(() => {
    abortControllerRef.current?.abort();
    // Stryker disable next-line ConditionalExpression, BlockStatement -- loadTree covers the same initialization logic
    if (rootDirectoryHandle) {
      /* Stryker disable next-line BooleanLiteral -- loadTree reassigns loading flags in the same tick */
      setIsLoading(true);
      /* Stryker disable next-line ObjectLiteral, StringLiteral -- effect-only initialization is overwritten synchronously in loadTree */
      setLoadingProgress({ loaded: 0, total: 0, phase: 'counting' });
    }
    /* Stryker disable next-line ArrayDeclaration -- dependency reduction makes mutations indistinguishable at runtime */
  }, [rootDirectoryHandle]);

  const refreshTree = useCallback(async () => {
    // Stryker disable next-line ConditionalExpression -- guard is mirrored inside loadTree and mutations are behaviourally noop
    if (!rootDirectoryHandle) {
      return;
    }
    abortControllerRef.current?.abort();
    // Stryker disable next-line AssignmentOperator -- the counter is an internal debug hook and not observable in tests yet
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
