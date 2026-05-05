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
import type { FileTreeWorkerPort } from '@brainstrike/file-tree-worker';
import type { DirectoryHandle, IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { canLoadNode, sortTreeNodes } from '@brainstrike/utils/tree-operations';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useAbortControllers,
  useExpandAll,
  useFileTreeWorker,
  useRecursiveFolderSelect,
  useRecursiveSelectAll,
} from './hooks';
import type { AddMultipleSelectedFilesChunked } from './hooks/recursive-selection-utils';
import type { ExpandAllExecutorArgs, ExpandAllExecutorResult } from './hooks/use-expand-all';
import { getRootFolderId } from './utils/get-root-folder-id';
import {
  needsLoading as checkNeedsLoading,
  findNodeByPath,
  loadDirectoryChildren,
  loadDirectoryChildrenStreaming,
  loadRootDirectory,
  loadRootDirectoryStreaming,
  supportsStreaming,
} from './utils/lazy-tree-loader';
import {
  createEmptyNormalizedFileTreeState,
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
  getNormalizedRootDirectoryPaths,
  listNormalizedDescendantFilePaths,
  materializeNormalizedFileTree,
  materializeNormalizedShallowNode,
  materializeNormalizedSubtree,
  type NormalizedFileTreeState,
  replaceNormalizedDirectoryChildren,
  setNormalizedNodeLoadState,
} from './utils/normalized-file-tree';
import {
  buildHandleMap,
  type FileSystemHandle,
  rehydrateTree,
  toWorkerFileNodes,
} from './utils/worker-node-conversion';

const logger = createLogger('LazyFileTree');
interface InFlightRootLoad {
  promise: Promise<IFileNode[]>;
}

interface CountableTreeNode {
  children?: readonly CountableTreeNode[] | undefined;
}

type SpecificPathProgressHandler = (loaded: number, total: number, currentPath: string) => void;

const inFlightRootLoads = new Map<string, InFlightRootLoad>();

function countTreeNodes(nodes: readonly CountableTreeNode[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    count += 1;
    if (node.children) {
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }
  return count;
}

/**
 * Clear shared root-load state between tests.
 * @internal Test-only helper.
 */
export function __resetInFlightRootLoads(): void {
  inFlightRootLoads.clear();
}

/**
 * Sort nodes: directories first, then alphabetically.
 * Wraps the generic sortTreeNodes for IFileNode type.
 */
function sortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return sortTreeNodes(nodes);
}

/**
 * Check if loadRoot should skip execution.
 *
 * This function is extracted to reduce cognitive complexity and centralize
 * the skip-logic decision. It returns a result object with skip flag and
 * optional reason for debugging.
 *
 * Skip conditions:
 * 1. expand-all in progress for same root - prevents duplicate loading
 * 2. already initialized for this root with files - prevents unnecessary reloads
 *
 * IMPORTANT: refreshTree must reset initializedRoot to null before calling
 * loadRoot to bypass the "already initialized" check and force a reload.
 *
 * @param rootPath - The path of the root to load
 * @param isExpandingAll - Whether expand-all operation is in progress
 * @param initializedRoot - The currently initialized root path (or null)
 * @param fileTreeLength - Number of items in the current file tree
 * @returns Object with skip flag and optional reason string
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
 * Handle loadRoot early exit when prerequisites are missing.
 * Extracted to reduce cognitive complexity of loadRoot.
 *
 * @param setState - State setter for updating file tree state
 * @param initializedRootRef - Ref to reset when clearing state
 */
function handleLoadRootNoHandle(
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>,
  initializedRootRef: React.RefObject<string | null>
): void {
  setState((s) => ({
    ...s,
    fileTree: [],
    isInitialLoading: false,
    error: null,
  }));
  initializedRootRef.current = null;
}

function createLoadRootPendingState(
  currentState: LazyFileTreeState,
  startedSharedRequest: boolean
): LazyFileTreeState {
  if (startedSharedRequest) {
    return {
      ...currentState,
      isInitialLoading: true,
      error: null,
      fileTree: [],
      loadingPaths: new Set(),
    };
  }

  if (
    currentState.isInitialLoading &&
    currentState.error === null &&
    currentState.loadingPaths.size === 0
  ) {
    return currentState;
  }

  return {
    ...currentState,
    isInitialLoading: true,
    error: null,
    loadingPaths: new Set(),
  };
}

function isActiveLoadRootRun(
  isUnmountedRef: React.RefObject<boolean>,
  loadRootRunIdRef: React.RefObject<number>,
  currentRunId: number
): boolean {
  return !isUnmountedRef.current && loadRootRunIdRef.current === currentRunId;
}

/**
 * Process successful root load result.
 * Extracted to reduce cognitive complexity of loadRoot.
 *
 * @param children - Loaded children nodes
 * @param rootPath - Path to mark as initialized
 * @param handleMapRef - Handle map ref to populate
 * @param portRef - Worker port ref for initialization
 * @param setState - State setter
 * @param initializedRootRef - Ref to mark as initialized
 * @param rootFolderId - Canonical root folder id for worker init
 * @param onNodesIndexedRef - Optional callback ref for indexing nodes
 */
function handleLoadRootSuccess(
  children: IFileNode[],
  rootPath: string,
  handleMapRef: React.RefObject<Map<string, unknown>>,
  portRef: React.RefObject<FileTreeWorkerPort | null>,
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>,
  initializedRootRef: React.RefObject<string | null>,
  rootFolderId: string,
  onNodesIndexedRef?: React.RefObject<
    ((nodes: IFileNode[], parentPath: string | null) => void) | undefined
  >
): void {
  // Build handle map from root children
  handleMapRef.current = buildHandleMap(children);

  // Initialize worker with root nodes
  if (portRef.current) {
    const workerNodes = toWorkerFileNodes(children);
    portRef.current.init(workerNodes, rootFolderId);
  }

  setState({
    fileTree: children,
    isInitialLoading: false,
    error: null,
    loadingPaths: new Set(),
  });

  // Mark this root as initialized to prevent redundant reinits
  initializedRootRef.current = rootPath;

  // Notify indexing callback for root-level nodes
  if (onNodesIndexedRef?.current && children.length > 0) {
    onNodesIndexedRef.current(children, null);
  }
}

/**
 * Handle loadRoot error.
 * Extracted to reduce cognitive complexity of loadRoot.
 *
 * @param err - The error that occurred
 * @param handleMapRef - Handle map ref to clear
 * @param initializedRootRef - Initialized root ref to clear
 * @param setState - State setter
 */
function handleLoadRootError(
  err: unknown,
  handleMapRef: React.RefObject<Map<string, unknown>>,
  initializedRootRef: React.RefObject<string | null>,
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>
): void {
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

function loadRootChildren(args: {
  fileSystemAdapter: NonNullable<ReturnType<typeof useAdapters>['fileSystemAdapter']>;
  rootDirectoryHandle: DirectoryHandle;
  rootPath: string;
}): { request: InFlightRootLoad; started: boolean } {
  const { fileSystemAdapter, rootDirectoryHandle, rootPath } = args;
  const existingRequest = inFlightRootLoads.get(rootPath);
  if (existingRequest) {
    logger.debug('loadRoot joined existing in-flight request', { rootPath });
    return {
      request: existingRequest,
      started: false,
    };
  }

  const promise = (async (): Promise<IFileNode[]> => {
    if (supportsStreaming(fileSystemAdapter)) {
      let finalChildren: IFileNode[] | null = null;
      await loadRootDirectoryStreaming(
        fileSystemAdapter,
        rootDirectoryHandle,
        (children, meta) => {
          if (meta.done) {
            finalChildren = children;
          }
        },
        {
          sortFileNodes,
        }
      );

      if (finalChildren === null) {
        throw new Error(`Root load completed without a final batch for ${rootPath}`);
      }

      const resolvedChildren: IFileNode[] = finalChildren;
      logger.debug('loadRoot completed - handle map built', {
        childrenCount: resolvedChildren.length,
        rootPath,
      });
      return resolvedChildren;
    }

    const children = await loadRootDirectory(fileSystemAdapter, rootDirectoryHandle, {
      sortFileNodes,
    });
    logger.debug('loadRoot completed - handle map built', {
      childrenCount: children.length,
      rootPath,
    });
    return children;
  })();

  const request: InFlightRootLoad = { promise };
  inFlightRootLoads.set(rootPath, request);
  void promise
    .finally(() => {
      if (inFlightRootLoads.get(rootPath) === request) {
        inFlightRootLoads.delete(rootPath);
      }
    })
    .catch(() => {});

  return {
    request,
    started: true,
  };
}

function shouldSkipSpecificPathLoad(
  fileSystemAdapter: ReturnType<typeof useAdapters>['fileSystemAdapter'],
  isExpandingAll: boolean,
  paths: string[]
): boolean {
  if (!fileSystemAdapter) {
    return true;
  }
  if (isExpandingAll) {
    logger.debug('loadSpecificPaths skipped - expand-all in progress');
    return true;
  }
  return paths.length === 0;
}

async function loadSpecificPathsWithWorker(args: {
  handleMapRef: React.RefObject<Map<string, FileSystemHandle>>;
  onNodesIndexedRef: React.RefObject<
    ((nodes: IFileNode[], parentPath: string | null) => void) | undefined
  >;
  onProgress: SpecificPathProgressHandler | undefined;
  paths: string[];
  port: FileTreeWorkerPort;
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>;
  specificPathProgressRef: React.RefObject<SpecificPathProgressHandler | null>;
  syncNormalizedTree: (tree: IFileNode[]) => void;
}): Promise<void> {
  const {
    handleMapRef,
    onNodesIndexedRef,
    onProgress,
    paths,
    port,
    setState,
    specificPathProgressRef,
    syncNormalizedTree,
  } = args;
  const total = paths.length;

  specificPathProgressRef.current = onProgress ?? null;
  onProgress?.(0, total, paths[0] ?? '');

  const result = await port.loadPaths(paths);
  const hydratedTree = rehydrateTree(result.tree, handleMapRef.current);
  syncNormalizedTree(hydratedTree);
  setState((s) => ({
    ...s,
    fileTree: hydratedTree,
    loadingPaths: new Set(),
  }));
  if (onNodesIndexedRef.current && hydratedTree.length > 0) {
    onNodesIndexedRef.current(hydratedTree, null);
  }
  onProgress?.(total, total, paths.at(-1) ?? '');
}

async function loadSpecificPathsSerial(args: {
  loadChildrenRef: React.RefObject<(path: string) => Promise<void>>;
  normalizedTreeRef: React.RefObject<NormalizedFileTreeState>;
  onProgress: SpecificPathProgressHandler | undefined;
  paths: string[];
}): Promise<void> {
  const { loadChildrenRef, normalizedTreeRef, onProgress, paths } = args;
  const total = paths.length;

  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (!path) {
      continue;
    }

    onProgress?.(index, total, path);

    const node = materializeNormalizedSubtree(normalizedTreeRef.current, path);
    const shouldLoadNode = node && node.type === 'directory' && node.loadState !== 'loaded';
    if (!shouldLoadNode) {
      onProgress?.(index + 1, total, path);
      continue;
    }

    await loadChildrenRef.current(path);

    onProgress?.(index + 1, total, path);
  }
}

function applyWorkerExpandAllResult(args: {
  handleMapRef: React.RefObject<Map<string, FileSystemHandle>>;
  onNodesIndexedRef: React.RefObject<
    ((nodes: IFileNode[], parentPath: string | null) => void) | undefined
  >;
  result: Awaited<ReturnType<FileTreeWorkerPort['expandAll']>>;
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>;
  syncNormalizedTree: (tree: IFileNode[]) => void;
}): { discoveredDirectories: number; pathsToCommit: readonly string[] } {
  const { handleMapRef, onNodesIndexedRef, result, setState, syncNormalizedTree } = args;
  const hydratedTree = rehydrateTree(result.tree, handleMapRef.current);
  const expectedNodeCount = countTreeNodes(result.tree);
  const actualNodeCount = countTreeNodes(hydratedTree);

  if (actualNodeCount !== expectedNodeCount) {
    throw new Error(
      `Expand-all worker returned ${expectedNodeCount} nodes but only ${actualNodeCount} could be rehydrated`
    );
  }

  syncNormalizedTree(hydratedTree);
  setState((s) => ({
    ...s,
    fileTree: hydratedTree,
    loadingPaths: new Set(),
  }));

  if (onNodesIndexedRef.current && hydratedTree.length > 0) {
    onNodesIndexedRef.current(hydratedTree, null);
  }

  return {
    discoveredDirectories: result.expandedPaths.length,
    pathsToCommit: result.expandedPaths,
  };
}

export interface LazyFileTreeState {
  error: Error | null;
  fileTree: IFileNode[];
  isInitialLoading: boolean;
  loadingPaths: Set<string>;
}

export interface UseLazyFileTreeReturn {
  /** @internal get cached descendant file count without tree traversal */
  __internalGetDescendantFileCount: (path: string) => number;
  /** @internal get descendant file paths without nested object traversal */
  __internalGetDescendantFilePaths: (path: string, maxCount?: number) => string[];
  /** @internal materialize a full subtree on demand */
  __internalMaterializeSubtree: (path: string) => IFileNode | undefined;
  /** @internal normalized tree state for provider-backed render paths */
  __internalNormalizedTreeRef: React.RefObject<NormalizedFileTreeState>;
  /** @internal version that changes whenever the normalized tree changes */
  __internalNormalizedTreeVersion: number;
  /** Cancel loading for a specific directory (e.g., when collapsing) */
  cancelChildLoading: (path: string) => void;
  /** Cancel expand-all operation */
  cancelExpandAll: () => void;
  /** Cancel any pending load operations */
  cancelLoading: () => void;
  /** Cancel the current recursive selection operation */
  cancelRecursiveSelect: () => void;
  /** Cancel the current select all operation */
  cancelSelectAll: () => void;
  /** Error from initial load or latest expansion */
  error: Error | null;
  /** Progress of expand-all operation */
  expandAllProgress: { loaded: number; total: number } | null;
  /** Progressively expand all directories (loads everything) */
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
    currentExpandedPaths?: ReadonlySet<string>
  ) => Promise<void>;
  /** Current file tree (lazily loaded) */
  fileTree: IFileNode[];
  /** Whether expand-all is in progress */
  isExpandingAll: boolean;
  /** Whether initial load or any directory is loading */
  isLoading: boolean;
  /** Whether the tree is being loaded for select all */
  isLoadingForSelectAll: boolean;
  /** Whether a subtree is being loaded for selection */
  isLoadingForSelection: boolean;
  /** Load children of a specific directory on expand */
  loadChildren: (path: string) => Promise<void>;
  /** Path of the folder being loaded for selection (if any) */
  loadingPathForSelection: string | null;
  /** Set of paths currently being loaded */
  loadingPaths: Set<string>;
  /** Load root directory contents */
  loadRoot: () => Promise<void>;
  /** Load specific paths using worker (for restoration) */
  loadSpecificPaths: (
    paths: string[],
    onProgress?: (loaded: number, total: number, currentPath: string) => void
  ) => Promise<void>;
  /** Check if a directory needs loading */
  needsLoading: (node: IFileNode) => boolean;
  /** Force refresh a directory (reload its children) */
  refreshDirectory: (path: string) => Promise<void>;
  /** Refresh the entire tree from root */
  refreshTree: () => Promise<void>;
  /** Loading progress for select all (if available) */
  selectAllLoadingProgress: { loaded: number; total: number } | null;
  /**
   * Select all files in the provided tree, loading unloaded directories first if needed.
   * IMPORTANT: Pass the FILTERED tree (quickFilteredTree) to respect workspace filters.
   */
  selectAllRecursively: (
    filteredTree: IFileNode[],
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
  ) => Promise<{
    success: boolean;
    filePaths: string[];
    totalAvailable?: number;
    limitReached?: boolean;
    cancelled?: boolean;
    error?: string;
  }>;
  /** Select all files in a folder, loading unloaded children first if needed */
  selectFolderRecursively: (
    node: IFileNode,
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    currentSelectionSize: number,
    currentDirectorySelectionSize?: number,
    addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
  ) => Promise<{ success: boolean; filePaths: string[]; cancelled?: boolean; error?: string }>;
  /** Loading progress for recursive selection (if available) */
  selectionLoadingProgress: { loaded: number; total: number } | null;
  /** Worker port ref for worker-based tree flattening (BST-375) */
  workerPortRef: React.RefObject<FileTreeWorkerPort | null>;
}

export interface UseLazyFileTreeOptions {
  /**
   * Filter function to apply workspace include/exclude filters to a tree.
   * Called in the slow path when directories are loaded from the worker,
   * ensuring workspace filters are respected before file selection.
   */
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];

  /**
   * Callback invoked when nodes are added to the tree.
   * Used by FileTreeIndex for incremental indexing.
   * @param nodes - The nodes that were added
   * @param parentPath - The parent path, or null for root-level nodes
   */
  onNodesIndexed?: (nodes: IFileNode[], parentPath: string | null) => void;
}

/**
 * Hook for managing lazily-loaded file tree state.
 *
 * Uses worker-backed helpers for canonical tree flattening while keeping
 * directory I/O and progressive expand-all traversal in the renderer.
 *
 * @param rootDirectoryHandle - The root directory to load
 * @param options - Optional configuration including filterTreeFn for workspace filters
 * @returns Lazy file tree state and operations
 */
export function useLazyFileTree(
  rootDirectoryHandle: DirectoryHandle | null,
  options: UseLazyFileTreeOptions = {}
): UseLazyFileTreeReturn {
  const { filterTreeFn, onNodesIndexed } = options;
  const { fileSystemAdapter } = useAdapters();
  const rootDirectoryPath = rootDirectoryHandle?.path ?? null;

  // Ref for callback to avoid stale closures
  const onNodesIndexedRef = useRef(onNodesIndexed);
  onNodesIndexedRef.current = onNodesIndexed;

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
  const loadingPathsRef = useRef(state.loadingPaths);
  loadingPathsRef.current = state.loadingPaths;
  const normalizedTreeRef = useRef<NormalizedFileTreeState>(createEmptyNormalizedFileTreeState());
  const [normalizedTreeVersion, setNormalizedTreeVersion] = useState(0);
  const inFlightChildLoadsRef = useRef<Map<string, Promise<void>>>(new Map());
  const loadChildrenRef = useRef<(path: string) => Promise<void>>(async () => {});
  const specificPathProgressRef = useRef<
    ((loaded: number, total: number, currentPath: string) => void) | null
  >(null);
  const isUnmountedRef = useRef(false);

  // Track which root we've initialized for to prevent redundant reinits
  // This is critical for expand-all: without it, any effect re-run would
  // reinitialize the worker, losing all loaded directory state
  const initializedRootRef = useRef<string | null>(null);

  // Track if loadRoot is currently in progress to prevent concurrent calls
  // This handles React StrictMode double-mount and rapid re-renders
  const isLoadingRootRef = useRef(false);
  const loadRootRunIdRef = useRef(0);
  const lastAppliedRootLoadRef = useRef<InFlightRootLoad | null>(null);

  // Error handler for worker
  const handleWorkerError = useCallback((error: Error) => {
    setState((s) => ({ ...s, error }));
  }, []);

  const syncNormalizedTree = useCallback((tree: IFileNode[]): void => {
    fileTreeRef.current = tree;
    normalizedTreeRef.current = createNormalizedFileTreeState(tree);
    setNormalizedTreeVersion((version) => version + 1);
  }, []);

  const commitNormalizedTree = useCallback(
    (updater: (current: NormalizedFileTreeState) => NormalizedFileTreeState): IFileNode[] => {
      const nextNormalized = updater(normalizedTreeRef.current);
      const nextTree = materializeNormalizedFileTree(nextNormalized);
      normalizedTreeRef.current = nextNormalized;
      fileTreeRef.current = nextTree;
      setNormalizedTreeVersion((version) => version + 1);
      return nextTree;
    },
    []
  );

  // Progress handler - defined before useFileTreeWorker so we can pass it
  const handleProgress = useCallback((loaded: number, total: number, currentPath: string) => {
    const specificPathProgress = specificPathProgressRef.current;
    if (specificPathProgress) {
      specificPathProgress(loaded, total, currentPath);
      return;
    }
    setExpandAllProgress({ loaded, total });
  }, []);

  // Abort controller management
  const {
    childAbortControllersRef,
    createAbortController,
    cancelAllLoading,
    cancelChildLoading,
    removeChildController,
  } = useAbortControllers();

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

  useEffect(() => {
    isUnmountedRef.current = false;

    return () => {
      isUnmountedRef.current = true;
    };
  }, []);

  // Tree update handler for expand-all
  const handleTreeUpdate = useCallback(
    (tree: IFileNode[]) => {
      syncNormalizedTree(tree);
      setState((s) => ({ ...s, fileTree: tree }));
    },
    [syncNormalizedTree]
  );

  const filterTreeOption = filterTreeFn ? { filterTreeFn } : {};

  const folderSelectHookOptions = {
    cancelLoadOperations: cancelAllLoading,
    fileSystemAdapter,
    getSubtreeByPath: (path: string) =>
      materializeNormalizedSubtree(normalizedTreeRef.current, path),
    onError: handleWorkerError,
    ...filterTreeOption,
  };

  const selectAllHookOptions = {
    cancelLoadOperations: cancelAllLoading,
    fileSystemAdapter,
    getCurrentTree: () => materializeNormalizedFileTree(normalizedTreeRef.current),
    onTreeUpdate: handleTreeUpdate,
    onError: handleWorkerError,
    ...filterTreeOption,
  };

  const {
    isLoadingForSelection,
    loadingPath: loadingPathForSelection,
    loadingProgress: selectionLoadingProgress,
    selectFolderRecursively,
    cancelRecursiveSelect,
  } = useRecursiveFolderSelect(folderSelectHookOptions);

  const {
    isLoadingForSelectAll,
    loadingProgress: selectAllLoadingProgress,
    selectAllRecursively,
    cancelSelectAll,
  } = useRecursiveSelectAll(selectAllHookOptions);

  /**
   * Load root directory contents
   */
  const loadRoot = useCallback(async () => {
    // CRITICAL: Guard against concurrent loadRoot calls FIRST
    // This must be checked and set atomically before any other logic to prevent
    // race conditions during React StrictMode double-mount or rapid re-renders
    if (isLoadingRootRef.current) {
      logger.debug('loadRoot skipped - already loading');
      return;
    }
    // Set flag IMMEDIATELY after guard passes - before any other code
    isLoadingRootRef.current = true;
    const currentRunId = ++loadRootRunIdRef.current;

    if (!(rootDirectoryHandle && fileSystemAdapter)) {
      handleLoadRootNoHandle(setState, initializedRootRef);
      isLoadingRootRef.current = false;
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
      logger.debug(`loadRoot skipped - ${skipCheck.reason}`, { rootPath });
      isLoadingRootRef.current = false;
      return;
    }

    try {
      const rootLoadRequest = loadRootChildren({
        fileSystemAdapter,
        rootDirectoryHandle,
        rootPath,
      });

      if (rootLoadRequest.started) {
        logger.debug('loadRoot running - will reinitialize worker', {
          rootPath,
          initializedRoot: initializedRootRef.current,
          fileTreeLength: fileTreeRef.current.length,
        });

        createAbortController(null);
      }

      setState((s) => createLoadRootPendingState(s, rootLoadRequest.started));

      const children = await rootLoadRequest.request.promise;

      if (
        isActiveLoadRootRun(isUnmountedRef, loadRootRunIdRef, currentRunId) &&
        lastAppliedRootLoadRef.current !== rootLoadRequest.request
      ) {
        lastAppliedRootLoadRef.current = rootLoadRequest.request;
        handleLoadRootSuccess(
          children,
          rootPath,
          handleMapRef,
          portRef,
          setState,
          initializedRootRef,
          rootPath,
          onNodesIndexedRef
        );
        syncNormalizedTree(children);
      }
    } catch (err) {
      if (isActiveLoadRootRun(isUnmountedRef, loadRootRunIdRef, currentRunId)) {
        handleLoadRootError(err, handleMapRef, initializedRootRef, setState);
      }
    } finally {
      if (isActiveLoadRootRun(isUnmountedRef, loadRootRunIdRef, currentRunId)) {
        isLoadingRootRef.current = false;
      }
    }
  }, [
    rootDirectoryHandle,
    fileSystemAdapter,
    createAbortController,
    handleMapRef,
    portRef,
    syncNormalizedTree,
  ]);

  /**
   * Handle successful directory load.
   */
  const shouldApplyChildLoadResult = useCallback(
    (path: string, abortController: AbortController, allowClearedController = false): boolean => {
      const currentController = childAbortControllersRef.current.get(path);
      if (!currentController) {
        return allowClearedController;
      }
      return currentController === abortController;
    },
    [childAbortControllersRef]
  );

  const handleLoadSuccess = useCallback(
    (path: string, children: IFileNode[], abortController: AbortController) => {
      if (!shouldApplyChildLoadResult(path, abortController)) {
        return;
      }

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

      const nextTree = commitNormalizedTree((currentTree) =>
        replaceNormalizedDirectoryChildren(currentTree, path, children, 'loaded')
      );
      setState((s) => {
        const newLoadingPaths = new Set(s.loadingPaths);
        newLoadingPaths.delete(path);
        return {
          ...s,
          fileTree: nextTree,
          loadingPaths: newLoadingPaths,
        };
      });

      // Notify indexing callback for child nodes
      if (onNodesIndexedRef.current && children.length > 0) {
        onNodesIndexedRef.current(children, path);
      }
    },
    [commitNormalizedTree, handleMapRef, onNodesIndexedRef, portRef, shouldApplyChildLoadResult]
  );

  /**
   * Handle directory load error.
   */
  const handleLoadError = useCallback(
    (path: string, errorMsg: string, abortController: AbortController) => {
      if (!shouldApplyChildLoadResult(path, abortController)) {
        return;
      }

      const nextTree = commitNormalizedTree((currentTree) =>
        setNormalizedNodeLoadState(currentTree, path, 'error', errorMsg)
      );
      setState((s) => {
        const newLoadingPaths = new Set(s.loadingPaths);
        newLoadingPaths.delete(path);
        return {
          ...s,
          fileTree: nextTree,
          loadingPaths: newLoadingPaths,
        };
      });
    },
    [commitNormalizedTree, shouldApplyChildLoadResult]
  );

  const handleLoadAborted = useCallback(
    (path: string, abortController: AbortController) => {
      if (!shouldApplyChildLoadResult(path, abortController, true)) {
        return;
      }

      const nextTree = commitNormalizedTree((currentTree) =>
        setNormalizedNodeLoadState(currentTree, path, 'unloaded')
      );
      setState((s) => {
        const newLoadingPaths = new Set(s.loadingPaths);
        newLoadingPaths.delete(path);
        return {
          ...s,
          fileTree: nextTree,
          loadingPaths: newLoadingPaths,
        };
      });
    },
    [commitNormalizedTree, shouldApplyChildLoadResult]
  );

  /**
   * Perform the actual directory loading operation.
   * Uses streaming when available for progressive loading with progress updates.
   * Falls back to non-streaming for adapters that don't support it.
   */
  const performDirectoryLoad = useCallback(
    async (
      path: string,
      node: IFileNode,
      abortController: AbortController,
      adapter: NonNullable<typeof fileSystemAdapter>
    ): Promise<void> => {
      try {
        // Use streaming when adapter supports it
        if (supportsStreaming(adapter)) {
          await loadDirectoryChildrenStreaming(
            adapter,
            node,
            (nodes, meta) => {
              if (abortController.signal.aborted) {
                return;
              }

              if (meta.done) {
                // Final batch: update tree with complete sorted children
                handleLoadSuccess(path, nodes, abortController);
              }
              // Intermediate batches: could update progress UI here
              // For now, the loading state is sufficient indication
            },
            {
              abortSignal: abortController.signal,
              sortFileNodes,
            }
          );
        } else {
          // Fallback to non-streaming
          const children = await loadDirectoryChildren(adapter, node, {
            abortSignal: abortController.signal,
            sortFileNodes,
          });
          if (!abortController.signal.aborted) {
            handleLoadSuccess(path, children, abortController);
          }
        }
      } catch (err) {
        if (isAbortError(err)) {
          // Aborted loads may fire after their controller entry was already removed by
          // cancellation/finally cleanup, so allow the cleared-controller path here.
          handleLoadAborted(path, abortController);
          return;
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        handleLoadError(path, errorMsg, abortController);
      }
    },
    [handleLoadSuccess, handleLoadError, handleLoadAborted]
  );

  /**
   * Load children of a specific directory
   */
  const loadChildren = useCallback(
    async (path: string) => {
      if (!fileSystemAdapter) {
        return;
      }

      const existingLoad = inFlightChildLoadsRef.current.get(path);
      if (existingLoad) {
        await existingLoad;
        return;
      }

      const node = findNodeByPath(fileTreeRef.current, path);
      if (!canLoadNode(node)) {
        return;
      }

      // Create abort controller for this path
      const abortController = createAbortController(path);

      // Mark as loading
      const nextTree = commitNormalizedTree((currentTree) =>
        setNormalizedNodeLoadState(currentTree, path, 'loading')
      );
      setState((s) => ({
        ...s,
        fileTree: nextTree,
        loadingPaths: new Set([...s.loadingPaths, path]),
      }));

      const loadPromise = (async () => {
        try {
          if (!node) {
            throw new Error(`Directory node not found for path: ${path}`);
          }
          await performDirectoryLoad(path, node, abortController, fileSystemAdapter);
        } finally {
          inFlightChildLoadsRef.current.delete(path);
          removeChildController(path, abortController);
        }
      })();

      inFlightChildLoadsRef.current.set(path, loadPromise);
      await loadPromise;
    },
    [fileSystemAdapter, createAbortController, performDirectoryLoad, removeChildController]
  );
  loadChildrenRef.current = loadChildren;

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

  const cancelExpandAllLoads = useCallback(() => {
    portRef.current?.abort();
    cancelAllLoading();
    const loadingPaths = Array.from(
      new Set([...loadingPathsRef.current, ...childAbortControllersRef.current.keys()])
    );
    if (loadingPaths.length === 0) {
      setState((s) => ({
        ...s,
        loadingPaths: new Set(),
      }));
      return;
    }

    const nextTree = commitNormalizedTree((currentTree) => {
      let nextTreeState = currentTree;
      for (const path of loadingPaths) {
        nextTreeState = setNormalizedNodeLoadState(nextTreeState, path, 'unloaded');
      }
      return nextTreeState;
    });

    setState((s) => ({
      ...s,
      fileTree: nextTree,
      loadingPaths: new Set(),
    }));
  }, [cancelAllLoading, commitNormalizedTree, portRef]);

  const runWorkerExpandAll = useCallback(
    async (_args: ExpandAllExecutorArgs): Promise<ExpandAllExecutorResult> => {
      const port = portRef.current;
      if (!port) {
        throw new Error('File tree worker is unavailable for expand-all');
      }
      const rootFolderId = getRootFolderId(rootDirectoryHandle);
      if (!rootFolderId) {
        throw new Error('Cannot expand all without a root folder id');
      }

      const result = await port.expandAll(rootFolderId);
      return applyWorkerExpandAllResult({
        handleMapRef,
        onNodesIndexedRef,
        result,
        setState,
        syncNormalizedTree,
      });
    },
    [handleMapRef, onNodesIndexedRef, portRef, rootDirectoryHandle, syncNormalizedTree]
  );

  /**
   * Cancel loading for a specific directory (e.g., when collapsing a folder).
   * Aborts the streaming/loading operation and resets the node to unloaded state.
   */
  const handleCancelChildLoading = useCallback(
    (path: string) => {
      // Abort the in-flight request
      cancelChildLoading(path);
      inFlightChildLoadsRef.current.delete(path);

      // Remove from loading paths and reset node to unloaded state
      const nextTree = commitNormalizedTree((currentTree) =>
        setNormalizedNodeLoadState(currentTree, path, 'unloaded')
      );
      setState((s) => {
        const newLoadingPaths = new Set(s.loadingPaths);
        newLoadingPaths.delete(path);
        return {
          ...s,
          fileTree: nextTree,
          loadingPaths: newLoadingPaths,
        };
      });
    },
    [cancelChildLoading, commitNormalizedTree]
  );

  const {
    isExpandingAll,
    expandAllProgressively: expandAllFromHook,
    cancelExpandAll,
    isExpandingAllRef,
  } = useExpandAll({
    cancelLoadOperations: cancelExpandAllLoads,
    getNodeByPath: (path: string) =>
      materializeNormalizedShallowNode(normalizedTreeRef.current, path),
    getRootNodes: () => {
      const dirPaths = getNormalizedRootDirectoryPaths(normalizedTreeRef.current);
      return dirPaths
        .map((p) => materializeNormalizedShallowNode(normalizedTreeRef.current, p))
        .filter((n): n is import('@brainstrike/types').IFileNode => n !== undefined);
    },
    loadDirectoryPath: (path: string) => loadChildrenRef.current(path),
    onError: handleWorkerError,
    onProgress: (loaded: number, total: number) => {
      handleProgress(loaded, total, '');
    },
    rootFolderId: getRootFolderId(rootDirectoryHandle) ?? '',
    runUnloadedExpandAll: runWorkerExpandAll,
  });

  /**
   * Force refresh a specific directory
   */
  const refreshDirectory = useCallback(
    async (path: string) => {
      if (!fileSystemAdapter) {
        return;
      }

      // Reset to unloaded state first
      const nextTree = commitNormalizedTree((currentTree) =>
        setNormalizedNodeLoadState(currentTree, path, 'unloaded')
      );
      setState((s) => ({
        ...s,
        fileTree: nextTree,
      }));

      // Then load
      const node = findNodeByPath(fileTreeRef.current, path);
      if (node && node.type === 'directory') {
        await loadChildren(path);
      }
    },
    [commitNormalizedTree, fileSystemAdapter, loadChildren]
  );

  /**
   * Refresh the entire tree from root.
   *
   * Resets initializedRootRef to force loadRoot to reload the tree.
   * Without this reset, shouldSkipLoadRoot would return skip=true for
   * "already initialized" roots, preventing the tree from actually refreshing.
   *
   * @example
   * ```tsx
   * const { refreshTree } = useLazyFileTree({ rootFolderId: 'my-root' });
   * // After file system changes, call refreshTree to reload from disk
   * await refreshTree();
   * ```
   */
  const refreshTree = useCallback(async () => {
    // Reset initialized ref to force loadRoot to reload the tree
    // Without this, shouldSkipLoadRoot returns skip=true for "already initialized" roots
    initializedRootRef.current = null;
    await loadRoot();
  }, [loadRoot]);

  /**
   * Wrapper for expandAllProgressively that operates on the canonical normalized tree.
   */
  const expandAllProgressively = useCallback(
    async (
      setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
      currentExpandedPaths?: ReadonlySet<string>
    ): Promise<void> => {
      if (!fileSystemAdapter) {
        logger.warn('expandAllProgressively: missing file system adapter');
        return;
      }

      try {
        await expandAllFromHook(setExpandedPaths, currentExpandedPaths);
      } catch (err) {
        logger.error('expandAllProgressively failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        // Clear progress after operation completes (success or failure)
        setExpandAllProgress(null);
      }
    },
    [fileSystemAdapter, expandAllFromHook]
  );

  /**
   * Load specific paths using the Web Worker (for restoration).
   */
  const loadSpecificPaths = useCallback(
    async (
      paths: string[],
      onProgress?: (loaded: number, total: number, currentPath: string) => void
    ): Promise<void> => {
      if (shouldSkipSpecificPathLoad(fileSystemAdapter, isExpandingAllRef.current, paths)) {
        return;
      }

      logger.debug('loadSpecificPaths starting', { pathCount: paths.length });

      try {
        if (paths.length > 1) {
          const port = portRef.current;
          if (port) {
            await loadSpecificPathsWithWorker({
              handleMapRef,
              onNodesIndexedRef,
              onProgress,
              paths,
              port,
              setState,
              specificPathProgressRef,
              syncNormalizedTree,
            });
            return;
          }

          logger.debug(
            'loadSpecificPaths using serial restoration because worker port is unavailable',
            {
              pathCount: paths.length,
            }
          );
        }

        await loadSpecificPathsSerial({
          loadChildrenRef,
          normalizedTreeRef,
          onProgress,
          paths,
        });
      } catch (err) {
        if (!isAbortError(err)) {
          logger.error('loadSpecificPaths failed', { error: String(err) });
        }
      } finally {
        specificPathProgressRef.current = null;
      }
    },
    [fileSystemAdapter, handleMapRef, onNodesIndexedRef, portRef, syncNormalizedTree]
  );

  // Store loadRoot in a ref to avoid effect dependency on the callback itself.
  // This prevents the effect from re-running when loadRoot's dependencies change,
  // which was causing multiple loadRoot calls during initialization.
  const loadRootRef = useRef(loadRoot);
  loadRootRef.current = loadRoot;

  // Auto-load root when handle changes
  // Dependencies are minimal - only things that should actually trigger a reload
  // biome-ignore lint/plugin: This is initialization logic, not derived state
  useEffect(() => {
    if (rootDirectoryPath && rootDirectoryHandle) {
      // If expand-all is in progress but root has CHANGED, cancel and proceed with new root
      // This prevents race condition where switching folders leaves new folder empty
      if (isExpandingAllRef.current && initializedRootRef.current !== rootDirectoryPath) {
        logger.debug('loadRoot: cancelling expand-all for different root', {
          oldRoot: initializedRootRef.current,
          newRoot: rootDirectoryPath,
        });
        cancelExpandAll();
      }
      // Skip if expand-all is in progress for THIS root (same folder)
      if (isExpandingAllRef.current && initializedRootRef.current === rootDirectoryPath) {
        logger.debug('loadRoot skipped - expand-all in progress for same root');
        return;
      }
      void loadRootRef.current();
    } else {
      // Clear handle map and initialized ref when root changes
      handleMapRef.current.clear();
      initializedRootRef.current = null;
      normalizedTreeRef.current = createEmptyNormalizedFileTreeState();
      setNormalizedTreeVersion((version) => version + 1);
      setState({
        fileTree: [],
        isInitialLoading: false,
        error: null,
        loadingPaths: new Set(),
      });
    }

    // Cleanup on unmount or handle change
    return () => {
      loadRootRunIdRef.current += 1;
      isLoadingRootRef.current = false;
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
    rootDirectoryPath,
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
    cancelChildLoading: handleCancelChildLoading,
    refreshDirectory,
    refreshTree,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll,
    expandAllProgress,
    loadSpecificPaths,
    selectFolderRecursively,
    cancelRecursiveSelect,
    isLoadingForSelection,
    loadingPathForSelection,
    selectionLoadingProgress,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAll,
    selectAllLoadingProgress,
    workerPortRef: portRef,
    __internalNormalizedTreeRef: normalizedTreeRef,
    __internalNormalizedTreeVersion: normalizedTreeVersion,
    __internalGetDescendantFileCount: (path: string) =>
      getNormalizedDescendantFileCount(normalizedTreeRef.current, path),
    __internalGetDescendantFilePaths: (path: string, maxCount?: number) =>
      listNormalizedDescendantFilePaths(normalizedTreeRef.current, path, maxCount),
    __internalMaterializeSubtree: (path: string) =>
      materializeNormalizedSubtree(normalizedTreeRef.current, path),
  };
}
