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
import { canLoadNode } from '@brainstrike/file-tree-worker';
import { createLogger } from '@brainstrike/logging';
import type { DirectoryHandle, IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useAbortControllers,
  useExpandAll,
  useRecursiveFolderSelect,
  useRecursiveSelectAll,
} from '../hooks';
import type { AddMultipleSelectedFilesChunked } from '../hooks/recursive-selection-utils';
import type { ExpandAllExecutorArgs, ExpandAllExecutorResult } from '../hooks/use-expand-all';
import { useFileTreeWorker } from '../hooks/use-file-tree-worker';
import { estimateTreePayloadBytes, recordFileTreeTelemetry } from '../utils/file-tree-telemetry';
import { getRootFolderId } from '../utils/get-root-folder-id';
import {
  needsLoading as checkNeedsLoading,
  findNodeByPath,
  loadDirectoryChildren,
  loadDirectoryChildrenStreaming,
  supportsStreaming,
} from '../utils/lazy-tree-loader';
import {
  applyNormalizedDirectoryChildrenUpdates,
  createEmptyNormalizedFileTreeState,
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
  getNormalizedNode,
  getNormalizedRootDirectoryPaths,
  listNormalizedDescendantFilePaths,
  materializeNormalizedFileTree,
  materializeNormalizedShallowNode,
  materializeNormalizedSubtree,
  type NormalizedDirectoryChildrenUpdate,
  type NormalizedFileTreeState,
  replaceNormalizedDirectoryChildren,
  setNormalizedNodeLoadState,
} from '../utils/normalized-file-tree';
import type { RecursiveSelectionDirectoryUpdate } from '../utils/recursive-selection-query';
import { type FileSystemHandle, toWorkerFileNodes } from '../utils/worker-node-conversion';
import type { InFlightRootLoad, PendingExpandAllUpdate } from './use-lazy-file-tree-root-load';
import {
  applyWorkerExpandAllResult,
  applyWorkerPatchesToNormalizedTree,
  createLoadRootPendingState,
  createRootIdentityKey,
  handleLoadRootSuccess,
  hasCommittedRootIdentityChanged,
  isActiveLoadRootRun,
  loadRootChildren,
  logStartedRootLoad,
  notifyRootNodesIndexed,
  prepareRootLoad,
  resolveRootLoadError,
  shouldSkipSpecificPathLoad,
  sortFileNodes,
  toError,
} from './use-lazy-file-tree-root-load';

export { __resetInFlightRootLoads } from './use-lazy-file-tree-root-load';

const logger = createLogger('LazyFileTree');
type SpecificPathProgressHandler = (loaded: number, total: number, currentPath: string) => void;

async function loadSpecificPathsWithWorker(args: {
  handleMapRef: React.RefObject<Map<string, FileSystemHandle>>;
  normalizedTreeRef: React.RefObject<NormalizedFileTreeState>;
  onNodesIndexedRef: React.RefObject<
    ((nodes: IFileNode[], parentPath: string | null) => void) | undefined
  >;
  onProgress: SpecificPathProgressHandler | undefined;
  paths: string[];
  port: FileTreeWorkerPort;
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>;
  specificPathProgressRef: React.RefObject<SpecificPathProgressHandler | null>;
  setNormalizedTreeVersion: React.Dispatch<React.SetStateAction<number>>;
}): Promise<void> {
  const {
    handleMapRef,
    normalizedTreeRef,
    onNodesIndexedRef,
    onProgress,
    paths,
    port,
    setState,
    setNormalizedTreeVersion,
    specificPathProgressRef,
  } = args;
  const total = paths.length;

  specificPathProgressRef.current = onProgress ?? null;
  onProgress?.(0, total, paths[0] ?? '');

  const result = await port.loadPaths(paths);
  // FileTreeWorkerPort guarantees one pending bulk operation; a newer operation rejects this one
  // before its patches can be applied to this normalized tree snapshot.
  // Direct child loads may still commit while the bulk request is in flight, so use the latest
  // normalized tree as the base and let the completed bulk patches win only for paths they touch.
  // Same-microtask completions intentionally compose through this ref: each patch set sees the
  // prior result so disjoint directory patches cannot overwrite each other with stale base state.
  const patchResult = applyWorkerPatchesToNormalizedTree({
    handleMap: handleMapRef.current,
    normalizedTree: normalizedTreeRef.current,
    patches: result.patches,
  });
  // The ref is the patch-composition source of truth; React state is the hydrated view of it.
  normalizedTreeRef.current = patchResult.normalizedTree;
  const hydratedTree = materializeNormalizedFileTree(patchResult.normalizedTree);
  setNormalizedTreeVersion((version) => version + 1);
  setState((s) => ({
    ...s,
    fileTree: hydratedTree,
    loadingPaths: new Set(),
  }));
  if (onNodesIndexedRef.current && patchResult.indexedNodes.length > 0) {
    onNodesIndexedRef.current(patchResult.indexedNodes, null);
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

export interface LazyFileTreeState {
  error: Error | null;
  fileTree: IFileNode[];
  isInitialLoading: boolean;
  loadingPaths: Set<string>;
}

export type FileTreeRefreshResult = { status: 'cancelled' } | { status: 'completed' };

export type RootLoadOutcome =
  | FileTreeRefreshResult
  | { error: Error; status: 'failed' }
  | { status: 'skipped' };

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
  /**
   * Progressively expand all directories (loads everything). The optional
   * onProgress mirrors this run's expandAllProgress updates to the caller —
   * forest sections use it to push progress into the registry at the event
   * source instead of relaying committed state through effects.
   */
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
    currentExpandedPaths?: ReadonlySet<string>,
    onProgress?: (loaded: number, total: number) => void
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
  loadRoot: () => Promise<RootLoadOutcome>;
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
  refreshTree: () => Promise<FileTreeRefreshResult>;
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

  /**
   * Durable RootId UUID for this root (storage v5).
   * When provided, nodes are stamped with this value as their `rootFolderId`
   * instead of `handle.path`. The FileTreeIndex and selection composite keys
   * therefore carry the UUID, satisfying the linchpin equality:
   * `fileNode.rootFolderId === folderId` in use-shared-file-content-loading.
   * Falls back to `handle.path` when absent (pre-v5 handles / tests that have
   * not threaded the identity yet).
   */
  rootId?: string;
}

/** The exact target a completed `resetCommittedRootState` committed to. */
interface CommittedReset {
  identity: string | null;
  isInitialLoading: boolean;
  rootFolderId: string;
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
  const { filterTreeFn, onNodesIndexed, rootId } = options;
  const { fileSystemAdapter } = useAdapters();
  const rootDirectoryPath = rootDirectoryHandle?.path ?? null;

  // Ref for callback to avoid stale closures
  const onNodesIndexedRef = useRef(onNodesIndexed);
  onNodesIndexedRef.current = onNodesIndexed;

  // Core state
  const [state, setState] = useState<LazyFileTreeState>({
    error: null,
    fileTree: [],
    isInitialLoading: false,
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
  const committedRootIdentityRef = useRef<string | null>(null);
  /**
   * The target of the last reset that actually reached the worker. Two
   * independent no-root paths call `resetCommittedRootState(null, '', false)` —
   * the auto-load effect's `else` branch and `prepareRootLoad`'s missing
   * handle/adapter return — so without this the worker is re-initialized once
   * per trigger during startup, before any root exists.
   */
  const committedResetRef = useRef<CommittedReset | null>(null);

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

  // Renderer-fallback expand-all commit batching. Each commitNormalizedTree
  // clones the normalized maps and rematerializes the tree (O(tree)), so
  // committing per directory made expand-all O(tree × directories). While the
  // RENDERER session runs (rendererExpandAllSessionRef — the worker fast path
  // must keep committing per directory, or its deep patches could later be
  // clobbered by a stale buffered flush), directory results — loaded children
  // AND load errors — accumulate here and are published once per traversal
  // batch via the session's onBatchLoadsSettled boundary (plus on
  // cancellation and at session end for stragglers).
  const rendererExpandAllSessionRef = useRef(false);
  const pendingExpandAllUpdatesRef = useRef<PendingExpandAllUpdate[]>([]);

  const flushPendingExpandAllUpdates = useCallback((): void => {
    const pendingUpdates = pendingExpandAllUpdatesRef.current;
    if (pendingUpdates.length === 0) {
      return;
    }
    pendingExpandAllUpdatesRef.current = [];
    const childrenUpdates: NormalizedDirectoryChildrenUpdate[] = [];
    const errorUpdates: Extract<PendingExpandAllUpdate, { kind: 'error' }>[] = [];
    for (const update of pendingUpdates) {
      if (update.kind === 'children') {
        childrenUpdates.push({ children: update.children, path: update.path });
      } else {
        errorUpdates.push(update);
      }
    }
    const nextTree = commitNormalizedTree((currentTree) => {
      let nextNormalized = applyNormalizedDirectoryChildrenUpdates(currentTree, childrenUpdates);
      for (const update of errorUpdates) {
        nextNormalized = setNormalizedNodeLoadState(
          nextNormalized,
          update.path,
          'error',
          update.errorMsg
        );
      }
      return nextNormalized;
    });
    setState((s) => {
      if (s.loadingPaths.size === 0) {
        return { ...s, fileTree: nextTree };
      }
      // A load that began before expand-all started tracked its path in
      // loadingPaths; its buffered result must clear that entry too.
      const newLoadingPaths = new Set(s.loadingPaths);
      for (const update of pendingUpdates) {
        newLoadingPaths.delete(update.path);
      }
      return { ...s, fileTree: nextTree, loadingPaths: newLoadingPaths };
    });
  }, [commitNormalizedTree]);

  // Per-run listener mirroring expand-all progress to the caller (see
  // expandAllProgressively's onProgress). A ref, not state: the value is only
  // consumed inside handleProgress and must never re-wire the worker.
  const expandAllProgressListenerRef = useRef<((loaded: number, total: number) => void) | null>(
    null
  );

  // Progress handler - defined before useFileTreeWorker so we can pass it
  const handleProgress = useCallback((loaded: number, total: number, currentPath: string) => {
    const specificPathProgress = specificPathProgressRef.current;
    if (specificPathProgress) {
      specificPathProgress(loaded, total, currentPath);
      return;
    }
    setExpandAllProgress({ loaded, total });
    expandAllProgressListenerRef.current?.(loaded, total);
  }, []);

  // Abort controller management
  const {
    childAbortControllersRef,
    createAbortController,
    cancelAllChildLoading,
    cancelAllLoading,
    cancelChildLoading,
    removeChildController,
  } = useAbortControllers();

  /**
   * Storage v5: durable RootId UUID when provided, otherwise the root path.
   * Pre-computed outside loadRoot to avoid adding a ?? branch inside the
   * already-complex callback (Biome noExcessiveCognitiveComplexity limit = 20).
   */
  const resolvedRootFolderId = useMemo(
    () => rootId ?? rootDirectoryHandle?.path ?? '',
    [rootId, rootDirectoryHandle?.path]
  );

  // Worker and handle map management - pass progress handler
  const { portRef, handleMapRef, setRootHandle } = useFileTreeWorker({
    fileSystemAdapter,
    onError: handleWorkerError,
    onProgress: handleProgress,
  });

  const resetCommittedRootState = useCallback(
    (
      nextIdentity: string | null,
      nextRootFolderId: string,
      isInitialLoading: boolean
    ): Error | null => {
      // A reset is redundant only when the state is ALREADY precisely what this
      // reset would produce: same target, and nothing loaded since it was
      // committed. Any real load repopulates the tree, the handle map,
      // `initializedRootRef` or `lastAppliedRootLoadRef`, so a reset that has
      // work to do can never be swallowed here — this skips duplicate no-ops,
      // it does not soften a genuine reset.
      const lastReset = committedResetRef.current;
      if (
        lastReset !== null &&
        lastReset.identity === nextIdentity &&
        lastReset.rootFolderId === nextRootFolderId &&
        lastReset.isInitialLoading === isInitialLoading &&
        committedRootIdentityRef.current === nextIdentity &&
        initializedRootRef.current === null &&
        lastAppliedRootLoadRef.current === null &&
        fileTreeRef.current.length === 0 &&
        handleMapRef.current.size === 0
      ) {
        return null;
      }

      fileTreeRef.current = [];
      normalizedTreeRef.current = createEmptyNormalizedFileTreeState();
      rendererExpandAllSessionRef.current = false;
      pendingExpandAllUpdatesRef.current = [];
      handleMapRef.current.clear();
      initializedRootRef.current = null;
      lastAppliedRootLoadRef.current = null;
      committedRootIdentityRef.current = nextIdentity;
      setNormalizedTreeVersion((version) => version + 1);
      setState({
        error: null,
        fileTree: [],
        isInitialLoading,
        loadingPaths: new Set(),
      });

      const port = portRef.current;
      if (!port) {
        return null;
      }

      try {
        port.init([], nextRootFolderId);
        // Recorded ONLY once the worker has actually been told, so a throwing
        // init (or a not-yet-created port above) leaves the next call free to
        // retry rather than marking a reset the worker never received.
        committedResetRef.current = {
          identity: nextIdentity,
          isInitialLoading,
          rootFolderId: nextRootFolderId,
        };
        return null;
      } catch (error) {
        const workerError = toError(error);
        logger.error('Failed to reset root worker snapshot', {
          error: workerError.message,
          rootFolderId: nextRootFolderId,
        });
        setState((currentState) => ({
          ...currentState,
          error: workerError,
          isInitialLoading: false,
        }));
        return workerError;
      }
    },
    [handleMapRef, portRef]
  );

  // Keep root handle ref in sync. The RootId is threaded alongside so that
  // worker-loaded (expand-all) subtree nodes carry the durable identity
  // instead of the path (storage v5).
  useEffect(() => {
    setRootHandle(rootDirectoryHandle, resolvedRootFolderId);
  }, [rootDirectoryHandle, resolvedRootFolderId, setRootHandle]);

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

  /**
   * Ingest the raw directory listings a recursive-select scan already read
   * from disk. Without this the selection lands while the tree stays
   * unloaded, so the folder can never prove completeness and sits at
   * indeterminate until the user manually expands every subdirectory (the
   * forest/explicit-selection path has no query manifest to fall back on).
   */
  const handleScannedDirectoriesLoaded = useCallback(
    (updates: readonly RecursiveSelectionDirectoryUpdate[]) => {
      if (updates.length === 0) {
        return;
      }
      // Parent-first ordering for BOTH sinks. The normalized apply sorts
      // internally, but the worker's applyDirectoryChildrenUpdate silently
      // drops a patch whose parent it has not indexed yet — the scan happens
      // to record parents before children today, but that is an incidental
      // property of its traversal, not a contract; sort here so the two
      // sinks can never drift.
      const orderedUpdates = [...updates].sort((a, b) => a.path.length - b.path.length);
      const indexedChildren: IFileNode[] = [];
      for (const update of orderedUpdates) {
        for (const child of update.children) {
          if (child.handle) {
            handleMapRef.current.set(child.path, child.handle);
          }
          indexedChildren.push(child);
        }
      }
      if (portRef.current) {
        for (const update of orderedUpdates) {
          portRef.current.updateTree(update.path, toWorkerFileNodes([...update.children]));
        }
      }
      const nextTree = commitNormalizedTree((currentTree) =>
        applyNormalizedDirectoryChildrenUpdates(
          currentTree,
          orderedUpdates.map((update) => ({ children: [...update.children], path: update.path }))
        )
      );
      setState((s) => ({ ...s, fileTree: nextTree }));
      if (onNodesIndexedRef.current && indexedChildren.length > 0) {
        onNodesIndexedRef.current(indexedChildren, null);
      }
    },
    [commitNormalizedTree, handleMapRef, onNodesIndexedRef, portRef]
  );

  const folderSelectHookOptions = {
    cancelLoadOperations: cancelAllChildLoading,
    fileSystemAdapter,
    getSubtreeByPath: (path: string) =>
      materializeNormalizedSubtree(normalizedTreeRef.current, path),
    onDirectoriesLoaded: handleScannedDirectoriesLoaded,
    onError: handleWorkerError,
    ...filterTreeOption,
  };

  const selectAllHookOptions = {
    cancelLoadOperations: cancelAllChildLoading,
    fileSystemAdapter,
    getCurrentTree: () => materializeNormalizedFileTree(normalizedTreeRef.current),
    onError: handleWorkerError,
    onTreeUpdate: handleTreeUpdate,
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
  const loadRoot = useCallback(
    async (force = false): Promise<RootLoadOutcome> => {
      // CRITICAL: Guard against concurrent loadRoot calls FIRST
      // This must be checked and set atomically before any other logic to prevent
      // race conditions during React StrictMode double-mount or rapid re-renders
      if (isLoadingRootRef.current) {
        logger.debug('loadRoot skipped - already loading');
        return { status: 'skipped' };
      }
      // Set flag IMMEDIATELY after guard passes - before any other code
      isLoadingRootRef.current = true;
      const currentRunId = ++loadRootRunIdRef.current;

      const preflight = prepareRootLoad({
        committedRootIdentity: committedRootIdentityRef.current,
        fileSystemAdapter,
        fileTreeLength: fileTreeRef.current.length,
        force,
        initializedRoot: initializedRootRef.current,
        isExpandingAll: isExpandingAllRef.current,
        resetCommittedRootState,
        resolvedRootFolderId,
        rootDirectoryHandle,
      });
      if (preflight.status === 'stopped') {
        isLoadingRootRef.current = false;
        return preflight.outcome;
      }
      const { rootIdentity, rootPath } = preflight;

      let rootConsumerController: AbortController | null = null;
      try {
        rootConsumerController = createAbortController(null);
        const rootLoadRequest = loadRootChildren({
          consumerSignal: rootConsumerController.signal,
          fileSystemAdapter: preflight.fileSystemAdapter,
          rootDirectoryHandle: preflight.rootDirectoryHandle,
          rootFolderId: resolvedRootFolderId,
          rootPath,
        });

        logStartedRootLoad(
          rootLoadRequest,
          fileTreeRef.current.length,
          initializedRootRef.current,
          rootPath
        );

        const requestAlreadyApplied = lastAppliedRootLoadRef.current === rootLoadRequest.request;
        if (!requestAlreadyApplied) {
          setState(createLoadRootPendingState);
        }

        const children = await rootLoadRequest.consumerPromise;

        if (!isActiveLoadRootRun(isUnmountedRef, loadRootRunIdRef, currentRunId)) {
          return { status: 'cancelled' };
        }
        if (requestAlreadyApplied || lastAppliedRootLoadRef.current === rootLoadRequest.request) {
          setState((currentState) => ({ ...currentState, isInitialLoading: false }));
          return { status: 'completed' };
        }

        handleLoadRootSuccess(
          children,
          rootPath,
          handleMapRef,
          portRef,
          setState,
          initializedRootRef,
          // Storage v5: worker init uses the resolved RootId so that worker-
          // side composite keys match the store's identity.
          resolvedRootFolderId
        );
        syncNormalizedTree(children);
        committedRootIdentityRef.current = rootIdentity;
        lastAppliedRootLoadRef.current = rootLoadRequest.request;
        notifyRootNodesIndexed(children, onNodesIndexedRef);
        return { status: 'completed' };
      } catch (err) {
        return resolveRootLoadError({
          currentRunId,
          error: err,
          isUnmountedRef,
          loadRootRunIdRef,
          rootConsumerController,
          setState,
        });
      } finally {
        if (isActiveLoadRootRun(isUnmountedRef, loadRootRunIdRef, currentRunId)) {
          isLoadingRootRef.current = false;
        }
      }
    },
    [
      rootDirectoryHandle,
      fileSystemAdapter,
      createAbortController,
      handleMapRef,
      portRef,
      resetCommittedRootState,
      syncNormalizedTree,
      resolvedRootFolderId,
    ]
  );

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
        const patchEstimate = estimateTreePayloadBytes(workerChildren);
        recordFileTreeTelemetry({
          bytes: patchEstimate.bytes,
          event: 'file-tree.patch',
          kind: 'patch',
          nodeCount: patchEstimate.nodeCount,
        });
        portRef.current.updateTree(path, workerChildren);
      }

      // During renderer-fallback expand-all, defer the O(tree) normalized
      // commit to the per-batch flush; the handle map and worker (above) and
      // the index callback (below) still ingest per directory.
      if (rendererExpandAllSessionRef.current) {
        pendingExpandAllUpdatesRef.current.push({ children, kind: 'children', path });
      } else {
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
      }

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

      // Failed directories ride the same per-batch flush during the renderer
      // expand-all session — a per-error commit is the same O(tree) cost the
      // batching removes from the success path.
      if (rendererExpandAllSessionRef.current) {
        pendingExpandAllUpdatesRef.current.push({ errorMsg, kind: 'error', path });
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

      // Expand-all suppresses the per-directory 'loading' commit, so an
      // aborted load has nothing to reset — skip the O(tree) commit.
      // (Batch cancellation resets are owned by cancelExpandAllLoads.)
      if (getNormalizedNode(normalizedTreeRef.current, path)?.loadState !== 'loading') {
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

      // Mark as loading. Suppressed during the renderer expand-all session:
      // it publishes batched loaded results and reports progress through its
      // own UI, and a per-directory 'loading' commit would reintroduce the
      // O(tree) clone+materialize per directory the batching exists to avoid.
      if (!rendererExpandAllSessionRef.current) {
        const nextTree = commitNormalizedTree((currentTree) =>
          setNormalizedNodeLoadState(currentTree, path, 'loading')
        );
        setState((s) => ({
          ...s,
          fileTree: nextTree,
          loadingPaths: new Set([...s.loadingPaths, path]),
        }));
      }

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
    loadRootRunIdRef.current += 1;
    isLoadingRootRef.current = false;
    cancelAllLoading();
    setState((s) => ({
      ...s,
      isInitialLoading: false,
      loadingPaths: new Set(),
    }));
  }, [cancelAllLoading]);

  const cancelExpandAllLoads = useCallback(() => {
    // Publish already-loaded batch results before resetting: the worker and
    // handle map ingested them, so dropping them would let the sinks drift.
    flushPendingExpandAllUpdates();
    portRef.current?.abort();
    cancelAllChildLoading();
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
  }, [cancelAllChildLoading, commitNormalizedTree, flushPendingExpandAllUpdates, portRef]);

  const runWorkerExpandAll = useCallback(
    async (_args: ExpandAllExecutorArgs): Promise<ExpandAllExecutorResult | null> => {
      const port = portRef.current;
      if (!port) {
        // Worker unavailable (failed to start, or test env) — signal the
        // caller to run the in-renderer session path instead of erroring.
        // Arm batched commits for that session only; the worker path must
        // keep per-directory commits so its deep patches can never be
        // clobbered by a stale buffered flush.
        logger.warn('Expand-all worker unavailable — using in-renderer fallback');
        rendererExpandAllSessionRef.current = true;
        return null;
      }
      // Storage v5: use durable RootId UUID when available.
      const rootFolderId = rootId ?? getRootFolderId(rootDirectoryHandle);
      if (!rootFolderId) {
        throw new Error('Cannot expand all without a root folder id');
      }

      const result = await port.expandAll(rootFolderId);
      return applyWorkerExpandAllResult({
        handleMapRef,
        normalizedTreeRef,
        onNodesIndexedRef,
        result,
        setNormalizedTreeVersion,
        setState,
      });
    },
    [
      handleMapRef,
      normalizedTreeRef,
      onNodesIndexedRef,
      portRef,
      rootDirectoryHandle,
      rootId,
      setNormalizedTreeVersion,
    ]
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
    // Publish buffered directory results once per traversal batch, before the
    // session's discovery phase reads the tree.
    onBatchLoadsSettled: flushPendingExpandAllUpdates,
    onError: handleWorkerError,
    onProgress: (loaded: number, total: number) => {
      handleProgress(loaded, total, '');
    },
    // Storage v5: use durable RootId UUID when available.
    rootFolderId: rootId ?? getRootFolderId(rootDirectoryHandle) ?? '',
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
   * Forces enumeration without clearing the committed root identity. Keeping
   * that identity intact lets cancellation retain one coherent snapshot across
   * the visible tree, normalized cache, handles, and worker.
   *
   * @example
   * ```tsx
   * const { refreshTree } = useLazyFileTree({ rootFolderId: 'my-root' });
   * // After file system changes, call refreshTree to reload from disk
   * await refreshTree();
   * ```
   */
  const refreshTree = useCallback(async (): Promise<FileTreeRefreshResult> => {
    const outcome = await loadRoot(true);
    if (outcome.status === 'failed') {
      throw outcome.error;
    }
    if (outcome.status === 'completed') {
      return outcome;
    }
    return { status: 'cancelled' };
  }, [loadRoot]);

  /**
   * Wrapper for expandAllProgressively that operates on the canonical normalized tree.
   */
  const expandAllProgressively = useCallback(
    async (
      setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
      currentExpandedPaths?: ReadonlySet<string>,
      onProgress?: (loaded: number, total: number) => void
    ): Promise<void> => {
      if (!fileSystemAdapter) {
        logger.warn('expandAllProgressively: missing file system adapter');
        return;
      }

      expandAllProgressListenerRef.current = onProgress ?? null;
      try {
        await expandAllFromHook(setExpandedPaths, currentExpandedPaths);
      } catch (err) {
        logger.error('expandAllProgressively failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        expandAllProgressListenerRef.current = null;
        // Disarm batching BEFORE the final flush so any load resolving after
        // teardown commits directly instead of parking in the buffer.
        rendererExpandAllSessionRef.current = false;
        // Publish any straggler batch results (e.g. a load that resolved
        // between cancellation's flush and session teardown).
        flushPendingExpandAllUpdates();
        // Clear progress after operation completes (success or failure)
        setExpandAllProgress(null);
      }
    },
    [fileSystemAdapter, expandAllFromHook, flushPendingExpandAllUpdates]
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
              normalizedTreeRef,
              onNodesIndexedRef,
              onProgress,
              paths,
              port,
              setNormalizedTreeVersion,
              setState,
              specificPathProgressRef,
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
  useEffect(() => {
    if (rootDirectoryPath && rootDirectoryHandle) {
      const nextRootIdentity = createRootIdentityKey(rootDirectoryPath, resolvedRootFolderId);
      const rootIdentityChanged = hasCommittedRootIdentityChanged(
        committedRootIdentityRef.current,
        nextRootIdentity
      );
      // If expand-all is in progress but root has CHANGED, cancel and proceed with new root
      // This prevents race condition where switching folders leaves new folder empty
      if (isExpandingAllRef.current && rootIdentityChanged) {
        logger.debug('loadRoot: cancelling expand-all for different root', {
          newRoot: rootDirectoryPath,
          oldRoot: initializedRootRef.current,
        });
        cancelExpandAll();
      }
      // Skip if expand-all is in progress for THIS root (same folder)
      if (isExpandingAllRef.current && !rootIdentityChanged) {
        logger.debug('loadRoot skipped - expand-all in progress for same root');
        return;
      }
      void loadRootRef.current();
    } else {
      resetCommittedRootState(null, '', false);
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
    resolvedRootFolderId,
    cancelAllLoading,
    portRef,
    isExpandingAllRef,
    cancelExpandAll,
    resetCommittedRootState,
  ]);

  // Stable identities (#1594b): these read `normalizedTreeRef.current` at CALL
  // time, so wrapping them in useCallback keyed only on the stable ref is
  // behaviorally identical while keeping their identity fixed across renders.
  // Without this, each render minted fresh arrows, breaking the downstream
  // FileTreeNormalizedContext value memo and rebuilding every tree row on every
  // selection toggle.
  const getDescendantFileCount = useCallback(
    (path: string) => getNormalizedDescendantFileCount(normalizedTreeRef.current, path),
    [normalizedTreeRef]
  );
  const getDescendantFilePaths = useCallback(
    (path: string, maxCount?: number) =>
      listNormalizedDescendantFilePaths(normalizedTreeRef.current, path, maxCount),
    [normalizedTreeRef]
  );
  const materializeSubtree = useCallback(
    (path: string) => materializeNormalizedSubtree(normalizedTreeRef.current, path),
    [normalizedTreeRef]
  );

  return {
    __internalGetDescendantFileCount: getDescendantFileCount,
    __internalGetDescendantFilePaths: getDescendantFilePaths,
    __internalMaterializeSubtree: materializeSubtree,
    __internalNormalizedTreeRef: normalizedTreeRef,
    __internalNormalizedTreeVersion: normalizedTreeVersion,
    cancelChildLoading: handleCancelChildLoading,
    cancelExpandAll,
    cancelLoading,
    cancelRecursiveSelect,
    cancelSelectAll,
    error: state.error,
    expandAllProgress,
    expandAllProgressively,
    fileTree: state.fileTree,
    isExpandingAll,
    isLoading: state.isInitialLoading || state.loadingPaths.size > 0,
    isLoadingForSelectAll,
    isLoadingForSelection,
    loadChildren,
    loadingPathForSelection,
    loadingPaths: state.loadingPaths,
    loadRoot,
    loadSpecificPaths,
    needsLoading,
    refreshDirectory,
    refreshTree,
    selectAllLoadingProgress,
    selectAllRecursively,
    selectFolderRecursively,
    selectionLoadingProgress,
    workerPortRef: portRef,
  };
}
