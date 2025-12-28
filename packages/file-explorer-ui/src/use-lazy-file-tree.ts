/**
 * Lazy File Tree Hook
 *
 * Manages file tree state with on-demand directory loading.
 * Only loads immediate children of root initially, then loads
 * subdirectory contents when they are expanded.
 *
 * Performance optimizations for expand-all:
 * - Web Worker handles all CPU-bound tree operations
 * - Main thread handles I/O only (FileSystemHandle operations)
 * - React startTransition for non-blocking UI updates
 */

import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { WorkerFileNode } from '@brainstrike/file-tree-worker';
import {
  type BatchLoadResult,
  createFileTreeWorkerPort,
  type FileTreeWorkerPort,
  resolveFileTreeWorkerUrl,
} from '@brainstrike/file-tree-worker';
import type { DirectoryHandle, IFileNode } from '@brainstrike/types';
import { canLoadNode, createLogger, sortTreeNodes } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

const logger = createLogger('LazyFileTree');

import {
  needsLoading as checkNeedsLoading,
  findNodeByPath,
  loadDirectoryChildren,
  loadRootDirectory,
  setNodeLoadState,
  updateNodeChildren,
} from './utils/lazy-tree-loader';
import {
  addHandlesToMap,
  buildHandleMap,
  type FileSystemHandle,
  rehydrateTree,
  toWorkerFileNodes,
} from './utils/worker-node-conversion';

/**
 * Sort nodes: directories first, then alphabetically.
 * Wraps the generic sortTreeNodes for IFileNode type.
 */
function sortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return sortTreeNodes(nodes);
}

/**
 * Count total nodes in a tree (used for logging).
 */
function countNodes(nodes: WorkerFileNode[] | IFileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.children) {
      count += countNodes(node.children as WorkerFileNode[]);
    }
  }
  return count;
}

/**
 * Count files without handles (used for logging rehydration issues).
 */
function countFilesWithoutHandles(nodes: IFileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'file' && !node.handle) {
      count += 1;
    }
    if (node.children) {
      count += countFilesWithoutHandles(node.children);
    }
  }
  return count;
}

/**
 * Remove a path from the loading paths set.
 */
function removeFromLoadingPaths(paths: Set<string>, path: string): Set<string> {
  const newPaths = new Set(paths);
  newPaths.delete(path);
  return newPaths;
}

/**
 * Check if an error is a cancellation/abort error.
 */
function isOperationCancelled(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  if (err instanceof Error && err.message.includes('abort')) {
    return true;
  }
  return false;
}

/**
 * Get error message from an unknown error.
 */
function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build minimal node info from a path and root info.
 */
function buildNodeFromPath(
  path: string,
  rootPath: string,
  rootName: string,
  handle: FileSystemHandle
): IFileNode {
  const pathSegments = path.replace(rootPath, '').split('/').filter(Boolean);
  const name = pathSegments.at(-1) ?? '';
  const depth = pathSegments.length - 1;

  return {
    name,
    path,
    type: 'directory',
    depth,
    rootFolderId: rootName,
    handle: handle as FileSystemDirectoryHandle,
    selectionState: 'unchecked',
  };
}

/**
 * Log directory load result for debugging.
 */
function logDirectoryLoad(
  path: string,
  children: IFileNode[],
  mapSizeBefore: number,
  mapSizeAfter: number
): void {
  const childrenWithHandles = children.filter((c) => c.handle).length;
  logger.info('expand-all loaded directory', {
    path,
    childrenCount: children.length,
    childrenWithHandles,
    mapSizeBefore,
    mapSizeAfter,
  });
}

/**
 * Log and check for files without handles after tree rehydration.
 */
function logRehydrationResult(
  operation: string,
  handleMapSize: number,
  workerTreeNodes: number,
  rehydratedNodes: number,
  rehydratedTree: IFileNode[]
): void {
  logger.info(`${operation} complete`, { handleMapSize, workerTreeNodes });
  logger.info(`${operation} rehydrated`, { rehydratedNodes });

  const filesWithoutHandles = countFilesWithoutHandles(rehydratedTree);
  if (filesWithoutHandles > 0) {
    logger.warn(`${operation} files missing handles`, { filesWithoutHandles });
  }
}

/**
 * Load a single directory for worker request and append result.
 * Extracted to reduce complexity of the main request handler.
 */
async function loadSingleDirectoryForWorker(
  path: string,
  rootPath: string,
  rootName: string,
  handleMap: Map<string, FileSystemHandle>,
  fileSystemAdapter: ReturnType<typeof useAdapters>['fileSystemAdapter'],
  abortSignal: AbortSignal,
  results: BatchLoadResult[]
): Promise<void> {
  const handle = handleMap.get(path);
  if (!handle) {
    results.push({ path, error: 'Handle not found' });
    return;
  }

  const node = buildNodeFromPath(path, rootPath, rootName, handle);

  try {
    const children = await loadDirectoryChildren(fileSystemAdapter, node, {
      abortSignal,
      sortFileNodes,
    });

    const mapSizeBefore = handleMap.size;
    addHandlesToMap(children, handleMap);
    logDirectoryLoad(path, children, mapSizeBefore, handleMap.size);

    results.push({ path, children: toWorkerFileNodes(children) });
  } catch (err) {
    if (!isOperationCancelled(err)) {
      results.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export type LazyFileTreeState = {
  fileTree: IFileNode[];
  isInitialLoading: boolean;
  error: Error | null;
  loadingPaths: Set<string>;
  /** Whether expand-all operation is in progress */
  isExpandingAll: boolean;
  /** Progress of expand-all operation */
  expandAllProgress: { loaded: number; total: number } | null;
};

export type UseLazyFileTreeReturn = {
  /** Current file tree (lazily loaded) */
  fileTree: IFileNode[];
  /** Whether initial load or any directory is loading */
  isLoading: boolean;
  /** Error from initial load or latest expansion */
  error: Error | null;
  /** Set of paths currently being loaded */
  loadingPaths: Set<string>;
  /** Load root directory contents */
  loadRoot: () => Promise<void>;
  /** Load children of a specific directory on expand */
  loadChildren: (path: string) => Promise<void>;
  /** Check if a directory needs loading */
  needsLoading: (node: IFileNode) => boolean;
  /** Cancel any pending load operations */
  cancelLoading: () => void;
  /** Force refresh a directory (reload its children) */
  refreshDirectory: (path: string) => Promise<void>;
  /** Refresh the entire tree from root */
  refreshTree: () => Promise<void>;
  /** Progressively expand all directories (loads everything) */
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
  ) => Promise<void>;
  /** Cancel expand-all operation */
  cancelExpandAll: () => void;
  /** Whether expand-all is in progress */
  isExpandingAll: boolean;
  /** Progress of expand-all operation */
  expandAllProgress: { loaded: number; total: number } | null;
  /** Load specific paths using worker (for restoration) */
  loadSpecificPaths: (
    paths: string[],
    onProgress?: (loaded: number, total: number, currentPath: string) => void
  ) => Promise<void>;
};

/**
 * Hook for managing lazily-loaded file tree state.
 *
 * Uses a Web Worker for CPU-bound tree operations (expand-all BFS)
 * while keeping I/O operations on the main thread (FileSystemHandle access).
 *
 * @param rootDirectoryHandle - The root directory to load
 * @returns Lazy file tree state and operations
 */
export function useLazyFileTree(
  rootDirectoryHandle: DirectoryHandle | null
): UseLazyFileTreeReturn {
  const { fileSystemAdapter } = useAdapters();

  const [state, setState] = useState<LazyFileTreeState>({
    fileTree: [],
    isInitialLoading: false,
    error: null,
    loadingPaths: new Set(),
    isExpandingAll: false,
    expandAllProgress: null,
  });

  // Track abort controllers for cancellation
  const rootAbortControllerRef = useRef<AbortController | null>(null);
  const childAbortControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Guard against double-clicks on expand-all
  const isExpandAllStartingRef = useRef(false);

  // Ref to track expand-all state for use in effects (avoids stale closure issues)
  const isExpandingAllRef = useRef(false);

  // Use ref to access current tree without adding it as a dependency
  const fileTreeRef = useRef(state.fileTree);
  fileTreeRef.current = state.fileTree;

  // Worker port and handle map for expand-all operations
  const workerPortRef = useRef<FileTreeWorkerPort | null>(null);
  const handleMapRef = useRef<Map<string, FileSystemHandle>>(new Map());

  // Ref for root directory handle (used in worker handlers)
  const rootHandleRef = useRef<DirectoryHandle | null>(null);
  rootHandleRef.current = rootDirectoryHandle;

  // Ref to store setExpandedPaths callback for use in worker handlers
  const setExpandedPathsRef = useRef<
    ((updater: (prev: Set<string>) => Set<string>) => void) | null
  >(null);

  /**
   * Initialize worker and set up handlers
   */
  // biome-ignore lint/plugin: Worker setup requires side effects - not derived state
  useEffect(() => {
    // Create worker
    const worker = new Worker(resolveFileTreeWorkerUrl(), { type: 'module' });
    const port = createFileTreeWorkerPort(worker);
    workerPortRef.current = port;

    // Collect unsubscribe functions for cleanup
    const unsubscribes: (() => void)[] = [];

    // Handle load requests from worker - perform I/O with FileSystemHandles
    unsubscribes.push(
      port.onRequestLoad(async (_requestId, paths) => {
        if (!fileSystemAdapter) {
          return paths.map((path) => ({ path, error: 'No file system adapter' }));
        }

        const results: BatchLoadResult[] = [];
        const abortController = new AbortController();

        // Get root info for building nodes (use ref to get current value)
        const rootPath = rootHandleRef.current?.path ?? '';
        const rootName = rootHandleRef.current?.name ?? '';

        // Load each directory in parallel
        await Promise.all(
          paths.map((path) =>
            loadSingleDirectoryForWorker(
              path,
              rootPath,
              rootName,
              handleMapRef.current,
              fileSystemAdapter,
              abortController.signal,
              results
            )
          )
        );

        return results;
      })
    );

    // Handle tree snapshots from worker
    // PERFORMANCE: We intentionally DO NOT update the React tree during expand-all.
    // Each tree update triggers:
    // 1. rehydrateTree - O(n) walk to add handles back
    // 2. flattenTree in OptimizedFileTree - O(n) walk
    // 3. Various useMemo recomputations with [fileTree] dependency
    // For a tree with 10,000+ nodes, this blocks the main thread.
    // Instead, we only update the tree at COMPLETION (in expandAllProgressively).
    // Progress is shown via expandAllProgress state (updated by onProgress handler).
    unsubscribes.push(
      port.onTreeSnapshot((_workerTree, _expandedPaths) => {
        // Intentionally do nothing - tree and expanded paths are set at completion only
      })
    );

    // Handle progress updates
    unsubscribes.push(
      port.onProgress((loaded, total, _currentPath) => {
        setState((s) => ({
          ...s,
          expandAllProgress: { loaded, total },
        }));
      })
    );

    // Handle errors from worker
    unsubscribes.push(
      port.onError((message, _path) => {
        logger.error('Worker error', { message });
        setState((s) => ({
          ...s,
          error: new Error(message),
        }));
      })
    );

    // Debug logging from worker
    unsubscribes.push(
      port.onLog((level, message, data) => {
        if (level === 'error') {
          logger.error(message, data ?? undefined);
        } else if (level === 'warn') {
          logger.warn(message, data ?? undefined);
        } else if (level === 'info') {
          logger.info(message, data ?? undefined);
        } else {
          logger.debug(message, data ?? undefined);
        }
      })
    );

    return () => {
      // Clean up all handlers before terminating worker
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      port.terminate();
      workerPortRef.current = null;
    };
  }, [fileSystemAdapter]);

  /**
   * Load root directory contents
   */
  const loadRoot = useCallback(async () => {
    if (!(rootDirectoryHandle && fileSystemAdapter)) {
      setState((s) => ({
        ...s,
        fileTree: [],
        isInitialLoading: false,
        error: null,
      }));
      return;
    }

    // Defensive check: skip if expand-all is in progress
    // This prevents a race condition where rootDirectoryHandle changes during expand-all
    // and the effect check passes between expand-all completion and loadRoot execution
    if (isExpandingAllRef.current) {
      logger.info('loadRoot blocked - expand-all in progress');
      return;
    }

    // Cancel any existing root load
    rootAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    rootAbortControllerRef.current = abortController;

    setState((s) => ({
      ...s,
      isInitialLoading: true,
      error: null,
      fileTree: [],
      loadingPaths: new Set(),
    }));

    try {
      const children = await loadRootDirectory(fileSystemAdapter, rootDirectoryHandle, {
        abortSignal: abortController.signal,
        sortFileNodes,
      });

      if (!abortController.signal.aborted) {
        // Build handle map from root children
        handleMapRef.current = buildHandleMap(children);
        logger.info('loadRoot completed - handle map built', {
          handleMapSize: handleMapRef.current.size,
          childrenCount: children.length,
        });

        // Initialize worker with root nodes (filters out loadMore nodes)
        if (workerPortRef.current) {
          const workerNodes = toWorkerFileNodes(children);
          workerPortRef.current.init(workerNodes, rootDirectoryHandle.name);
        }

        setState({
          fileTree: children,
          isInitialLoading: false,
          error: null,
          loadingPaths: new Set(),
          isExpandingAll: false,
          expandAllProgress: null,
        });
      }
    } catch (err) {
      if (!isOperationCancelled(err)) {
        setState((s) => ({
          ...s,
          isInitialLoading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      }
    }
  }, [rootDirectoryHandle, fileSystemAdapter]);

  /**
   * Handle successful directory load.
   */
  const handleLoadSuccess = useCallback((path: string, children: IFileNode[]) => {
    // Add handles to map
    addHandlesToMap(children, handleMapRef.current);

    // Update worker tree (filters out loadMore nodes)
    if (workerPortRef.current) {
      const workerChildren = toWorkerFileNodes(children);
      workerPortRef.current.updateTree(path, workerChildren);
    }

    setState((s) => ({
      ...s,
      fileTree: updateNodeChildren(s.fileTree, path, children, 'loaded'),
      loadingPaths: removeFromLoadingPaths(s.loadingPaths, path),
    }));
  }, []);

  /**
   * Handle directory load error.
   */
  const handleLoadError = useCallback((path: string, errorMsg: string) => {
    setState((s) => ({
      ...s,
      fileTree: setNodeLoadState(s.fileTree, path, 'error', errorMsg),
      loadingPaths: removeFromLoadingPaths(s.loadingPaths, path),
    }));
  }, []);

  /**
   * Set up abort controller for a path and mark as loading.
   */
  const prepareDirectoryLoad = useCallback((path: string): AbortController => {
    childAbortControllersRef.current.get(path)?.abort();
    const abortController = new AbortController();
    childAbortControllersRef.current.set(path, abortController);

    setState((s) => ({
      ...s,
      fileTree: setNodeLoadState(s.fileTree, path, 'loading'),
      loadingPaths: new Set([...s.loadingPaths, path]),
    }));

    return abortController;
  }, []);

  /**
   * Load children of a specific directory
   */
  const loadChildren = useCallback(
    async (path: string) => {
      if (!fileSystemAdapter) {
        return;
      }

      const node = findNodeByPath(fileTreeRef.current, path);
      if (!canLoadNode(node)) {
        return;
      }

      const abortController = prepareDirectoryLoad(path);

      try {
        const children = await loadDirectoryChildren(fileSystemAdapter, node, {
          abortSignal: abortController.signal,
          sortFileNodes,
        });
        // Only update if not aborted
        if (!abortController.signal.aborted) {
          handleLoadSuccess(path, children);
        }
      } catch (err) {
        // Only report non-cancellation errors
        if (!isOperationCancelled(err)) {
          handleLoadError(path, getErrorMessage(err));
        }
      } finally {
        childAbortControllersRef.current.delete(path);
      }
    },
    [fileSystemAdapter, prepareDirectoryLoad, handleLoadSuccess, handleLoadError]
  );

  /**
   * Check if a node needs loading
   */
  const needsLoading = useCallback((node: IFileNode): boolean => checkNeedsLoading(node), []);

  /**
   * Cancel all pending load operations
   */
  const cancelLoading = useCallback(() => {
    rootAbortControllerRef.current?.abort();
    rootAbortControllerRef.current = null;

    for (const controller of childAbortControllersRef.current.values()) {
      controller.abort();
    }
    childAbortControllersRef.current.clear();

    setState((s) => ({
      ...s,
      loadingPaths: new Set(),
    }));
  }, []);

  /**
   * Force refresh a specific directory
   */
  const refreshDirectory = useCallback(
    async (path: string) => {
      if (!fileSystemAdapter) {
        return;
      }

      // Reset to unloaded state first
      setState((s) => ({
        ...s,
        fileTree: setNodeLoadState(s.fileTree, path, 'unloaded'),
      }));

      // Then load
      const node = findNodeByPath(fileTreeRef.current, path);
      if (node && node.type === 'directory') {
        await loadChildren(path);
      }
    },
    [fileSystemAdapter, loadChildren]
  );

  /**
   * Refresh the entire tree from root
   */
  const refreshTree = useCallback(async () => {
    await loadRoot();
  }, [loadRoot]);

  /**
   * Cancel expand-all operation
   */
  const cancelExpandAll = useCallback(() => {
    workerPortRef.current?.abort();
    isExpandAllStartingRef.current = false;
    isExpandingAllRef.current = false;
    setExpandedPathsRef.current = null;
    setState((s) => ({
      ...s,
      isExpandingAll: false,
      expandAllProgress: null,
    }));
  }, []);

  /**
   * Progressively expand all directories using the Web Worker.
   * The worker handles all BFS traversal and tree operations.
   * The main thread only handles I/O (directory loading with FileSystemHandles).
   *
   * @param setExpandedPaths - Function to update expanded paths in the store
   */
  const expandAllProgressively = useCallback(
    async (
      setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
    ): Promise<void> => {
      if (!(fileSystemAdapter && workerPortRef.current)) {
        return;
      }

      // Synchronous guard against double-clicks
      if (isExpandAllStartingRef.current) {
        return;
      }
      isExpandAllStartingRef.current = true;
      isExpandingAllRef.current = true;

      // Store setExpandedPaths for use in worker handlers
      setExpandedPathsRef.current = setExpandedPaths;

      setState((s) => ({
        ...s,
        isExpandingAll: true,
        expandAllProgress: { loaded: 0, total: 0 },
      }));

      try {
        // Delegate to worker - it will request loads as needed
        const folderId = rootDirectoryHandle?.name ?? '';
        const result = await workerPortRef.current.expandAll(folderId);

        // Rehydrate final tree with handles
        const rehydratedTree = rehydrateTree(result.tree, handleMapRef.current);
        logRehydrationResult(
          'expand-all',
          handleMapRef.current.size,
          countNodes(result.tree),
          countNodes(rehydratedTree),
          rehydratedTree
        );

        // Final update
        setState((s) => ({
          ...s,
          fileTree: rehydratedTree,
          isExpandingAll: false,
          expandAllProgress: null,
        }));

        // Set all expanded paths
        setExpandedPaths(() => new Set(result.expandedPaths));
      } catch (err) {
        const isCancelled = isOperationCancelled(err);
        setState((s) => ({
          ...s,
          isExpandingAll: false,
          expandAllProgress: null,
          error: isCancelled ? s.error : err instanceof Error ? err : new Error(String(err)),
        }));
      } finally {
        isExpandAllStartingRef.current = false;
        isExpandingAllRef.current = false;
        setExpandedPathsRef.current = null;
      }
    },
    [fileSystemAdapter, rootDirectoryHandle]
  );

  /**
   * Load specific paths using the Web Worker (for restoration).
   * Uses the same optimized approach as expandAll but only loads the requested paths.
   *
   * @param paths - Directory paths to load (should be sorted by depth, shallowest first)
   * @param onProgress - Optional progress callback
   */
  const loadSpecificPaths = useCallback(
    async (
      paths: string[],
      onProgress?: (loaded: number, total: number, currentPath: string) => void
    ): Promise<void> => {
      if (!(fileSystemAdapter && workerPortRef.current)) {
        return;
      }

      // Skip if expand-all is in progress
      if (isExpandingAllRef.current) {
        logger.info('loadSpecificPaths skipped - expand-all in progress');
        return;
      }

      // Skip if no paths to load
      if (paths.length === 0) {
        return;
      }

      logger.info('loadSpecificPaths starting', { pathCount: paths.length });

      // Set up progress handler if provided
      const unsubProgress = onProgress
        ? workerPortRef.current.onProgress((loaded, total, currentPath) => {
            onProgress(loaded, total, currentPath);
          })
        : undefined;

      try {
        // Delegate to worker - it will request loads as needed
        const result = await workerPortRef.current.loadPaths(paths);

        // Rehydrate final tree with handles
        const rehydratedTree = rehydrateTree(result.tree, handleMapRef.current);
        logRehydrationResult(
          'loadSpecificPaths',
          handleMapRef.current.size,
          countNodes(result.tree),
          countNodes(rehydratedTree),
          rehydratedTree
        );

        // Update state with loaded tree
        setState((s) => ({
          ...s,
          fileTree: rehydratedTree,
        }));
      } catch (err) {
        if (!isOperationCancelled(err)) {
          logger.error('loadSpecificPaths failed', { error: String(err) });
        }
      } finally {
        unsubProgress?.();
      }
    },
    [fileSystemAdapter]
  );

  // Auto-load root when handle changes
  // biome-ignore lint/plugin: Root loading triggered by handle change - intentional side effect
  useEffect(() => {
    if (rootDirectoryHandle) {
      // Skip if expand-all is in progress - loadRoot would wipe handle map
      if (isExpandingAllRef.current) {
        logger.info('loadRoot skipped - expand-all in progress');
        return;
      }
      logger.info('loadRoot triggered', { rootPath: rootDirectoryHandle.path });
      void loadRoot();
    } else {
      // Clear handle map when root changes
      handleMapRef.current.clear();
      setState({
        fileTree: [],
        isInitialLoading: false,
        error: null,
        loadingPaths: new Set(),
        isExpandingAll: false,
        expandAllProgress: null,
      });
    }

    // Cleanup on unmount or handle change
    return () => {
      rootAbortControllerRef.current?.abort();
      workerPortRef.current?.abort();
      for (const controller of childAbortControllersRef.current.values()) {
        controller.abort();
      }
      childAbortControllersRef.current.clear();
    };
  }, [rootDirectoryHandle, loadRoot]);

  return {
    fileTree: state.fileTree,
    isLoading: state.isInitialLoading || state.loadingPaths.size > 0,
    error: state.error,
    loadingPaths: state.loadingPaths,
    loadRoot,
    loadChildren,
    needsLoading,
    cancelLoading,
    refreshDirectory,
    refreshTree,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll: state.isExpandingAll,
    expandAllProgress: state.expandAllProgress,
    loadSpecificPaths,
  };
}
