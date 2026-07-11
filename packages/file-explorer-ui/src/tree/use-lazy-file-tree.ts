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
import type {
  AccumulatedFileTreePatchMessage,
  FileTreeWorkerPort,
  WorkerFileNode,
} from '@brainstrike/file-tree-worker';
import type { DirectoryHandle, IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { canLoadNode, sortTreeNodes } from '@brainstrike/utils/tree-operations';
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
import {
  estimateTreePayloadBytes,
  measureFileTreeOperation,
  recordFileTreeTelemetry,
} from '../utils/file-tree-telemetry';
import { getRootFolderId } from '../utils/get-root-folder-id';
import {
  needsLoading as checkNeedsLoading,
  findNodeByPath,
  loadDirectoryChildren,
  loadDirectoryChildrenStreaming,
  loadRootDirectory,
  loadRootDirectoryStreaming,
  supportsStreaming,
} from '../utils/lazy-tree-loader';
import {
  applyNormalizedDirectoryChildrenUpdates,
  createEmptyNormalizedFileTreeState,
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
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
import {
  buildHandleMap,
  type FileSystemHandle,
  rehydrateTree,
  toWorkerFileNodes,
} from '../utils/worker-node-conversion';

const logger = createLogger('LazyFileTree');
interface InFlightRootLoad {
  abortController: AbortController;
  consumers: Set<symbol>;
  promise: Promise<IFileNode[]>;
}

interface RootLoadSubscription {
  consumerPromise: Promise<IFileNode[]>;
  request: InFlightRootLoad;
  started: boolean;
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

function createRootIdentityKey(rootPath: string, rootFolderId: string): string {
  return JSON.stringify([rootPath, rootFolderId]);
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
 * IMPORTANT: refreshTree bypasses this check explicitly so cancellation can
 * retain the initialized identity of its committed snapshot.
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
    return { reason: 'expand-all in progress for same root', skip: true };
  }

  // Skip if already initialized for this root
  if (initializedRoot === rootPath && fileTreeLength > 0) {
    return { reason: 'already initialized for this root', skip: true };
  }

  return { skip: false };
}

function resolveLoadRootSkip(
  force: boolean,
  rootPath: string,
  isExpandingAll: boolean,
  initializedRoot: string | null,
  fileTreeLength: number
): { skip: boolean; reason?: string } {
  if (force) {
    return { skip: false };
  }
  return shouldSkipLoadRoot(rootPath, isExpandingAll, initializedRoot, fileTreeLength);
}

interface RootLoadPreflightArguments {
  committedRootIdentity: string | null;
  fileSystemAdapter: ReturnType<typeof useAdapters>['fileSystemAdapter'];
  fileTreeLength: number;
  force: boolean;
  initializedRoot: string | null;
  isExpandingAll: boolean;
  resetCommittedRootState: (
    nextIdentity: string | null,
    nextRootFolderId: string,
    isInitialLoading: boolean
  ) => Error | null;
  resolvedRootFolderId: string;
  rootDirectoryHandle: DirectoryHandle | null;
}

type RootLoadPreflightResult =
  | {
      fileSystemAdapter: NonNullable<ReturnType<typeof useAdapters>['fileSystemAdapter']>;
      rootDirectoryHandle: DirectoryHandle;
      rootIdentity: string;
      rootPath: string;
      status: 'ready';
    }
  | { outcome: RootLoadOutcome; status: 'stopped' };

function prepareRootLoad(args: RootLoadPreflightArguments): RootLoadPreflightResult {
  const { fileSystemAdapter, resetCommittedRootState, rootDirectoryHandle } = args;
  if (!(rootDirectoryHandle && fileSystemAdapter)) {
    const resetError = resetCommittedRootState(null, '', false);
    if (resetError) {
      return { outcome: { error: resetError, status: 'failed' }, status: 'stopped' };
    }
    return { outcome: { status: 'skipped' }, status: 'stopped' };
  }

  const rootPath = rootDirectoryHandle.path;
  const rootIdentity = createRootIdentityKey(rootPath, args.resolvedRootFolderId);
  const rootIdentityChanged = hasCommittedRootIdentityChanged(
    args.committedRootIdentity,
    rootIdentity
  );
  if (rootIdentityChanged) {
    const resetError = resetCommittedRootState(rootIdentity, args.resolvedRootFolderId, true);
    if (resetError) {
      return { outcome: { error: resetError, status: 'failed' }, status: 'stopped' };
    }
  }

  if (!rootIdentityChanged) {
    const skipCheck = resolveLoadRootSkip(
      args.force,
      rootPath,
      args.isExpandingAll,
      args.initializedRoot,
      args.fileTreeLength
    );
    if (skipCheck.skip) {
      logger.debug(`loadRoot skipped - ${skipCheck.reason}`, { rootPath });
      return { outcome: { status: 'skipped' }, status: 'stopped' };
    }
  }

  return {
    fileSystemAdapter,
    rootDirectoryHandle,
    rootIdentity,
    rootPath,
    status: 'ready',
  };
}

function hasCommittedRootIdentityChanged(
  committedIdentity: string | null,
  nextIdentity: string
): boolean {
  return committedIdentity !== null && committedIdentity !== nextIdentity;
}

function createLoadRootPendingState(currentState: LazyFileTreeState): LazyFileTreeState {
  if (
    currentState.isInitialLoading &&
    currentState.error === null &&
    currentState.loadingPaths.size === 0
  ) {
    return currentState;
  }

  return {
    ...currentState,
    error: null,
    isInitialLoading: true,
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function notifyRootNodesIndexed(
  children: IFileNode[],
  onNodesIndexedRef?: React.RefObject<
    ((nodes: IFileNode[], parentPath: string | null) => void) | undefined
  >
): void {
  if (children.length === 0) {
    return;
  }
  onNodesIndexedRef?.current?.(children, null);
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
 */
function handleLoadRootSuccess(
  children: IFileNode[],
  rootPath: string,
  handleMapRef: React.RefObject<Map<string, unknown>>,
  portRef: React.RefObject<FileTreeWorkerPort | null>,
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>,
  initializedRootRef: React.RefObject<string | null>,
  rootFolderId: string
): void {
  const nextHandleMap = buildHandleMap(children);

  // Initialize worker with root nodes
  if (portRef.current) {
    const workerNodes = toWorkerFileNodes(children);
    const snapshotEstimate = estimateTreePayloadBytes(workerNodes);
    recordFileTreeTelemetry({
      bytes: snapshotEstimate.bytes,
      event: 'file-tree.snapshot',
      kind: 'full',
      nodeCount: snapshotEstimate.nodeCount,
    });
    portRef.current.init(workerNodes, rootFolderId);
  }

  handleMapRef.current = nextHandleMap;

  setState({
    error: null,
    fileTree: children,
    isInitialLoading: false,
    loadingPaths: new Set(),
  });

  // Mark this root as initialized to prevent redundant reinits
  initializedRootRef.current = rootPath;
}

/**
 * Handle loadRoot error.
 * Extracted to reduce cognitive complexity of loadRoot.
 *
 * @param err - The error that occurred
 * @param setState - State setter
 */
function handleLoadRootError(
  err: unknown,
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>
): void {
  if (!isAbortError(err)) {
    setState((s) => ({
      ...s,
      error: toError(err),
      isInitialLoading: false,
    }));
  }
}

function handleActiveLoadRootError(
  err: unknown,
  isUnmountedRef: React.RefObject<boolean>,
  loadRootRunIdRef: React.RefObject<number>,
  currentRunId: number,
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>
): void {
  if (isActiveLoadRootRun(isUnmountedRef, loadRootRunIdRef, currentRunId)) {
    handleLoadRootError(err, setState);
  }
}

interface RootLoadErrorArguments {
  currentRunId: number;
  error: unknown;
  isUnmountedRef: React.RefObject<boolean>;
  loadRootRunIdRef: React.RefObject<number>;
  rootConsumerController: AbortController | null;
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>;
}

function resolveRootLoadError(args: RootLoadErrorArguments): RootLoadOutcome {
  if (
    args.rootConsumerController?.signal.aborted ||
    isAbortError(args.error) ||
    !isActiveLoadRootRun(args.isUnmountedRef, args.loadRootRunIdRef, args.currentRunId)
  ) {
    return { status: 'cancelled' };
  }

  const error = toError(args.error);
  handleActiveLoadRootError(
    error,
    args.isUnmountedRef,
    args.loadRootRunIdRef,
    args.currentRunId,
    args.setState
  );
  return { error, status: 'failed' };
}

interface RootLoadArguments {
  consumerSignal: AbortSignal;
  fileSystemAdapter: NonNullable<ReturnType<typeof useAdapters>['fileSystemAdapter']>;
  rootDirectoryHandle: DirectoryHandle;
  /** Storage v5: durable RootId UUID to stamp on loaded nodes. Falls back to rootPath. */
  rootFolderId?: string;
  rootPath: string;
}

function createRootLoadConsumerPromise(
  request: InFlightRootLoad,
  signal: AbortSignal
): Promise<IFileNode[]> {
  signal.throwIfAborted();
  const consumer = Symbol('root-load-consumer');
  request.consumers.add(consumer);

  return new Promise<IFileNode[]>((resolve, reject) => {
    let active = true;
    const cleanup = (): boolean => {
      if (!active) {
        return false;
      }
      active = false;
      signal.removeEventListener('abort', handleAbort);
      request.consumers.delete(consumer);
      return true;
    };
    const handleAbort = (): void => {
      if (!cleanup()) {
        return;
      }
      if (request.consumers.size === 0 && !request.abortController.signal.aborted) {
        request.abortController.abort(signal.reason);
      }
      reject(signal.reason);
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    void request.promise.then(
      (children) => {
        if (cleanup()) {
          resolve(children);
        }
      },
      (error: unknown) => {
        if (cleanup()) {
          reject(error);
        }
      }
    );
  });
}

function createInFlightRootLoad(
  args: Omit<RootLoadArguments, 'consumerSignal'>,
  loadKey: string
): InFlightRootLoad {
  const { fileSystemAdapter, rootDirectoryHandle, rootPath, rootFolderId } = args;
  const abortController = new AbortController();
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
          abortSignal: abortController.signal,
          sortFileNodes,
          ...(rootFolderId !== undefined && { rootFolderId }),
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
      abortSignal: abortController.signal,
      sortFileNodes,
      ...(rootFolderId !== undefined && { rootFolderId }),
    });
    logger.debug('loadRoot completed - handle map built', {
      childrenCount: children.length,
      rootPath,
    });
    return children;
  })();

  const request: InFlightRootLoad = {
    abortController,
    consumers: new Set(),
    promise,
  };
  inFlightRootLoads.set(loadKey, request);
  void promise
    .finally(() => {
      if (inFlightRootLoads.get(loadKey) === request) {
        inFlightRootLoads.delete(loadKey);
      }
    })
    .catch(() => {});
  return request;
}

function loadRootChildren(args: RootLoadArguments): RootLoadSubscription {
  const { consumerSignal, fileSystemAdapter, rootDirectoryHandle, rootPath, rootFolderId } = args;
  // Dedup by path AND identity: in forest mode the FOCUSED root is loaded by
  // BOTH its section loader (rootId = UUID) and the legacy panel loader (no
  // rootId → path-stamped). Keying by path alone let them share one in-flight
  // load, so whichever registered first stamped the other's nodes — directory
  // recursive-select then keyed composite selections by the wrong identity and
  // the selection vanished into an unread folderState.
  const loadKey = `${rootPath}::${rootFolderId ?? ''}`;
  const existingRequest = inFlightRootLoads.get(loadKey);
  if (existingRequest && !existingRequest.abortController.signal.aborted) {
    logger.debug('loadRoot joined existing in-flight request', { loadKey, rootPath });
    return {
      consumerPromise: createRootLoadConsumerPromise(existingRequest, consumerSignal),
      request: existingRequest,
      started: false,
    };
  }
  if (existingRequest) {
    inFlightRootLoads.delete(loadKey);
  }

  const request = createInFlightRootLoad(
    {
      fileSystemAdapter,
      rootDirectoryHandle,
      rootPath,
      ...(rootFolderId !== undefined && { rootFolderId }),
    },
    loadKey
  );

  return {
    consumerPromise: createRootLoadConsumerPromise(request, consumerSignal),
    request,
    started: true,
  };
}

function logStartedRootLoad(
  subscription: RootLoadSubscription,
  fileTreeLength: number,
  initializedRoot: string | null,
  rootPath: string
): void {
  if (!subscription.started) {
    return;
  }
  logger.debug('loadRoot running - will reinitialize worker', {
    fileTreeLength,
    initializedRoot,
    rootPath,
  });
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

function rehydrateWorkerChildrenStrict(
  path: string,
  children: WorkerFileNode[],
  handleMap: Map<string, FileSystemHandle>
): IFileNode[] {
  const patchEstimate = estimateTreePayloadBytes(children);
  recordFileTreeTelemetry({
    bytes: patchEstimate.bytes,
    event: 'file-tree.patch',
    kind: 'patch',
    nodeCount: patchEstimate.nodeCount,
    source: 'worker',
  });

  const { durationMs, result: hydratedChildren } = measureFileTreeOperation(() =>
    rehydrateTree(children, handleMap)
  );
  recordFileTreeTelemetry({
    durationMs,
    event: 'file-tree.rehydrate',
    kind: 'patch',
    nodeCount: patchEstimate.nodeCount,
    source: 'worker',
  });

  const expectedNodeCount = countTreeNodes(children);
  const actualNodeCount = countTreeNodes(hydratedChildren);

  if (actualNodeCount !== expectedNodeCount) {
    throw new Error(
      `File-tree worker patch for ${path} included ${expectedNodeCount} nodes but only ${actualNodeCount} could be rehydrated`
    );
  }

  return hydratedChildren;
}

function applyWorkerPatchesToNormalizedTree(args: {
  handleMap: Map<string, FileSystemHandle>;
  normalizedTree: NormalizedFileTreeState;
  patches: readonly AccumulatedFileTreePatchMessage[];
}): {
  indexedNodes: IFileNode[];
  normalizedTree: NormalizedFileTreeState;
} {
  const { handleMap, patches } = args;
  const childrenUpdates: NormalizedDirectoryChildrenUpdate[] = [];
  const indexedNodes: IFileNode[] = [];
  const loadedChildrenPaths = new Set<string>();
  const loadStatePatches: Extract<
    AccumulatedFileTreePatchMessage,
    { type: 'nodeLoadStateChanged' }
  >[] = [];

  for (const patch of patches) {
    if (patch.type === 'childrenLoaded') {
      const children = rehydrateWorkerChildrenStrict(
        patch.payload.path,
        patch.payload.children,
        handleMap
      );
      childrenUpdates.push({
        children,
        loadState: patch.payload.loadState,
        path: patch.payload.path,
      });
      loadedChildrenPaths.add(patch.payload.path);
      indexedNodes.push(...children);
      continue;
    }

    if (patch.type === 'nodeLoadStateChanged') {
      loadStatePatches.push(patch);
      continue;
    }

    const _exhaustive: never = patch;
    throw new Error(`Unhandled file tree worker patch: ${JSON.stringify(_exhaustive)}`);
  }

  let nextNormalizedTree = applyNormalizedDirectoryChildrenUpdates(
    args.normalizedTree,
    childrenUpdates
  );

  // Child replacement patches carry the authoritative final load state.
  // Apply load-state-only patches afterward, but ignore stale loading events for loaded paths.
  for (const patch of loadStatePatches) {
    if (patch.payload.loadState === 'loading' && loadedChildrenPaths.has(patch.payload.path)) {
      continue;
    }
    nextNormalizedTree = setNormalizedNodeLoadState(
      nextNormalizedTree,
      patch.payload.path,
      patch.payload.loadState,
      patch.payload.loadError
    );
  }

  return { indexedNodes, normalizedTree: nextNormalizedTree };
}

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

function applyWorkerExpandAllResult(args: {
  handleMapRef: React.RefObject<Map<string, FileSystemHandle>>;
  normalizedTreeRef: React.RefObject<NormalizedFileTreeState>;
  onNodesIndexedRef: React.RefObject<
    ((nodes: IFileNode[], parentPath: string | null) => void) | undefined
  >;
  result: Awaited<ReturnType<FileTreeWorkerPort['expandAll']>>;
  setState: React.Dispatch<React.SetStateAction<LazyFileTreeState>>;
  setNormalizedTreeVersion: React.Dispatch<React.SetStateAction<number>>;
}): { discoveredDirectories: number; pathsToCommit: readonly string[] } {
  const {
    handleMapRef,
    normalizedTreeRef,
    onNodesIndexedRef,
    result,
    setNormalizedTreeVersion,
    setState,
  } = args;
  const patchResult = applyWorkerPatchesToNormalizedTree({
    handleMap: handleMapRef.current,
    normalizedTree: normalizedTreeRef.current,
    patches: result.patches,
  });
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

export type FileTreeRefreshResult = { status: 'cancelled' } | { status: 'completed' };

type RootLoadOutcome =
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
      fileTreeRef.current = [];
      normalizedTreeRef.current = createEmptyNormalizedFileTreeState();
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
      const indexedChildren: IFileNode[] = [];
      for (const update of updates) {
        for (const child of update.children) {
          if (child.handle) {
            handleMapRef.current.set(child.path, child.handle);
          }
          indexedChildren.push(child);
        }
      }
      if (portRef.current) {
        for (const update of updates) {
          portRef.current.updateTree(update.path, toWorkerFileNodes([...update.children]));
        }
      }
      const nextTree = commitNormalizedTree((currentTree) =>
        applyNormalizedDirectoryChildrenUpdates(
          currentTree,
          updates.map((update) => ({ children: [...update.children], path: update.path }))
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
  }, [cancelAllChildLoading, commitNormalizedTree, portRef]);

  const runWorkerExpandAll = useCallback(
    async (_args: ExpandAllExecutorArgs): Promise<ExpandAllExecutorResult | null> => {
      const port = portRef.current;
      if (!port) {
        // Worker unavailable (failed to start, or test env) — signal the
        // caller to run the in-renderer session path instead of erroring.
        logger.warn('Expand-all worker unavailable — using in-renderer fallback');
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

  return {
    __internalGetDescendantFileCount: (path: string) =>
      getNormalizedDescendantFileCount(normalizedTreeRef.current, path),
    __internalGetDescendantFilePaths: (path: string, maxCount?: number) =>
      listNormalizedDescendantFilePaths(normalizedTreeRef.current, path, maxCount),
    __internalMaterializeSubtree: (path: string) =>
      materializeNormalizedSubtree(normalizedTreeRef.current, path),
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
