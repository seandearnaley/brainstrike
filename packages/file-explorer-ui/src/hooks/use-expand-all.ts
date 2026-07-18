/**
 * Expand All Hook
 *
 * Manages expand-all operation state and orchestration.
 * Uses a batched renderer-side traversal session so large trees progressively
 * reveal expanded directories instead of waiting for one final commit.
 *
 * @module use-expand-all
 */

import type { IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { startTransition, useCallback, useRef, useState } from 'react';

import { createDirectDirectoryTraversalSession } from './direct-directory-traversal';

const logger = createLogger('ExpandAll');
const defaultNow = (): number => performance.now();

interface ExpandAllBatchConfig {
  maxBatchDurationMs?: number;
  maxConcurrentLoads?: number;
  maxDirectories?: number;
  maxDirectoriesPerBatch?: number;
}

export interface ExpandAllMetrics {
  batchCount: number;
  commitDurationMs: number;
  committedBatchCount: number;
  discoveryDurationMs: number;
}

const defaultYieldToBrowser = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function shouldSkipExpandAll(isAlreadyStarting: boolean): { skip: boolean; reason?: string } {
  if (isAlreadyStarting) {
    return { reason: 'blocked by double-click guard', skip: true };
  }
  return { skip: false };
}

interface PendingExpandAllWork {
  pathsToExpand: string[];
  pathsToLoad: string[];
}

type ExpandAllPreparation =
  | {
      kind: 'run';
      pendingWork: PendingExpandAllWork;
      rootDirectoryPaths: string[];
    }
  | {
      kind: 'skip';
      reason: string;
    };

export interface ExpandAllExecutorArgs {
  committedPaths: Set<string>;
  pathsToExpand: readonly string[];
  pathsToLoad: readonly string[];
  rootDirectoryPaths: readonly string[];
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void;
}

export interface ExpandAllExecutorResult {
  discoveredDirectories: number;
  firstError?: Error | undefined;
  metrics?: ExpandAllMetrics | undefined;
  pathsToCommit?: readonly string[] | undefined;
}

function enqueueKnownDirectoryChildren(args: {
  node: IFileNode;
  queue: string[];
  queuedPaths: Set<string>;
}): void {
  const { node, queue, queuedPaths } = args;
  for (const child of node.children ?? []) {
    if (child.type !== 'directory' || queuedPaths.has(child.path)) {
      continue;
    }
    queuedPaths.add(child.path);
    queue.push(child.path);
  }
}

function collectPendingExpandAllWork(args: {
  expandedPaths: ReadonlySet<string>;
  getNodeByPath: (path: string) => IFileNode | undefined;
  rootDirectoryPaths: readonly string[];
}): PendingExpandAllWork {
  const { expandedPaths, getNodeByPath, rootDirectoryPaths } = args;
  const queue = [...new Set(rootDirectoryPaths.filter(Boolean))];
  const queuedPaths = new Set(queue);
  const visitedPaths = new Set<string>();
  const pathsToExpand: string[] = [];
  const pathsToLoad: string[] = [];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const path = queue[queueIndex];
    queueIndex += 1;
    if (!path || visitedPaths.has(path)) {
      continue;
    }
    visitedPaths.add(path);

    const node = getNodeByPath(path);
    if (!(node && node.type === 'directory')) {
      continue;
    }

    if (!expandedPaths.has(path)) {
      pathsToExpand.push(path);
    }

    if (node.loadState !== 'loaded') {
      pathsToLoad.push(path);
      continue;
    }

    enqueueKnownDirectoryChildren({ node, queue, queuedPaths });
  }

  return { pathsToExpand, pathsToLoad };
}

function prepareExpandAllWork(args: {
  expandedPaths: ReadonlySet<string>;
  getNodeByPath: (path: string) => IFileNode | undefined;
  getRootNodes: () => IFileNode[];
}): ExpandAllPreparation {
  const { expandedPaths, getNodeByPath, getRootNodes } = args;
  const rootDirectoryPaths = getRootNodes()
    .filter((node) => node.type === 'directory')
    .map((node) => node.path);
  if (rootDirectoryPaths.length === 0) {
    return { kind: 'skip', reason: 'no directories need expansion' };
  }

  const pendingWork = collectPendingExpandAllWork({
    expandedPaths,
    getNodeByPath,
    rootDirectoryPaths,
  });
  if (pendingWork.pathsToExpand.length === 0 && pendingWork.pathsToLoad.length === 0) {
    return { kind: 'skip', reason: 'no directories need expansion' };
  }

  return { kind: 'run', pendingWork, rootDirectoryPaths };
}

function handleExpandError(err: unknown, onError?: (error: Error) => void): void {
  const isCancelled = isAbortError(err);
  if (!isCancelled) {
    logger.error('expandAllProgressively: error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
  if (!isCancelled && onError) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

function commitExpandedPathsBatch(args: {
  committedPaths: Set<string>;
  paths: readonly string[];
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void;
}): boolean {
  const { committedPaths, paths, setExpandedPaths } = args;
  if (paths.length === 0) {
    return false;
  }

  let hasNewPaths = false;
  const batchPaths: string[] = [];
  for (const path of paths) {
    if (committedPaths.has(path)) {
      continue;
    }
    // The caller-owned set tracks session-level commits so later batches can skip
    // both store updates and transition scheduling for already-committed paths.
    committedPaths.add(path);
    batchPaths.push(path);
    hasNewPaths = true;
  }

  if (!hasNewPaths) {
    return false;
  }

  startTransition(() => {
    setExpandedPaths((previousPaths) => {
      let nextPaths: Set<string> | null = null;
      for (const path of batchPaths) {
        if ((nextPaths ?? previousPaths).has(path)) {
          continue;
        }
        if (!nextPaths) {
          nextPaths = new Set(previousPaths);
        }
        nextPaths.add(path);
      }
      return nextPaths ?? previousPaths;
    });
  });

  return true;
}

function beginExpandAllOperation(args: {
  isExpandAllStartingRef: React.RefObject<boolean>;
  isExpandingAllRef: React.RefObject<boolean>;
  setState: React.Dispatch<React.SetStateAction<ExpandAllState>>;
}): void {
  const { isExpandAllStartingRef, isExpandingAllRef, setState } = args;
  isExpandAllStartingRef.current = true;
  isExpandingAllRef.current = true;
  setState({ isExpandingAll: true });
}

function resetExpandAllOperation(args: {
  isExpandAllStartingRef: React.RefObject<boolean>;
  isExpandingAllRef: React.RefObject<boolean>;
}): void {
  const { isExpandAllStartingRef, isExpandingAllRef } = args;
  isExpandAllStartingRef.current = false;
  isExpandingAllRef.current = false;
}

function finalizeExpandAllOperation(args: {
  isExpandAllStartingRef: React.RefObject<boolean>;
  isExpandingAllRef: React.RefObject<boolean>;
  sessionId: number;
  sessionIdRef: React.RefObject<number>;
  setState: React.Dispatch<React.SetStateAction<ExpandAllState>>;
}): void {
  const { isExpandAllStartingRef, isExpandingAllRef, sessionId, sessionIdRef, setState } = args;
  if (sessionIdRef.current !== sessionId) {
    return;
  }

  resetExpandAllOperation({
    isExpandAllStartingRef,
    isExpandingAllRef,
  });
  setState({ isExpandingAll: false });
}

function createEmptyExpandAllMetrics(): ExpandAllMetrics {
  return {
    batchCount: 0,
    commitDurationMs: 0,
    committedBatchCount: 0,
    discoveryDurationMs: 0,
  };
}

function buildExpandAllBatchConfig(config: {
  maxBatchDurationMs: number | undefined;
  maxConcurrentLoads: number | undefined;
  maxDirectories: number | undefined;
  maxDirectoriesPerBatch: number | undefined;
}): ExpandAllBatchConfig | undefined {
  const nextConfig: ExpandAllBatchConfig = {};
  if (config.maxBatchDurationMs !== undefined) {
    nextConfig.maxBatchDurationMs = config.maxBatchDurationMs;
  }
  if (config.maxConcurrentLoads !== undefined) {
    nextConfig.maxConcurrentLoads = config.maxConcurrentLoads;
  }
  if (config.maxDirectories !== undefined) {
    nextConfig.maxDirectories = config.maxDirectories;
  }
  if (config.maxDirectoriesPerBatch !== undefined) {
    nextConfig.maxDirectoriesPerBatch = config.maxDirectoriesPerBatch;
  }
  return Object.keys(nextConfig).length > 0 ? nextConfig : undefined;
}

function logExpandAllOutcome(args: {
  discoveredDirectories: number;
  metrics: ExpandAllMetrics;
  outcome: 'cancelled' | 'completed';
  rootFolderId: string;
  startedAt: number;
  now: () => number;
}): void {
  const { discoveredDirectories, metrics, outcome, rootFolderId, startedAt, now } = args;
  logger.info(`expandAllProgressively: ${outcome}`, {
    ...metrics,
    discoveredDirectories,
    rootFolderId,
    totalDurationMs: now() - startedAt,
  });
}

async function runExpandAllSession(args: {
  batchConfig: ExpandAllBatchConfig | undefined;
  committedPaths: Set<string>;
  getNodeByPath: (path: string) => IFileNode | undefined;
  initialPaths: readonly string[];
  isExpandingAllRef: React.RefObject<boolean>;
  loadDirectoryPath: (path: string) => Promise<void>;
  now: () => number;
  onBatchLoadsSettled?: (() => void) | undefined;
  onProgress?: ((loaded: number, total: number) => void) | undefined;
  sessionId: number;
  sessionIdRef: React.RefObject<number>;
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void;
  yieldToBrowser: () => Promise<void>;
}): Promise<{
  discoveredDirectories: number;
  firstError: Error | undefined;
  metrics: ExpandAllMetrics;
}> {
  const {
    batchConfig,
    committedPaths,
    getNodeByPath,
    initialPaths,
    isExpandingAllRef,
    loadDirectoryPath,
    now,
    onBatchLoadsSettled,
    onProgress,
    sessionId,
    sessionIdRef,
    setExpandedPaths,
    yieldToBrowser,
  } = args;
  const metrics = createEmptyExpandAllMetrics();

  commitExpandedPathsBatch({
    committedPaths,
    paths: [...initialPaths],
    setExpandedPaths,
  });

  const traversalSession = createDirectDirectoryTraversalSession([...initialPaths], {
    getDirectoryByPath: getNodeByPath,
    isActive: () => isExpandingAllRef.current && sessionIdRef.current === sessionId,
    loadDirectoryPath,
    now,
    onBatchLoadsSettled,
    onProgress,
    ...batchConfig,
  });

  while (isExpandingAllRef.current && sessionIdRef.current === sessionId) {
    const batchStartedAt = now();
    const batch = await traversalSession.processNextBatch();
    metrics.discoveryDurationMs += now() - batchStartedAt;

    if (batch.cancelled) {
      throw new DOMException('Operation aborted', 'AbortError');
    }

    metrics.batchCount += 1;
    const commitStartedAt = now();
    const committedBatch = commitExpandedPathsBatch({
      committedPaths,
      paths: batch.newlyDiscoveredPaths,
      setExpandedPaths,
    });
    metrics.commitDurationMs += now() - commitStartedAt;
    if (committedBatch) {
      metrics.committedBatchCount += 1;
    }

    if (batch.complete) {
      const finalSnapshot = traversalSession.snapshot();
      return {
        discoveredDirectories: finalSnapshot.discoveredPaths.size,
        firstError: finalSnapshot.firstError,
        metrics,
      };
    }

    await yieldToBrowser();
  }

  throw new DOMException('Operation aborted', 'AbortError');
}

async function runPendingUnloadedExpandAll(args: {
  batchConfig: ExpandAllBatchConfig | undefined;
  committedPaths: Set<string>;
  getNodeByPath: (path: string) => IFileNode | undefined;
  initialPaths: readonly string[];
  isExpandingAllRef: React.RefObject<boolean>;
  loadDirectoryPath: (path: string) => Promise<void>;
  now: () => number;
  onBatchLoadsSettled?: (() => void) | undefined;
  onProgress?: ((loaded: number, total: number) => void) | undefined;
  pathsToExpand: readonly string[];
  rootDirectoryPaths: readonly string[];
  /**
   * Optional fast-path executor (worker-backed). Returning null signals the
   * executor is unavailable (e.g. the worker failed to start) and the
   * in-renderer session path runs instead — expand-all must never depend on
   * the worker existing.
   */
  runUnloadedExpandAll?:
    | ((args: ExpandAllExecutorArgs) => Promise<ExpandAllExecutorResult | null>)
    | undefined;
  sessionId: number;
  sessionIdRef: React.RefObject<number>;
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void;
  yieldToBrowser: () => Promise<void>;
}): Promise<ExpandAllExecutorResult> {
  const {
    batchConfig,
    committedPaths,
    getNodeByPath,
    initialPaths,
    isExpandingAllRef,
    loadDirectoryPath,
    now,
    onBatchLoadsSettled,
    onProgress,
    pathsToExpand,
    rootDirectoryPaths,
    runUnloadedExpandAll,
    sessionId,
    sessionIdRef,
    setExpandedPaths,
    yieldToBrowser,
  } = args;

  if (runUnloadedExpandAll) {
    const workerResult = await runUnloadedExpandAll({
      committedPaths,
      pathsToExpand,
      pathsToLoad: initialPaths,
      rootDirectoryPaths,
      setExpandedPaths,
    });
    if (workerResult !== null) {
      return workerResult;
    }
    // Worker unavailable — fall through to the in-renderer session.
  }

  return runExpandAllSession({
    batchConfig,
    committedPaths,
    getNodeByPath,
    initialPaths,
    isExpandingAllRef,
    loadDirectoryPath,
    now,
    onBatchLoadsSettled,
    onProgress,
    sessionId,
    sessionIdRef,
    setExpandedPaths,
    yieldToBrowser,
  });
}

function commitExecutorResultPaths(args: {
  committedPaths: Set<string>;
  metrics: ExpandAllMetrics;
  now: () => number;
  pathsToCommit: readonly string[] | undefined;
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void;
}): void {
  const { committedPaths, metrics, now, pathsToCommit, setExpandedPaths } = args;
  if (!(pathsToCommit && pathsToCommit.length > 0)) {
    return;
  }

  const commitStartedAt = now();
  const committedBatch = commitExpandedPathsBatch({
    committedPaths,
    paths: pathsToCommit,
    setExpandedPaths,
  });
  metrics.commitDurationMs += now() - commitStartedAt;
  if (committedBatch) {
    metrics.committedBatchCount += 1;
  }
}

export interface ExpandAllState {
  isExpandingAll: boolean;
}

export interface UseExpandAllOptions {
  batchConfig?: ExpandAllBatchConfig;
  cancelLoadOperations: () => void;
  getNodeByPath: (path: string) => IFileNode | undefined;
  getRootNodes: () => IFileNode[];
  loadDirectoryPath: (path: string) => Promise<void>;
  now?: () => number;
  /**
   * Renderer-session batch boundary: invoked after each traversal batch's
   * loads settle, before discovery reads nodes. Lets the tree owner defer
   * per-directory commits and publish once per batch.
   */
  onBatchLoadsSettled?: () => void;
  onError?: (error: Error) => void;
  onProgress?: (loaded: number, total: number) => void;
  rootFolderId: string;
  /** Optional worker fast path; null result falls back to the renderer session. */
  runUnloadedExpandAll?: (args: ExpandAllExecutorArgs) => Promise<ExpandAllExecutorResult | null>;
  yieldToBrowser?: () => Promise<void>;
}

export interface UseExpandAllReturn {
  cancelExpandAll: () => void;
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
    currentExpandedPaths?: ReadonlySet<string>
  ) => Promise<void>;
  isExpandingAll: boolean;
  isExpandingAllRef: React.RefObject<boolean>;
}

export function useExpandAll(options: UseExpandAllOptions): UseExpandAllReturn {
  const {
    batchConfig,
    cancelLoadOperations,
    getNodeByPath,
    getRootNodes,
    loadDirectoryPath,
    now = defaultNow,
    onBatchLoadsSettled,
    onError,
    onProgress,
    rootFolderId,
    runUnloadedExpandAll,
    yieldToBrowser = defaultYieldToBrowser,
  } = options;

  const [state, setState] = useState<ExpandAllState>({
    isExpandingAll: false,
  });

  const maxBatchDurationMs = batchConfig?.maxBatchDurationMs;
  const maxConcurrentLoads = batchConfig?.maxConcurrentLoads;
  const maxDirectories = batchConfig?.maxDirectories;
  const maxDirectoriesPerBatch = batchConfig?.maxDirectoriesPerBatch;

  const isExpandAllStartingRef = useRef(false);
  const isExpandingAllRef = useRef(false);
  const sessionIdRef = useRef(0);

  const cancelExpandAll = useCallback(() => {
    sessionIdRef.current += 1;
    cancelLoadOperations();
    resetExpandAllOperation({
      isExpandAllStartingRef,
      isExpandingAllRef,
    });
    setState({ isExpandingAll: false });
  }, [cancelLoadOperations]);

  const expandAllProgressively = useCallback(
    async (
      setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
      currentExpandedPaths: ReadonlySet<string> = new Set()
    ): Promise<void> => {
      const skipCheck = shouldSkipExpandAll(isExpandAllStartingRef.current);
      if (skipCheck.skip) {
        if (skipCheck.reason) {
          logger.debug(`expandAllProgressively: ${skipCheck.reason}`);
        }
        return;
      }

      const preparedWork = prepareExpandAllWork({
        expandedPaths: currentExpandedPaths,
        getNodeByPath,
        getRootNodes,
      });
      if (preparedWork.kind === 'skip') {
        logger.debug(`expandAllProgressively: ${preparedWork.reason}`);
        return;
      }

      const { pendingWork, rootDirectoryPaths } = preparedWork;
      const committedPaths = new Set(currentExpandedPaths);
      if (pendingWork.pathsToLoad.length === 0) {
        commitExpandedPathsBatch({
          committedPaths,
          paths: pendingWork.pathsToExpand,
          setExpandedPaths,
        });
        logger.debug(
          'expandAllProgressively: expanded known loaded directories without traversal',
          {
            expandedPathCount: pendingWork.pathsToExpand.length,
          }
        );
        return;
      }

      commitExpandedPathsBatch({
        committedPaths,
        paths: pendingWork.pathsToExpand,
        setExpandedPaths,
      });

      beginExpandAllOperation({
        isExpandAllStartingRef,
        isExpandingAllRef,
        setState,
      });
      const startedAt = now();
      const sessionId = sessionIdRef.current + 1;
      sessionIdRef.current = sessionId;

      try {
        const result = await runPendingUnloadedExpandAll({
          batchConfig: buildExpandAllBatchConfig({
            maxBatchDurationMs,
            maxConcurrentLoads,
            maxDirectories,
            maxDirectoriesPerBatch,
          }),
          committedPaths,
          getNodeByPath,
          initialPaths: pendingWork.pathsToLoad,
          isExpandingAllRef,
          loadDirectoryPath,
          now,
          onBatchLoadsSettled,
          onProgress,
          pathsToExpand: pendingWork.pathsToExpand,
          rootDirectoryPaths,
          runUnloadedExpandAll,
          sessionId,
          sessionIdRef,
          setExpandedPaths,
          yieldToBrowser,
        });
        const metrics = result.metrics ?? createEmptyExpandAllMetrics();
        commitExecutorResultPaths({
          committedPaths,
          metrics,
          now,
          pathsToCommit: result.pathsToCommit,
          setExpandedPaths,
        });
        logExpandAllOutcome({
          discoveredDirectories: result.discoveredDirectories,
          metrics,
          now,
          outcome: 'completed',
          rootFolderId,
          startedAt,
        });
        if (result.firstError) {
          handleExpandError(result.firstError, onError);
        }
      } catch (err) {
        if (isAbortError(err)) {
          logExpandAllOutcome({
            discoveredDirectories: committedPaths.size,
            metrics: createEmptyExpandAllMetrics(),
            now,
            outcome: 'cancelled',
            rootFolderId,
            startedAt,
          });
        }
        handleExpandError(err, onError);
      } finally {
        finalizeExpandAllOperation({
          isExpandAllStartingRef,
          isExpandingAllRef,
          sessionId,
          sessionIdRef,
          setState,
        });
      }
    },
    [
      getNodeByPath,
      getRootNodes,
      loadDirectoryPath,
      maxBatchDurationMs,
      maxConcurrentLoads,
      maxDirectories,
      maxDirectoriesPerBatch,
      now,
      onBatchLoadsSettled,
      onError,
      onProgress,
      rootFolderId,
      runUnloadedExpandAll,
      yieldToBrowser,
    ]
  );

  return {
    cancelExpandAll,
    expandAllProgressively,
    isExpandingAll: state.isExpandingAll,
    isExpandingAllRef,
  };
}
