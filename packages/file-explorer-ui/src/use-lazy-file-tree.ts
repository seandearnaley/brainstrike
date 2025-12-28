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
import { createLogger } from '@brainstrike/utils';
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

// Debug helpers
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
 * Check if a node can be loaded (exists, is a directory, and needs loading).
 */
function canLoadNode(node: IFileNode | null | undefined): node is IFileNode {
  if (!node || node.type !== 'directory') {
    return false;
  }
  return node.loadState !== 'loaded' && node.loadState !== 'loading';
}

/**
 * Remove a path from the loading paths set.
 */
function removeFromLoadingPaths(paths: Set<string>, path: string): Set<string> {
  const newPaths = new Set(paths);
  newPaths.delete(path);
  return newPaths;
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
};

/**
 * Custom sort function: directories first, then alphabetically
 */
function sortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === 'directory') {
        return -1;
      }
      if (b.type === 'directory') {
        return 1;
      }
    }
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

/**
 * Check if an error is a cancellation error
 */
function isCancellationError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

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
  useEffect(() => {
    // Create worker
    const worker = new Worker(resolveFileTreeWorkerUrl(), { type: 'module' });
    const port = createFileTreeWorkerPort(worker);
    workerPortRef.current = port;

    // Handle load requests from worker - perform I/O with FileSystemHandles
    port.onRequestLoad(async (_requestId, paths) => {
      if (!fileSystemAdapter) {
        return paths.map((path) => ({ path, error: 'No file system adapter' }));
      }

      const results: BatchLoadResult[] = [];
      const abortController = new AbortController();

      // Get root info for building nodes (use ref to get current value)
      const rootPath = rootHandleRef.current?.path ?? '';
      const rootName = rootHandleRef.current?.name ?? '';

      await Promise.all(
        paths.map(async (path) => {
          // Look up handle from the handle map (NOT the stale React tree)
          const handle = handleMapRef.current.get(path);
          if (!handle) {
            results.push({ path, error: 'Handle not found' });
            return;
          }

          // Build minimal node info from what we have
          const pathSegments = path.replace(rootPath, '').split('/').filter(Boolean);
          const name = pathSegments[pathSegments.length - 1] ?? '';
          const depth = pathSegments.length - 1;

          const node: IFileNode = {
            name,
            path,
            type: 'directory',
            depth,
            rootFolderId: rootName,
            handle: handle as FileSystemDirectoryHandle,
            selectionState: 'unchecked',
          };

          try {
            const children = await loadDirectoryChildren(fileSystemAdapter, node, {
              abortSignal: abortController.signal,
              sortFileNodes,
            });

            // Add new handles to the map
            const mapSizeBefore = handleMapRef.current.size;
            addHandlesToMap(children, handleMapRef.current);
            const mapSizeAfter = handleMapRef.current.size;
            const childrenWithHandles = children.filter((c) => c.handle).length;
            logger.info('expand-all loaded directory', {
              path,
              childrenCount: children.length,
              childrenWithHandles,
              mapSizeBefore,
              mapSizeAfter,
            });

            // Convert children to worker nodes (filters out loadMore nodes)
            const workerChildren = toWorkerFileNodes(children);
            results.push({ path, children: workerChildren });
          } catch (err) {
            if (!isCancellationError(err)) {
              results.push({
                path,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        })
      );

      return results;
    });

    // Handle tree snapshots from worker
    // PERFORMANCE: We intentionally DO NOT update the React tree during expand-all.
    // Each tree update triggers:
    // 1. rehydrateTree - O(n) walk to add handles back
    // 2. flattenTree in OptimizedFileTree - O(n) walk
    // 3. Various useMemo recomputations with [fileTree] dependency
    // For a tree with 10,000+ nodes, this blocks the main thread.
    // Instead, we only update the tree at COMPLETION (in expandAllProgressively).
    // Progress is shown via expandAllProgress state (updated by onProgress handler).
    port.onTreeSnapshot((_workerTree, _expandedPaths) => {
      // Intentionally do nothing - tree and expanded paths are set at completion only
    });

    // Handle progress updates
    port.onProgress((loaded, total, _currentPath) => {
      setState((s) => ({
        ...s,
        expandAllProgress: { loaded, total },
      }));
    });

    // Handle errors from worker
    port.onError((message, _path) => {
      console.error('[FileTreeWorker]', message);
      setState((s) => ({
        ...s,
        error: new Error(message),
      }));
    });

    // Debug logging
    port.onLog((level, message, data) => {
      const logFn =
        level === 'error' ? console.error : level === 'warn' ? console.warn : console.debug;
      logFn('[FileTreeWorker]', message, data ?? '');
    });

    return () => {
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
      if (!isCancellationError(err)) {
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

        if (!abortController.signal.aborted) {
          handleLoadSuccess(path, children);
        }
      } catch (err) {
        if (!isCancellationError(err)) {
          handleLoadError(path, err instanceof Error ? err.message : String(err));
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
        logger.info('expand-all complete', {
          handleMapSize: handleMapRef.current.size,
          workerTreeNodes: countNodes(result.tree),
        });
        const rehydratedTree = rehydrateTree(result.tree, handleMapRef.current);
        logger.info('expand-all rehydrated', {
          rehydratedNodes: countNodes(rehydratedTree),
        });

        // Debug: check for files without handles
        const filesWithoutHandles = countFilesWithoutHandles(rehydratedTree);
        if (filesWithoutHandles > 0) {
          logger.warn('expand-all files missing handles', { filesWithoutHandles });
        }

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
        const isCancel =
          isCancellationError(err) || (err instanceof Error && err.message.includes('abort'));
        setState((s) => ({
          ...s,
          isExpandingAll: false,
          expandAllProgress: null,
          error: isCancel ? s.error : err instanceof Error ? err : new Error(String(err)),
        }));
      } finally {
        isExpandAllStartingRef.current = false;
        isExpandingAllRef.current = false;
        setExpandedPathsRef.current = null;
      }
    },
    [fileSystemAdapter, rootDirectoryHandle]
  );

  // Auto-load root when handle changes
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
  };
}
