import type { IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { createLogger } from '@brainstrike/utils/logger';

export interface DirectDirectoryTraversalOptions {
  getDirectoryByPath: (path: string) => IFileNode | undefined;
  isActive: () => boolean;
  loadDirectoryPath: (path: string) => Promise<void>;
  maxBatchDurationMs?: number;
  maxConcurrentLoads?: number;
  maxDirectories?: number;
  maxDirectoriesPerBatch?: number;
  now?: () => number;
  onProgress?: ((loaded: number, total: number) => void) | undefined;
}

export interface DirectDirectoryTraversalResult {
  cancelled: boolean;
  discoveredPaths: Set<string>;
  failedLoads: number;
  firstError: Error | undefined;
  loaded: number;
  total: number;
  visitedPaths: string[];
}

export interface DirectDirectoryTraversalBatchResult {
  cancelled: boolean;
  complete: boolean;
  failedLoads: number;
  firstError: Error | undefined;
  loaded: number;
  newlyDiscoveredPaths: string[];
  total: number;
  visitedPaths: string[];
}

export interface DirectDirectoryTraversalSession {
  processNextBatch: () => Promise<DirectDirectoryTraversalBatchResult>;
  snapshot: () => DirectDirectoryTraversalResult;
}

const DEFAULT_MAX_BATCH_DURATION_MS = 8;
const DEFAULT_MAX_CONCURRENT_LOADS = 8;
const DEFAULT_MAX_DIRECTORIES = 100_000;
const DEFAULT_MAX_DIRECTORIES_PER_BATCH = 50;
const logger = createLogger('DirectDirectoryTraversal');

interface DirectDirectoryTraversalSessionState {
  discoveredPaths: Set<string>;
  failedLoads: number;
  firstError: Error | undefined;
  loaded: number;
  queue: string[];
  queueIndex: number;
  total: number;
  visitedPaths: string[];
}

function assertDirectoryTraversalWithinLimit(
  discoveredCount: number,
  maxDirectories: number
): void {
  if (discoveredCount > maxDirectories) {
    throw new Error(`Directory traversal limit exceeded (${maxDirectories})`);
  }
}

function enqueueChildDirectories(args: {
  discoveredPaths: Set<string>;
  maxDirectories: number;
  newlyDiscoveredPaths: string[];
  node: IFileNode;
  queue: string[];
}): number {
  const { discoveredPaths, maxDirectories, newlyDiscoveredPaths, node, queue } = args;
  let added = 0;
  for (const child of node.children ?? []) {
    if (child.type !== 'directory' || discoveredPaths.has(child.path)) {
      continue;
    }
    discoveredPaths.add(child.path);
    newlyDiscoveredPaths.push(child.path);
    assertDirectoryTraversalWithinLimit(discoveredPaths.size, maxDirectories);
    queue.push(child.path);
    added += 1;
  }
  return added;
}

function isReadyDirectoryNode(node: IFileNode | undefined): node is IFileNode {
  return Boolean(node && node.type === 'directory' && node.loadState === 'loaded');
}

function buildInitialQueue(initialPaths: string[]): string[] {
  return Array.from(new Set(initialPaths.filter(Boolean)));
}

function takeBatchPaths(args: {
  maxBatchDurationMs: number;
  maxDirectoriesPerBatch: number;
  now: () => number;
  state: DirectDirectoryTraversalSessionState;
}): string[] {
  const { maxBatchDurationMs, maxDirectoriesPerBatch, now, state } = args;
  const batchPaths: string[] = [];
  const batchStartedAt = now();

  while (state.queueIndex < state.queue.length && batchPaths.length < maxDirectoriesPerBatch) {
    // This budget only bounds synchronous queue claiming so a large frontier cannot
    // monopolize the renderer before we yield. Async directory loads are bounded
    // separately by maxConcurrentLoads and settle after the batch is assembled.
    if (batchPaths.length > 0 && now() - batchStartedAt >= maxBatchDurationMs) {
      break;
    }

    const currentPath = state.queue[state.queueIndex++];
    if (!currentPath) {
      continue;
    }

    state.visitedPaths.push(currentPath);
    batchPaths.push(currentPath);
  }

  return batchPaths;
}

async function runWithConcurrency<T>(args: {
  items: T[];
  limit: number;
  run: (item: T) => Promise<void>;
}): Promise<void> {
  const { items, limit, run } = args;
  if (items.length === 0) {
    return;
  }

  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        // Claim the next work item synchronously before awaiting so each worker
        // gets a unique index without needing additional coordination primitives.
        // `run` is expected to handle per-item failures internally. If it throws,
        // Promise.all will reject the batch and abandon the remaining workers.
        const item = items[nextIndex];
        nextIndex += 1;
        if (item === undefined) {
          continue;
        }
        await run(item);
      }
    })
  );
}

async function loadBatchDirectories(args: {
  batchPaths: string[];
  getDirectoryByPath: (path: string) => IFileNode | undefined;
  isActive: () => boolean;
  loadDirectoryPath: (path: string) => Promise<void>;
  maxConcurrentLoads: number;
}): Promise<{ failedLoads: number; firstError: Error | undefined }> {
  const { batchPaths, getDirectoryByPath, isActive, loadDirectoryPath, maxConcurrentLoads } = args;
  const pendingLoads: string[] = [];
  let failedLoads = 0;
  let firstError: Error | undefined;

  for (const path of batchPaths) {
    const node = getDirectoryByPath(path);
    if (node && node.type === 'directory' && node.loadState !== 'loaded') {
      pendingLoads.push(path);
    }
  }

  await runWithConcurrency({
    items: pendingLoads,
    limit: maxConcurrentLoads,
    run: async (path) => {
      if (!isActive()) {
        return;
      }
      try {
        await loadDirectoryPath(path);
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        failedLoads += 1;
        firstError ??= error instanceof Error ? error : new Error(String(error));
        logger.warn('Skipping failed directory during batched traversal', {
          error: error instanceof Error ? error.message : String(error),
          path,
        });
      }
    },
  });

  return { failedLoads, firstError };
}

function createSnapshot(
  state: DirectDirectoryTraversalSessionState,
  cancelled: boolean
): DirectDirectoryTraversalResult {
  return {
    cancelled,
    discoveredPaths: new Set(state.discoveredPaths),
    failedLoads: state.failedLoads,
    firstError: state.firstError,
    loaded: state.loaded,
    total: state.total,
    visitedPaths: [...state.visitedPaths],
  };
}

export function createDirectDirectoryTraversalSession(
  initialPaths: string[],
  options: DirectDirectoryTraversalOptions
): DirectDirectoryTraversalSession {
  const {
    getDirectoryByPath,
    isActive,
    loadDirectoryPath,
    maxBatchDurationMs = DEFAULT_MAX_BATCH_DURATION_MS,
    maxConcurrentLoads = DEFAULT_MAX_CONCURRENT_LOADS,
    maxDirectories = DEFAULT_MAX_DIRECTORIES,
    maxDirectoriesPerBatch = DEFAULT_MAX_DIRECTORIES_PER_BATCH,
    now = () => performance.now(),
    onProgress,
  } = options;

  const queue = buildInitialQueue(initialPaths);
  const state: DirectDirectoryTraversalSessionState = {
    discoveredPaths: new Set(queue),
    failedLoads: 0,
    firstError: undefined,
    loaded: 0,
    queue,
    queueIndex: 0,
    total: queue.length,
    visitedPaths: [],
  };

  assertDirectoryTraversalWithinLimit(state.discoveredPaths.size, maxDirectories);
  onProgress?.(state.loaded, state.total);

  return {
    processNextBatch: async (): Promise<DirectDirectoryTraversalBatchResult> => {
      if (!isActive()) {
        const snapshot = createSnapshot(state, true);
        return {
          cancelled: true,
          complete: false,
          failedLoads: snapshot.failedLoads,
          firstError: snapshot.firstError,
          loaded: snapshot.loaded,
          newlyDiscoveredPaths: [],
          total: snapshot.total,
          visitedPaths: [],
        };
      }

      if (state.queueIndex >= state.queue.length) {
        return {
          cancelled: false,
          complete: true,
          failedLoads: state.failedLoads,
          firstError: state.firstError,
          loaded: state.loaded,
          newlyDiscoveredPaths: [],
          total: state.total,
          visitedPaths: [],
        };
      }

      const batchPaths = takeBatchPaths({
        maxBatchDurationMs,
        maxDirectoriesPerBatch,
        now,
        state,
      });

      const visitedPaths = [...batchPaths];

      const loadResult = await loadBatchDirectories({
        batchPaths,
        getDirectoryByPath,
        isActive,
        loadDirectoryPath,
        maxConcurrentLoads,
      });
      state.failedLoads += loadResult.failedLoads;
      state.firstError ??= loadResult.firstError;

      if (!isActive()) {
        return {
          cancelled: true,
          complete: false,
          failedLoads: state.failedLoads,
          firstError: state.firstError,
          loaded: state.loaded,
          newlyDiscoveredPaths: [],
          total: state.total,
          visitedPaths,
        };
      }

      const newlyDiscoveredPaths: string[] = [];

      for (const currentPath of batchPaths) {
        if (!isActive()) {
          return {
            cancelled: true,
            complete: false,
            failedLoads: state.failedLoads,
            firstError: state.firstError,
            loaded: state.loaded,
            newlyDiscoveredPaths,
            total: state.total,
            visitedPaths,
          };
        }

        const currentNode = getDirectoryByPath(currentPath);
        if (!(currentNode && currentNode.type === 'directory')) {
          state.loaded += 1;
          onProgress?.(state.loaded, state.total);
          continue;
        }

        if (isReadyDirectoryNode(currentNode)) {
          state.total += enqueueChildDirectories({
            discoveredPaths: state.discoveredPaths,
            maxDirectories,
            newlyDiscoveredPaths,
            node: currentNode,
            queue: state.queue,
          });
        }

        state.loaded += 1;
        onProgress?.(state.loaded, state.total);
      }

      return {
        cancelled: false,
        complete: state.queueIndex >= state.queue.length,
        failedLoads: state.failedLoads,
        firstError: state.firstError,
        loaded: state.loaded,
        newlyDiscoveredPaths,
        total: state.total,
        visitedPaths,
      };
    },
    snapshot: (): DirectDirectoryTraversalResult => createSnapshot(state, false),
  };
}

export async function traverseDirectoriesDirect(
  initialPaths: string[],
  options: DirectDirectoryTraversalOptions
): Promise<DirectDirectoryTraversalResult> {
  const session = createDirectDirectoryTraversalSession(initialPaths, options);

  while (true) {
    const batch = await session.processNextBatch();
    if (batch.cancelled || batch.complete) {
      return {
        ...session.snapshot(),
        cancelled: batch.cancelled,
      };
    }
  }
}
