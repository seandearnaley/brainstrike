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

/**
 * Check if loadRoot should skip execution.
 * Extracted to reduce cognitive complexity.
 */
function shouldSkipLoadRoot(
  rootPath: string,
  isExpandingAll: boolean,
  initializedRoot: string | null,
  fileTreeLength: number
): { skip: boolean; reason?: string } {
  // Skip if expand-all is in progress for THIS root
  if (isExpandingAll && initializedRoot === rootPath) {
    return { skip: true, reason: 'expand-all in progress for same root' };
  }

  // Skip if already initialized for this root
  if (initializedRoot === rootPath && fileTreeLength > 0) {
    return { skip: true, reason: 'already initialized for this root' };
  }

  return { skip: false };
}

/**
 * Process load paths result with optional rehydration.
 * Extracted to reduce cognitive complexity.
 *
 * @param result - The result from worker.loadPaths()
 * @param handleMap - Map of path to FileSystemHandle (type comes from rehydrateTree signature)
 * @param setState - State setter for updating file tree
 */
function processLoadPathsResult(
  result: { tree: unknown[]; expandedPaths: string[]; loadedCount: number },
  handleMap: Parameters<typeof rehydrateTree>[1],
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>
): void {
  // Skip rehydration when all directories were already cached
  if (result.loadedCount > 0) {
    // Cast tree to expected type - rehydrateTree handles the conversion
    const rehydratedTree = rehydrateTree(
      result.tree as Parameters<typeof rehydrateTree>[0],
      handleMap
    );
    setState((s) => ({
      ...s,
      fileTree: rehydratedTree,
    }));
  }
  // When loadedCount === 0, tree is already correct - no state update needed
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

  // Expand-all progress state (kept here so we can pass handler to worker before useExpandAll)
  const [expandAllProgress, setExpandAllProgress] = useState<{
    loaded: number;
    total: number;
  } | null>(null);

  // Use ref to access current tree without adding it as a dependency
  const fileTreeRef = useRef(state.fileTree);
  fileTreeRef.current = state.fileTree;

  // Track which root we've initialized for to prevent redundant reinits
  // This is critical for expand-all: without it, any effect re-run would
  // reinitialize the worker, losing all loaded directory state
  const initializedRootRef = useRef<string | null>(null);

  // Error handler for worker
  const handleWorkerError = useCallback((error: Error) => {
    setState((s) => ({ ...s, error }));
  }, []);

  // Progress handler - defined before useFileTreeWorker so we can pass it
  const handleProgress = useCallback((loaded: number, total: number) => {
    setExpandAllProgress({ loaded, total });
  }, []);

  // Abort controller management
  const { createAbortController, cancelAllLoading, removeChildController } = useAbortControllers();

  // Worker and handle map management - pass progress handler
  const { portRef, handleMapRef, setRootHandle } = useFileTreeWorker({
    fileSystemAdapter,
    onProgress: handleProgress,
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
    expandAllProgressively: expandAllFromHook,
    cancelExpandAll,
    isExpandingAllRef,
  } = useExpandAll({
    workerPortRef: portRef,
    handleMapRef,
    rootFolderId: rootDirectoryHandle?.name ?? '',
    onTreeUpdate: handleTreeUpdate,
    onError: handleWorkerError,
  });

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
      initializedRootRef.current = null;
      return;
    }

    const rootPath = rootDirectoryHandle.path;

    // Check if we should skip loading (expand-all in progress or already initialized)
    const skipCheck = shouldSkipLoadRoot(
      rootPath,
      isExpandingAllRef.current,
      initializedRootRef.current,
      fileTreeRef.current.length
    );

    if (skipCheck.skip) {
      logger.info(`loadRoot skipped - ${skipCheck.reason}`, { rootPath });
      return;
    }

    // Log when we're about to reinitialize (this would reset the worker tree!)
    logger.info('loadRoot running - will reinitialize worker', {
      rootPath,
      initializedRoot: initializedRootRef.current,
      fileTreeLength: fileTreeRef.current.length,
    });

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

        // Mark this root as initialized to prevent redundant reinits
        initializedRootRef.current = rootDirectoryHandle.path;
      }
    } catch (err) {
      if (!isAbortError(err)) {
        // Clear stale handles from previous root to prevent incorrect lookups
        handleMapRef.current.clear();
        initializedRootRef.current = null;

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
   * Perform the actual directory loading operation.
   * Extracted to reduce cognitive complexity of loadChildren.
   */
  const performDirectoryLoad = useCallback(
    async (
      path: string,
      node: IFileNode,
      abortController: AbortController,
      adapter: NonNullable<typeof fileSystemAdapter>
    ): Promise<void> => {
      try {
        const children = await loadDirectoryChildren(adapter, node, {
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
      }
    },
    [handleLoadSuccess, handleLoadError]
  );

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
        await performDirectoryLoad(path, node, abortController, fileSystemAdapter);
      } finally {
        removeChildController(path);
      }
    },
    [fileSystemAdapter, createAbortController, performDirectoryLoad, removeChildController]
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
   * Refresh the entire tree from root.
   * Resets initializedRootRef to force loadRoot to reload the tree.
   */
  const refreshTree = useCallback(async () => {
    // Reset initialized ref to force loadRoot to reload the tree
    // Without this, shouldSkipLoadRoot returns skip=true for "already initialized" roots
    initializedRootRef.current = null;
    await loadRoot();
  }, [loadRoot]);

  /**
   * Wrapper for expandAllProgressively that uses current worker/handleMap
   */
  const expandAllProgressively = useCallback(
    async (
      setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
    ): Promise<void> => {
      logger.info('expandAllProgressively wrapper called', {
        hasAdapter: !!fileSystemAdapter,
        hasPort: !!portRef.current,
      });

      if (!fileSystemAdapter) {
        logger.warn('expandAllProgressively: no file system adapter');
        return;
      }

      if (!portRef.current) {
        logger.warn('expandAllProgressively: no worker port');
        return;
      }

      // Verify expandAllFromHook exists
      if (typeof expandAllFromHook !== 'function') {
        logger.error('expandAllProgressively: expandAllFromHook is not a function', {
          type: typeof expandAllFromHook,
        });
        return;
      }

      logger.info('expandAllProgressively: calling expandAllFromHook');

      // Use the expand-all hook's implementation
      try {
        await expandAllFromHook(setExpandedPaths);
        logger.info('expandAllProgressively: expandAllFromHook completed');
      } catch (err) {
        logger.error('expandAllProgressively: expandAllFromHook threw', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        throw err;
      } finally {
        // Clear progress after operation completes (success or failure)
        setExpandAllProgress(null);
      }
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

        logger.info('loadSpecificPaths complete', {
          handleMapSize: handleMapRef.current.size,
          loadedCount: result.loadedCount,
        });

        // Process result with optional rehydration (skipped when all cached)
        processLoadPathsResult(result, handleMapRef.current, setState);
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
      // If expand-all is in progress but root has CHANGED, cancel and proceed with new root
      // This prevents race condition where switching folders leaves new folder empty
      const rootPath = rootDirectoryHandle.path;
      if (isExpandingAllRef.current && initializedRootRef.current !== rootPath) {
        logger.info('loadRoot: cancelling expand-all for different root', {
          oldRoot: initializedRootRef.current,
          newRoot: rootPath,
        });
        cancelExpandAll();
      }
      // Skip if expand-all is in progress for THIS root (same folder)
      if (isExpandingAllRef.current && initializedRootRef.current === rootPath) {
        logger.info('loadRoot skipped - expand-all in progress for same root');
        return;
      }
      logger.info('loadRoot triggered', { rootPath });
      void loadRoot();
    } else {
      // Clear handle map and initialized ref when root changes
      handleMapRef.current.clear();
      initializedRootRef.current = null;
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
      // IMPORTANT: Don't abort worker if expand-all is in progress.
      // When effect dependencies change (but component isn't unmounting),
      // aborting would cancel the expand-all operation mid-flight.
      // The expand-all operation manages its own lifecycle via useExpandAll.
      if (!isExpandingAllRef.current) {
        portRef.current?.abort();
      }
    };
  }, [
    rootDirectoryHandle,
    loadRoot,
    handleMapRef,
    cancelAllLoading,
    portRef,
    isExpandingAllRef,
    cancelExpandAll,
  ]);

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
