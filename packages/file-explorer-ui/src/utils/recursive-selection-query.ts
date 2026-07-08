import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { checkBudget, createTimer } from '@brainstrike/utils';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { createPathFilterMatcher } from '@brainstrike/utils/filter-utils';
import { createLogger } from '@brainstrike/utils/logger';

import { loadDirectoryChildren } from './lazy-tree-loader';

const logger = createLogger('RecursiveSelectionQuery');

const DEFAULT_SCAN_CONCURRENCY = 6;
const LOW_LIMIT_SCAN_THRESHOLD = 256;
// Keep a modest ceiling above the default to preserve throughput without
// letting caller-supplied concurrency create a large buffered frontier.
const MAX_SCAN_CONCURRENCY = 12;
const MAX_DIRECTORY_TRAVERSAL_COUNT = 100_000;
const PROGRESS_DIRECTORY_INTERVAL = 8;

type PathFilterMatcher = ReturnType<typeof createPathFilterMatcher>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Operation was cancelled', 'AbortError');
  }
}

function isDirectoryLoaded(node: IFileNode): node is IFileNode & { children: IFileNode[] } {
  return node.type === 'directory' && node.loadState === 'loaded' && Array.isArray(node.children);
}

export interface RecursiveSelectionQueryProgress {
  currentPath: string | null;
  directoriesCompleted: number;
  directoriesDiscovered: number;
  directoriesReadFromAdapter: number;
  filesMatched: number;
  filesVisited: number;
}

export interface RecursiveSelectionQueryMetrics extends RecursiveSelectionQueryProgress {
  durationMs: number;
  limitReached: boolean;
  mode: 'early-stop' | 'throughput';
}

export interface RecursiveSelectionQueryOptions {
  abortSignal?: AbortSignal;
  concurrency?: number;
  excludeFilters: string[];
  fileSystemAdapter: FileSystemAdapter;
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];
  includeFilters: string[];
  maxDirectories?: number;
  maxResults?: number;
  onProgress?: (progress: RecursiveSelectionQueryProgress) => void;
  roots: IFileNode[];
  useRegex: boolean;
}

export interface RecursiveSelectionQueryResult {
  fileNodes: IFileNode[];
  filePaths: string[];
  limitReached: boolean;
  metrics: RecursiveSelectionQueryMetrics;
}

interface MutableQueryState {
  currentPath: string | null;
  directoriesCompleted: number;
  directoriesDiscovered: number;
  directoriesReadFromAdapter: number;
  fileNodes: IFileNode[];
  filesMatched: number;
  filesVisited: number;
  limitReached: boolean;
}

interface DirectoryTraversalState {
  maxDirectories: number;
  queuedDirectoryPaths: Set<string>;
  scannedDirectoryPaths: Set<string>;
}

interface ScanResult {
  children: IFileNode[];
  error: unknown | null;
  node: IFileNode;
}

interface AsyncScanQueue {
  close: () => void;
  push: (result: ScanResult) => void;
  takeNext: () => Promise<ScanResult | undefined>;
}

function snapshotProgress(state: MutableQueryState): RecursiveSelectionQueryProgress {
  return {
    currentPath: state.currentPath,
    directoriesCompleted: state.directoriesCompleted,
    directoriesDiscovered: state.directoriesDiscovered,
    directoriesReadFromAdapter: state.directoriesReadFromAdapter,
    filesMatched: state.filesMatched,
    filesVisited: state.filesVisited,
  };
}

function createProgressReporter(
  onProgress: ((progress: RecursiveSelectionQueryProgress) => void) | undefined,
  state: MutableQueryState
): { emit: (force?: boolean) => void } {
  let lastReportedCompleted = 0;
  let lastReportedMatched = 0;

  return {
    emit(force = false) {
      if (!onProgress) {
        return;
      }

      const shouldEmit =
        force ||
        state.limitReached ||
        state.directoriesCompleted === 0 ||
        state.directoriesCompleted - lastReportedCompleted >= PROGRESS_DIRECTORY_INTERVAL ||
        state.filesMatched !== lastReportedMatched;

      if (!shouldEmit) {
        return;
      }

      lastReportedCompleted = state.directoriesCompleted;
      lastReportedMatched = state.filesMatched;
      onProgress(snapshotProgress(state));
    },
  };
}

function applyOptionalFilter(
  nodes: IFileNode[],
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[]
): IFileNode[] {
  return filterTreeFn ? filterTreeFn(nodes) : nodes;
}

function recordMatchedFile(args: {
  hasKnownRemainingWork: boolean;
  maxResults: number;
  node: IFileNode;
  state: MutableQueryState;
}): boolean {
  const { hasKnownRemainingWork, maxResults, node, state } = args;
  state.filesMatched++;
  const hadCapacity = state.fileNodes.length < maxResults;
  if (hadCapacity) {
    state.fileNodes.push(node);
  }
  if (state.fileNodes.length < maxResults) {
    return false;
  }

  if (hadCapacity && !hasKnownRemainingWork) {
    return false;
  }

  state.limitReached = Number.isFinite(maxResults);
  return true;
}

function consumeNodes(args: {
  directoryTraversalState: DirectoryTraversalState;
  matcher: ReturnType<typeof createPathFilterMatcher>;
  maxResults: number;
  nextFrontier: IFileNode[];
  nodes: IFileNode[];
  state: MutableQueryState;
}): boolean {
  const { directoryTraversalState, matcher, maxResults, nextFrontier, nodes, state } = args;

  for (const [index, node] of nodes.entries()) {
    if (node.isVisible === false) {
      continue;
    }

    state.currentPath = node.path;

    if (node.type === 'file') {
      state.filesVisited++;
      const hasKnownRemainingWork =
        index < nodes.length - 1 ||
        nextFrontier.length > 0 ||
        directoryTraversalState.queuedDirectoryPaths.size >
          directoryTraversalState.scannedDirectoryPaths.size;
      // Exact-cap fills should only report limitReached when traversal still has more work.
      // Otherwise the final accepted file would look like a capped result even though the
      // query completed naturally on the last available match.
      if (
        matcher.shouldIncludeFile(node.path) &&
        recordMatchedFile({
          hasKnownRemainingWork,
          maxResults,
          node,
          state,
        })
      ) {
        return true;
      }
      continue;
    }

    if (!matcher.shouldTraverseDirectory(node.path)) {
      continue;
    }

    if (!directoryTraversalState.queuedDirectoryPaths.has(node.path)) {
      directoryTraversalState.queuedDirectoryPaths.add(node.path);
      if (
        directoryTraversalState.queuedDirectoryPaths.size > directoryTraversalState.maxDirectories
      ) {
        throw new Error(
          `Recursive selection traversal limit exceeded (${directoryTraversalState.maxDirectories})`
        );
      }
      nextFrontier.push(node);
      state.directoriesDiscovered++;
    }
  }

  return false;
}

async function readDirectoryChildrenWithBudget(
  adapter: FileSystemAdapter,
  node: IFileNode,
  abortSignal?: AbortSignal
): Promise<IFileNode[]> {
  const timer = createTimer();
  const children = await loadDirectoryChildren(adapter, node, {
    ...(abortSignal ? { abortSignal } : {}),
    includeMetadata: false,
  });
  checkBudget(`recursive-selection:${node.path}`, timer.elapsed(), 'listDirectory');
  return children;
}

async function scanDirectory(
  adapter: FileSystemAdapter,
  node: IFileNode,
  filterTreeFn: ((tree: IFileNode[]) => IFileNode[]) | undefined,
  abortSignal?: AbortSignal
): Promise<IFileNode[]> {
  const children = await readDirectoryChildrenWithBudget(adapter, node, abortSignal);
  return applyOptionalFilter(children, filterTreeFn);
}

function buildEmptyResult(
  timer: ReturnType<typeof createTimer>,
  limit: number,
  maxResults: number | undefined
): RecursiveSelectionQueryResult {
  const limitReached = limit === 0 && maxResults !== undefined;
  const mode: RecursiveSelectionQueryMetrics['mode'] =
    limit <= LOW_LIMIT_SCAN_THRESHOLD ? 'early-stop' : 'throughput';

  return {
    fileNodes: [],
    filePaths: [],
    limitReached,
    metrics: {
      currentPath: null,
      directoriesCompleted: 0,
      directoriesDiscovered: 0,
      directoriesReadFromAdapter: 0,
      durationMs: timer.elapsed(),
      filesMatched: 0,
      filesVisited: 0,
      limitReached,
      mode,
    },
  };
}

function initializeQueryState(
  initialRoots: IFileNode[],
  matcher: PathFilterMatcher
): MutableQueryState {
  return {
    currentPath: null,
    directoriesCompleted: 0,
    directoriesDiscovered: initialRoots.filter(
      (node) =>
        node.type === 'directory' &&
        node.isVisible !== false &&
        matcher.shouldTraverseDirectory(node.path)
    ).length,
    directoriesReadFromAdapter: 0,
    fileNodes: [],
    filesMatched: 0,
    filesVisited: 0,
    limitReached: false,
  };
}

function processFrontierNode(args: {
  abortSignal: AbortSignal | undefined;
  directoryTraversalState: DirectoryTraversalState;
  filterTreeFn: ((tree: IFileNode[]) => IFileNode[]) | undefined;
  hasKnownRemainingWork: boolean;
  limit: number;
  matcher: PathFilterMatcher;
  nextFrontier: IFileNode[];
  node: IFileNode;
  state: MutableQueryState;
  unloadedDirectories: IFileNode[];
}): void {
  const {
    abortSignal,
    directoryTraversalState,
    filterTreeFn,
    hasKnownRemainingWork,
    limit,
    matcher,
    nextFrontier,
    node,
    state,
    unloadedDirectories,
  } = args;

  throwIfAborted(abortSignal);
  if (node.isVisible === false) {
    return;
  }

  state.currentPath = node.path;

  if (node.type === 'file') {
    state.filesVisited++;
    if (
      matcher.shouldIncludeFile(node.path) &&
      recordMatchedFile({
        hasKnownRemainingWork,
        maxResults: limit,
        node,
        state,
      })
    ) {
      return;
    }
    return;
  }

  if (!matcher.shouldTraverseDirectory(node.path)) {
    return;
  }

  if (isDirectoryLoaded(node)) {
    state.directoriesCompleted++;
    consumeNodes({
      directoryTraversalState,
      matcher,
      maxResults: limit,
      nextFrontier,
      nodes: applyOptionalFilter(node.children, filterTreeFn),
      state,
    });
    return;
  }

  unloadedDirectories.push(node);
}

async function scanUnloadedDirectories(args: {
  abortSignal: AbortSignal | undefined;
  directoryTraversalState: DirectoryTraversalState;
  effectiveConcurrency: number;
  fileSystemAdapter: FileSystemAdapter;
  filterTreeFn: ((tree: IFileNode[]) => IFileNode[]) | undefined;
  limit: number;
  matcher: PathFilterMatcher;
  mode: RecursiveSelectionQueryMetrics['mode'];
  nextFrontier: IFileNode[];
  onProgress: ((progress: RecursiveSelectionQueryProgress) => void) | undefined;
  state: MutableQueryState;
  unloadedDirectories: IFileNode[];
}): Promise<void> {
  const {
    abortSignal,
    directoryTraversalState,
    effectiveConcurrency,
    fileSystemAdapter,
    filterTreeFn,
    limit,
    matcher,
    mode,
    nextFrontier,
    onProgress,
    state,
    unloadedDirectories,
  } = args;

  const progressReporter = createProgressReporter(onProgress, state);

  if (unloadedDirectories.length === 0) {
    return;
  }

  if (mode === 'early-stop') {
    for (const node of unloadedDirectories) {
      throwIfAborted(abortSignal);
      if (directoryTraversalState.scannedDirectoryPaths.has(node.path)) {
        continue;
      }
      directoryTraversalState.scannedDirectoryPaths.add(node.path);
      state.currentPath = node.path;
      const children = await scanDirectory(fileSystemAdapter, node, filterTreeFn, abortSignal);
      state.directoriesReadFromAdapter++;
      state.directoriesCompleted++;
      const stopped = consumeNodes({
        directoryTraversalState,
        matcher,
        maxResults: limit,
        nextFrontier,
        nodes: children,
        state,
      });
      progressReporter.emit();
      if (stopped) {
        return;
      }
    }
    return;
  }

  await scanUnloadedDirectoriesInThroughputMode({
    abortSignal,
    directoryTraversalState,
    effectiveConcurrency,
    fileSystemAdapter,
    filterTreeFn,
    limit,
    matcher,
    nextFrontier,
    onProgress,
    state,
    unloadedDirectories,
  });
}

async function scanUnloadedDirectoriesInThroughputMode(args: {
  abortSignal: AbortSignal | undefined;
  directoryTraversalState: DirectoryTraversalState;
  effectiveConcurrency: number;
  fileSystemAdapter: FileSystemAdapter;
  filterTreeFn: ((tree: IFileNode[]) => IFileNode[]) | undefined;
  limit: number;
  matcher: PathFilterMatcher;
  nextFrontier: IFileNode[];
  onProgress: ((progress: RecursiveSelectionQueryProgress) => void) | undefined;
  state: MutableQueryState;
  unloadedDirectories: IFileNode[];
}): Promise<void> {
  const {
    abortSignal,
    directoryTraversalState,
    effectiveConcurrency,
    fileSystemAdapter,
    filterTreeFn,
    limit,
    matcher,
    nextFrontier,
    onProgress,
    state,
    unloadedDirectories,
  } = args;

  const progressReporter = createProgressReporter(onProgress, state);
  const scanAbortController = new AbortController();
  const forwardAbort = () => scanAbortController.abort();
  if (abortSignal) {
    if (abortSignal.aborted) {
      scanAbortController.abort();
    } else {
      abortSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  try {
    await drainThroughputScanQueue({
      directoryTraversalState,
      effectiveConcurrency,
      fileSystemAdapter,
      filterTreeFn,
      limit,
      matcher,
      nextFrontier,
      progressReporter,
      scanAbortController,
      state,
      unloadedDirectories,
    });
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', forwardAbort);
    }
  }
}

async function drainThroughputScanQueue(args: {
  directoryTraversalState: DirectoryTraversalState;
  effectiveConcurrency: number;
  fileSystemAdapter: FileSystemAdapter;
  filterTreeFn: ((tree: IFileNode[]) => IFileNode[]) | undefined;
  limit: number;
  matcher: PathFilterMatcher;
  nextFrontier: IFileNode[];
  progressReporter: { emit: (force?: boolean) => void };
  scanAbortController: AbortController;
  state: MutableQueryState;
  unloadedDirectories: IFileNode[];
}): Promise<void> {
  const {
    directoryTraversalState,
    effectiveConcurrency,
    fileSystemAdapter,
    filterTreeFn,
    limit,
    matcher,
    nextFrontier,
    progressReporter,
    scanAbortController,
    state,
    unloadedDirectories,
  } = args;

  let nextDirectoryIndex = 0;
  while (
    !(state.limitReached || scanAbortController.signal.aborted) &&
    nextDirectoryIndex < unloadedDirectories.length
  ) {
    const batchResults = createScanBatch({
      effectiveConcurrency,
      fileSystemAdapter,
      filterTreeFn,
      nextDirectoryIndex,
      scanAbortController,
      unloadedDirectories,
    });
    nextDirectoryIndex = batchResults.nextDirectoryIndex;

    while (true) {
      const result = await batchResults.takeNext();
      if (!result) {
        break;
      }
      const stopped = processThroughputScanResult({
        directoryTraversalState,
        limit,
        matcher,
        nextFrontier,
        progressReporter,
        result,
        scanAbortController,
        state,
      });
      if (stopped) {
        return;
      }
    }
  }
}

function processThroughputScanResult(args: {
  directoryTraversalState: DirectoryTraversalState;
  limit: number;
  matcher: PathFilterMatcher;
  nextFrontier: IFileNode[];
  progressReporter: { emit: (force?: boolean) => void };
  result: ScanResult;
  scanAbortController: AbortController;
  state: MutableQueryState;
}): boolean {
  const {
    directoryTraversalState,
    limit,
    matcher,
    nextFrontier,
    progressReporter,
    result,
    scanAbortController,
    state,
  } = args;

  if (result.error) {
    if (scanAbortController.signal.aborted && isAbortError(result.error)) {
      return true;
    }
    throw result.error;
  }

  if (directoryTraversalState.scannedDirectoryPaths.has(result.node.path)) {
    return false;
  }
  directoryTraversalState.scannedDirectoryPaths.add(result.node.path);
  state.currentPath = result.node.path;
  state.directoriesReadFromAdapter++;
  state.directoriesCompleted++;
  const stopped = consumeNodes({
    directoryTraversalState,
    matcher,
    maxResults: limit,
    nextFrontier,
    nodes: result.children,
    state,
  });
  progressReporter.emit();
  if (!stopped) {
    return false;
  }

  state.limitReached = true;
  scanAbortController.abort();
  return true;
}

function createScanBatch(args: {
  effectiveConcurrency: number;
  fileSystemAdapter: FileSystemAdapter;
  filterTreeFn: ((tree: IFileNode[]) => IFileNode[]) | undefined;
  nextDirectoryIndex: number;
  scanAbortController: AbortController;
  unloadedDirectories: IFileNode[];
}): {
  nextDirectoryIndex: number;
  takeNext: () => Promise<ScanResult | undefined>;
} {
  const {
    effectiveConcurrency,
    fileSystemAdapter,
    filterTreeFn,
    nextDirectoryIndex,
    scanAbortController,
    unloadedDirectories,
  } = args;
  const settledResults: ScanResult[] = [];
  let activeTaskCount = 0;
  let currentIndex = nextDirectoryIndex;
  const resultQueue = createAsyncScanQueue(settledResults);
  let finishedSpawning = false;

  while (
    !scanAbortController.signal.aborted &&
    currentIndex < unloadedDirectories.length &&
    activeTaskCount < effectiveConcurrency
  ) {
    const node = unloadedDirectories[currentIndex];
    currentIndex += 1;
    if (!node) {
      continue;
    }

    activeTaskCount += 1;
    const task = scanDirectory(fileSystemAdapter, node, filterTreeFn, scanAbortController.signal)
      .then((children) => {
        resultQueue.push({
          children,
          error: null,
          node,
        });
      })
      .catch((error: unknown) => {
        resultQueue.push({
          children: [],
          error,
          node,
        });
      });

    void task.finally(() => {
      activeTaskCount -= 1;
      if (finishedSpawning && activeTaskCount === 0) {
        resultQueue.close();
      }
    });
  }

  finishedSpawning = true;
  // Tasks may have already drained before this flag flips because their
  // `.finally()` handlers run in later microtasks. The synchronous fallback
  // close here keeps the queue correct in that case without relying on a
  // specific task completion timing.
  if (activeTaskCount === 0) {
    resultQueue.close();
  }

  return {
    nextDirectoryIndex: currentIndex,
    takeNext: resultQueue.takeNext,
  };
}

function createAsyncScanQueue(settledResults: ScanResult[]): AsyncScanQueue {
  const waiters: Array<(result: ScanResult | undefined) => void> = [];
  let closed = false;

  const flushClosedWaiters = (): void => {
    if (!(closed && waiters.length > 0)) {
      return;
    }
    for (const waiter of waiters.splice(0)) {
      waiter(undefined);
    }
  };

  return {
    close: () => {
      closed = true;
      flushClosedWaiters();
    },
    push: (result) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(result);
        return;
      }
      settledResults.push(result);
    },
    takeNext: async (): Promise<ScanResult | undefined> => {
      if (settledResults.length > 0) {
        return settledResults.shift();
      }
      if (closed) {
        return;
      }
      return new Promise<ScanResult | undefined>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

function buildQueryResult(args: {
  durationMs: number;
  exceededBudget: boolean;
  mode: RecursiveSelectionQueryMetrics['mode'];
  roots: IFileNode[];
  state: MutableQueryState;
}): RecursiveSelectionQueryResult {
  const { durationMs, exceededBudget, mode, roots, state } = args;

  logger.info('recursive selection query complete', {
    directoriesCompleted: state.directoriesCompleted,
    directoriesReadFromAdapter: state.directoriesReadFromAdapter,
    durationMs: Math.round(durationMs),
    exceededBudget,
    limitReached: state.limitReached,
    matchedFiles: state.fileNodes.length,
    mode,
    roots: roots.length,
  });

  return {
    fileNodes: state.fileNodes,
    filePaths: state.fileNodes.map((node) => node.path),
    limitReached: state.limitReached,
    metrics: {
      ...snapshotProgress(state),
      durationMs,
      limitReached: state.limitReached,
      mode,
    },
  };
}

export async function querySelectableFiles(
  options: RecursiveSelectionQueryOptions
): Promise<RecursiveSelectionQueryResult> {
  const {
    abortSignal,
    concurrency = DEFAULT_SCAN_CONCURRENCY,
    excludeFilters,
    fileSystemAdapter,
    filterTreeFn,
    includeFilters,
    maxDirectories = MAX_DIRECTORY_TRAVERSAL_COUNT,
    maxResults,
    onProgress,
    roots,
    useRegex,
  } = options;

  throwIfAborted(abortSignal);

  const timer = createTimer();
  const matcher = createPathFilterMatcher(includeFilters, excludeFilters, useRegex);
  const limit = maxResults === undefined ? Number.POSITIVE_INFINITY : Math.max(0, maxResults);

  if (limit === 0 || roots.length === 0) {
    return buildEmptyResult(timer, limit, maxResults);
  }

  const mode: RecursiveSelectionQueryMetrics['mode'] =
    limit <= LOW_LIMIT_SCAN_THRESHOLD ? 'early-stop' : 'throughput';
  const effectiveConcurrency = Math.min(MAX_SCAN_CONCURRENCY, Math.max(1, concurrency));
  const initialRoots = applyOptionalFilter(roots, filterTreeFn);
  const state = initializeQueryState(initialRoots, matcher);
  const directoryTraversalState: DirectoryTraversalState = {
    maxDirectories,
    queuedDirectoryPaths: new Set(
      initialRoots
        .filter(
          (node) =>
            node.type === 'directory' &&
            node.isVisible !== false &&
            matcher.shouldTraverseDirectory(node.path)
        )
        .map((node) => node.path)
    ),
    scannedDirectoryPaths: new Set(),
  };
  if (directoryTraversalState.queuedDirectoryPaths.size > maxDirectories) {
    throw new Error(`Recursive selection traversal limit exceeded (${maxDirectories})`);
  }
  const progressReporter = createProgressReporter(onProgress, state);

  let frontier = initialRoots;

  while (frontier.length > 0) {
    throwIfAborted(abortSignal);

    const nextFrontier: IFileNode[] = [];
    const unloadedDirectories: IFileNode[] = [];

    for (const [index, node] of frontier.entries()) {
      processFrontierNode({
        abortSignal,
        directoryTraversalState,
        filterTreeFn,
        hasKnownRemainingWork:
          index < frontier.length - 1 ||
          nextFrontier.length > 0 ||
          directoryTraversalState.queuedDirectoryPaths.size >
            directoryTraversalState.scannedDirectoryPaths.size,
        limit,
        matcher,
        nextFrontier,
        node,
        state,
        unloadedDirectories,
      });
      progressReporter.emit();
      if (state.limitReached) {
        break;
      }
    }

    if (state.limitReached) {
      break;
    }

    await scanUnloadedDirectories({
      abortSignal,
      directoryTraversalState,
      effectiveConcurrency,
      fileSystemAdapter,
      filterTreeFn,
      limit,
      matcher,
      mode,
      nextFrontier,
      onProgress,
      state,
      unloadedDirectories,
    });

    if (state.limitReached) {
      break;
    }

    frontier = nextFrontier;
  }

  const durationMs = timer.elapsed();
  const exceededBudget = checkBudget('recursive-selection-query', durationMs, 'treeSnapshot');
  progressReporter.emit(true);
  return buildQueryResult({ durationMs, exceededBudget, mode, roots, state });
}
