/**
 * Lazy File Tree Hook
 *
 * Manages file tree state with on-demand directory loading.
 * Only loads immediate children of root initially, then loads
 * subdirectory contents when they are expanded.
 *
 * Uses extracted hooks for:
 * - Worker lifecycle (useFileTreeWorker)
 * - Abort controller management (useAbortControllers)
 * - Expand-all orchestration (useExpandAll)
 */

import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle, IFileNode } from '@brainstrike/types';
import { canLoadNode, createLogger, isAbortError, sortTreeNodes } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAbortControllers, useExpandAll, useFileTreeWorker } from './hooks';
import {
  needsLoading as checkNeedsLoading,
  findNodeByPath,
  loadDirectoryChildren,
  loadRootDirectory,
  setNodeLoadState,
  updateNodeChildren,
} from './utils/lazy-tree-loader';
import { buildHandleMap, rehydrateTree, toWorkerFileNodes } from './utils/worker-node-conversion';

const logger = createLogger('LazyFileTree');

/**
 * Sort nodes: directories first, then alphabetically.
 * Wraps the generic sortTreeNodes for IFileNode type.
 */
function sortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return sortTreeNodes(nodes);
}

export type LazyFileTreeState = {
  fileTree: IFileNode[];
  isInitialLoading: boolean;
  error: Error | null;
  loadingPaths: Set<string>;
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

  // Core state
  const [state, setState] = useState<LazyFileTreeState>({
    fileTree: [],
    isInitialLoading: false,
    error: null,
    loadingPaths: new Set(),
  });

  // Use ref to access current tree without adding it as a dependency
  const fileTreeRef = useRef(state.fileTree);
  fileTreeRef.current = state.fileTree;

  // Error handler for worker
  const handleWorkerError = useCallback((error: Error) => {
    setState((s) => ({ ...s, error }));
  }, []);

  // Abort controller management
  const { createAbortController, cancelAllLoading, removeChildController } = useAbortControllers();

  // Worker and handle map management
  const { portRef, handleMapRef, setRootHandle } = useFileTreeWorker({
    fileSystemAdapter,
    onError: handleWorkerError,
  });

  // Keep root handle ref in sync
  useEffect(() => {
    setRootHandle(rootDirectoryHandle);
  }, [rootDirectoryHandle, setRootHandle]);

  // Tree update handler for expand-all
  const handleTreeUpdate = useCallback((tree: IFileNode[]) => {
    setState((s) => ({ ...s, fileTree: tree }));
  }, []);

  // Expand-all management
  const {
    isExpandingAll,
    expandAllProgress,
    expandAllProgressively: expandAllFromHook,
    cancelExpandAll,
    isExpandingAllRef,
    updateProgress,
  } = useExpandAll({
    workerPort: portRef.current,
    handleMap: handleMapRef.current,
    rootFolderId: rootDirectoryHandle?.name ?? '',
    onTreeUpdate: handleTreeUpdate,
    onError: handleWorkerError,
  });

  // Connect progress updates from worker to expand-all hook
  useEffect(() => {
    const port = portRef.current;
    if (!port) {
      return;
    }

    const unsubscribe = port.onProgress((loaded, total, _currentPath) => {
      updateProgress(loaded, total);
    });

    return unsubscribe;
  }, [updateProgress]);

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
    if (isExpandingAllRef.current) {
      logger.info('loadRoot blocked - expand-all in progress');
      return;
    }

    // Create abort controller for root loading
    const abortController = createAbortController(null);

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

        // Initialize worker with root nodes
        if (portRef.current) {
          const workerNodes = toWorkerFileNodes(children);
          portRef.current.init(workerNodes, rootDirectoryHandle.name);
        }

        setState({
          fileTree: children,
          isInitialLoading: false,
          error: null,
          loadingPaths: new Set(),
        });
      }
    } catch (err) {
      if (!isAbortError(err)) {
        setState((s) => ({
          ...s,
          isInitialLoading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      }
    }
  }, [
    rootDirectoryHandle,
    fileSystemAdapter,
    createAbortController,
    handleMapRef,
    portRef,
    isExpandingAllRef,
  ]);

  /**
   * Handle successful directory load.
   */
  const handleLoadSuccess = useCallback(
    (path: string, children: IFileNode[]) => {
      // Add handles to map
      for (const child of children) {
        if (child.handle) {
          handleMapRef.current.set(child.path, child.handle);
        }
      }

      // Update worker tree
      if (portRef.current) {
        const workerChildren = toWorkerFileNodes(children);
        portRef.current.updateTree(path, workerChildren);
      }

      setState((s) => {
        const newLoadingPaths = new Set(s.loadingPaths);
        newLoadingPaths.delete(path);
        return {
          ...s,
          fileTree: updateNodeChildren(s.fileTree, path, children, 'loaded'),
          loadingPaths: newLoadingPaths,
        };
      });
    },
    [handleMapRef, portRef]
  );

  /**
   * Handle directory load error.
   */
  const handleLoadError = useCallback((path: string, errorMsg: string) => {
    setState((s) => {
      const newLoadingPaths = new Set(s.loadingPaths);
      newLoadingPaths.delete(path);
      return {
        ...s,
        fileTree: setNodeLoadState(s.fileTree, path, 'error', errorMsg),
        loadingPaths: newLoadingPaths,
      };
    });
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

      // Create abort controller for this path
      const abortController = createAbortController(path);

      // Mark as loading
      setState((s) => ({
        ...s,
        fileTree: setNodeLoadState(s.fileTree, path, 'loading'),
        loadingPaths: new Set([...s.loadingPaths, path]),
      }));

      try {
        const children = await loadDirectoryChildren(fileSystemAdapter, node, {
          abortSignal: abortController.signal,
          sortFileNodes,
        });
        if (!abortController.signal.aborted) {
          handleLoadSuccess(path, children);
        }
      } catch (err) {
        if (!isAbortError(err)) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          handleLoadError(path, errorMsg);
        }
      } finally {
        removeChildController(path);
      }
    },
    [
      fileSystemAdapter,
      createAbortController,
      handleLoadSuccess,
      handleLoadError,
      removeChildController,
    ]
  );

  /**
   * Check if a node needs loading
   */
  const needsLoading = useCallback((node: IFileNode): boolean => checkNeedsLoading(node), []);

  /**
   * Cancel all pending load operations
   */
  const cancelLoading = useCallback(() => {
    cancelAllLoading();
    setState((s) => ({
      ...s,
      loadingPaths: new Set(),
    }));
  }, [cancelAllLoading]);

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
   * Wrapper for expandAllProgressively that uses current worker/handleMap
   */
  const expandAllProgressively = useCallback(
    async (
      setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
    ): Promise<void> => {
      if (!(fileSystemAdapter && portRef.current)) {
        return;
      }

      // Use the expand-all hook's implementation
      await expandAllFromHook(setExpandedPaths);
    },
    [fileSystemAdapter, portRef, expandAllFromHook]
  );

  /**
   * Load specific paths using the Web Worker (for restoration).
   */
  const loadSpecificPaths = useCallback(
    async (
      paths: string[],
      onProgress?: (loaded: number, total: number, currentPath: string) => void
    ): Promise<void> => {
      if (!(fileSystemAdapter && portRef.current)) {
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
        ? portRef.current.onProgress((loaded, total, currentPath) => {
            onProgress(loaded, total, currentPath);
          })
        : undefined;

      try {
        // Delegate to worker
        const result = await portRef.current.loadPaths(paths);

        // Rehydrate final tree with handles
        const rehydratedTree = rehydrateTree(result.tree, handleMapRef.current);
        logger.info('loadSpecificPaths complete', {
          handleMapSize: handleMapRef.current.size,
        });

        // Update state with loaded tree
        setState((s) => ({
          ...s,
          fileTree: rehydratedTree,
        }));
      } catch (err) {
        if (!isAbortError(err)) {
          logger.error('loadSpecificPaths failed', { error: String(err) });
        }
      } finally {
        unsubProgress?.();
      }
    },
    [fileSystemAdapter, portRef, handleMapRef, isExpandingAllRef]
  );

  // Auto-load root when handle changes
  // biome-ignore lint/plugin: This is initialization logic, not derived state
  useEffect(() => {
    if (rootDirectoryHandle) {
      // Skip if expand-all is in progress
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
      });
    }

    // Cleanup on unmount or handle change
    return () => {
      cancelAllLoading();
      portRef.current?.abort();
    };
  }, [rootDirectoryHandle, loadRoot, handleMapRef, cancelAllLoading, portRef, isExpandingAllRef]);

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
    isExpandingAll,
    expandAllProgress,
    loadSpecificPaths,
  };
}
