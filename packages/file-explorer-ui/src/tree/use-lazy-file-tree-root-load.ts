import type { useAdapters } from '@brainstrike/file-explorer-hooks';
import type {
  AccumulatedFileTreePatchMessage,
  FileTreeWorkerPort,
  WorkerFileNode,
} from '@brainstrike/file-tree-worker';
import { sortTreeNodes } from '@brainstrike/file-tree-worker';
import { createLogger } from '@brainstrike/logging';
import type { DirectoryHandle, IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';

import {
  estimateTreePayloadBytes,
  measureFileTreeOperation,
  recordFileTreeTelemetry,
} from '../utils/file-tree-telemetry';
import {
  loadRootDirectory,
  loadRootDirectoryStreaming,
  supportsStreaming,
} from '../utils/lazy-tree-loader';
import {
  applyNormalizedDirectoryChildrenUpdates,
  getNormalizedNode,
  materializeNormalizedFileTree,
  type NormalizedDirectoryChildrenUpdate,
  type NormalizedFileTreeState,
  setNormalizedNodeLoadState,
} from '../utils/normalized-file-tree';
import {
  buildHandleMap,
  type FileNodeHandle,
  rehydrateTree,
  toWorkerFileNodes,
} from '../utils/worker-node-conversion';
import type { LazyFileTreeState, RootLoadOutcome } from './use-lazy-file-tree-types';

const logger = createLogger('LazyFileTree');

export interface InFlightRootLoad {
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

/** Deferred per-directory result buffered during renderer-fallback expand-all. */
export type PendingExpandAllUpdate =
  | { children: IFileNode[]; kind: 'children'; path: string }
  | { errorMsg: string; kind: 'error'; path: string };

const inFlightRootLoads = new Map<string, InFlightRootLoad>();

function createRootLoadKey(rootPath: string, rootFolderId?: string): string {
  return `${rootPath}::${rootFolderId ?? ''}`;
}

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
 * Establish a force-refresh boundary against a root read that was already in
 * flight when the invalidation arrived. A still-live predecessor is allowed to
 * settle for its existing consumers, but the caller starts a new physical read
 * afterward instead of joining pre-mutation I/O. An already-aborted request is
 * retired immediately; its identity-checked finalizer cannot delete the next
 * request registered under the same key.
 */
export async function waitForPriorRootLoad(rootPath: string, rootFolderId?: string): Promise<void> {
  const loadKey = createRootLoadKey(rootPath, rootFolderId);
  const priorRequest = inFlightRootLoads.get(loadKey);
  if (!priorRequest) {
    return;
  }
  if (priorRequest.abortController.signal.aborted) {
    if (inFlightRootLoads.get(loadKey) === priorRequest) {
      inFlightRootLoads.delete(loadKey);
    }
    return;
  }

  try {
    await priorRequest.promise;
  } catch (error) {
    logger.debug('Prior root load settled with an error before forced refresh', {
      error: error instanceof Error ? error.message : String(error),
      loadKey,
      rootPath,
    });
  }
  if (inFlightRootLoads.get(loadKey) === priorRequest) {
    inFlightRootLoads.delete(loadKey);
  }
}

/**
 * Sort nodes: directories first, then alphabetically.
 * Wraps the generic sortTreeNodes for IFileNode type.
 */
export function sortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return sortTreeNodes(nodes);
}

export function createRootIdentityKey(rootPath: string, rootFolderId: string): string {
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

export function prepareRootLoad(args: RootLoadPreflightArguments): RootLoadPreflightResult {
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

export function hasCommittedRootIdentityChanged(
  committedIdentity: string | null,
  nextIdentity: string
): boolean {
  return committedIdentity !== null && committedIdentity !== nextIdentity;
}

export function createLoadRootPendingState(
  currentState: LazyFileTreeState,
  publishPending = true
): LazyFileTreeState {
  if (!publishPending) {
    return currentState;
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
    error: null,
    isInitialLoading: true,
    loadingPaths: new Set(),
  };
}

export function isActiveLoadRootRun(
  isUnmountedRef: React.RefObject<boolean>,
  loadRootRunIdRef: React.RefObject<number>,
  currentRunId: number
): boolean {
  return !isUnmountedRef.current && loadRootRunIdRef.current === currentRunId;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function notifyRootNodesIndexed(
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
export function handleLoadRootSuccess(
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

export function resolveRootLoadError(args: RootLoadErrorArguments): RootLoadOutcome {
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

export function loadRootChildren(args: RootLoadArguments): RootLoadSubscription {
  const { consumerSignal, fileSystemAdapter, rootDirectoryHandle, rootPath, rootFolderId } = args;
  // Dedup by path AND identity: in forest mode the FOCUSED root is loaded by
  // BOTH its section loader (rootId = UUID) and the legacy panel loader (no
  // rootId → path-stamped). Keying by path alone let them share one in-flight
  // load, so whichever registered first stamped the other's nodes — directory
  // recursive-select then keyed composite selections by the wrong identity and
  // the selection vanished into an unread folderState.
  const loadKey = createRootLoadKey(rootPath, rootFolderId);
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

export function logStartedRootLoad(
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

export function shouldSkipSpecificPathLoad(
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
  handleMap: Map<string, FileNodeHandle>
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

export function applyWorkerPatchesToNormalizedTree(args: {
  handleMap: Map<string, FileNodeHandle>;
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
      loadedChildrenPaths.add(patch.payload.path);
      // Bulk operations only fill directories the worker saw as unloaded. A directory
      // already loaded in the latest tree was committed by a direct load while this
      // request was in flight; re-listing it would discard that load's descendants.
      if (getNormalizedNode(args.normalizedTree, patch.payload.path)?.loadState === 'loaded') {
        continue;
      }
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

export function applyWorkerExpandAllResult(args: {
  handleMapRef: React.RefObject<Map<string, FileNodeHandle>>;
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
