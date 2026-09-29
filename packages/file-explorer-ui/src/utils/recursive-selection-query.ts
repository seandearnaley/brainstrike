import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';
import { checkBudget, createTimer } from '@brainstrike/utils';
import { createPathFilterMatcher } from '@brainstrike/utils/filter-utils';
import { createAsyncScanQueue, type ScanResult } from './async-scan-queue';
import { loadDirectoryChildren } from './lazy-tree-loader';
import {
  compactDirectoryIntoFrontier,
  type RecursiveSelectionBufferProfile,
} from './recursive-selection-buffer-profile';

export type { RecursiveSelectionBufferProfile } from './recursive-selection-buffer-profile';

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
  /**
   * Cooperative cancellation. Adapter reads are expected to reject with an
   * AbortError when this signal fires; the scan treats that rejection as a
   * completion outcome and rethrows it, in both scan modes. An adapter that
   * ignores the signal but settles after cancellation still surfaces its
   * AbortError through the throughput drain. There is no liveness timeout:
   * a read that never settles keeps the query pending (see the module
   * contract on `querySelectableFiles`).
   */
  abortSignal?: AbortSignal;
  /**
   * Opt-in: retain the raw listing of every adapter-read directory in
   * `directoryUpdates` for tree hydration. OFF by default — select-all scans
   * never consume them, and retaining every listing on the largest scans is
   * avoidable memory pressure. Enforced identically in early-stop and
   * throughput mode: without the opt-in NO listing is retained, whatever the
   * cap or scan mode.
   */
  collectDirectoryUpdates?: boolean;
  concurrency?: number;
  excludeFilters: string[];
  fileSystemAdapter: FileSystemAdapter;
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];
  includeFilters: string[];
  maxDirectories?: number;
  maxResults?: number;
  /**
   * Opt-in deterministic frontier profiling. Counts traversal-owned array
   * entries, not adapter-owned listings or heap bytes.
   */
  onBufferProfile?: (profile: RecursiveSelectionBufferProfile) => void;
  onProgress?: (progress: RecursiveSelectionQueryProgress) => void;
  parentRootId?: DirectoryHandle['rootId'];
  roots: IFileNode[];
  useRegex: boolean;
}

/**
 * A raw directory listing captured during the scan — the exact shape the
 * normalized tree ingests. Children are UNFILTERED: the normalized tree is
 * the raw universe; workspace/quick filters apply downstream at display and
 * selection time.
 */
export interface RecursiveSelectionDirectoryUpdate {
  children: IFileNode[];
  path: string;
}

export interface RecursiveSelectionQueryResult {
  /**
   * One entry per directory READ FROM THE ADAPTER during this scan (already
   * loaded directories are skipped). Callers hydrate the lazy tree with these
   * so a completed folder-select can derive a truthful checked state without
   * waiting for the user to expand each subdirectory.
   */
  directoryUpdates: RecursiveSelectionDirectoryUpdate[];
  fileNodes: IFileNode[];
  filePaths: string[];
  limitReached: boolean;
  metrics: RecursiveSelectionQueryMetrics;
}

interface MutableQueryState {
  collectDirectoryUpdates: boolean;
  currentPath: string | null;
  directoriesCompleted: number;
  directoriesDiscovered: number;
  directoriesReadFromAdapter: number;
  directoryUpdates: RecursiveSelectionDirectoryUpdate[];
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

async function readDirectoryChildrenWithBudget(args: {
  abortSignal: AbortSignal | undefined;
  adapter: FileSystemAdapter;
  node: IFileNode;
  parentRootId: DirectoryHandle['rootId'];
}): Promise<IFileNode[]> {
  const { abortSignal, adapter, node, parentRootId } = args;
  const timer = createTimer();
  const children = await loadDirectoryChildren(adapter, node, {
    ...(abortSignal ? { abortSignal } : {}),
    includeMetadata: false,
    parentRootId,
  });
  checkBudget(`recursive-selection:${node.path}`, timer.elapsed(), 'listDirectory');
  return children;
}

async function scanDirectory(args: {
  abortSignal: AbortSignal | undefined;
  adapter: FileSystemAdapter;
  filterTreeFn: ((tree: IFileNode[]) => IFileNode[]) | undefined;
  node: IFileNode;
  parentRootId: DirectoryHandle['rootId'];
  recordDirectoryUpdate: (update: RecursiveSelectionDirectoryUpdate) => void;
}): Promise<IFileNode[]> {
  const { abortSignal, adapter, filterTreeFn, node, parentRootId, recordDirectoryUpdate } = args;
  const children = await readDirectoryChildrenWithBudget({
    abortSignal,
    adapter,
    node,
    parentRootId,
  });
  // Record BEFORE filtering: hydration wants the raw listing.
  recordDirectoryUpdate({ children, path: node.path });
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
    directoryUpdates: [],
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
  matcher: PathFilterMatcher,
  collectDirectoryUpdates: boolean
): MutableQueryState {
  return {
    collectDirectoryUpdates,
    currentPath: null,
    directoriesCompleted: 0,
    directoriesDiscovered: initialRoots.filter(
      (node) =>
        node.type === 'directory' &&
        node.isVisible !== false &&
        matcher.shouldTraverseDirectory(node.path)
    ).length,
    directoriesReadFromAdapter: 0,
    directoryUpdates: [],
    fileNodes: [],
    filesMatched: 0,
    filesVisited: 0,
    limitReached: false,
  };
}

function createDirectoryUpdateRecorder(
  state: MutableQueryState
): (update: RecursiveSelectionDirectoryUpdate) => void {
  // Single owner of the collectDirectoryUpdates gate: every scan mode records
  // through THIS closure, so retention semantics cannot diverge between modes
  // again (that asymmetry was BST-478's original early-stop defect).
  return (update) => {
    if (state.collectDirectoryUpdates) {
      state.directoryUpdates.push(update);
    }
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
}): boolean {
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
  } = args;

  throwIfAborted(abortSignal);
  if (node.isVisible === false) {
    return false;
  }

  state.currentPath = node.path;

  if (node.type === 'file') {
    state.filesVisited++;
    if (matcher.shouldIncludeFile(node.path)) {
      recordMatchedFile({
        hasKnownRemainingWork,
        maxResults: limit,
        node,
        state,
      });
    }
    return false;
  }

  if (!matcher.shouldTraverseDirectory(node.path)) {
    return false;
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
    return false;
  }

  return true;
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
  parentRootId: DirectoryHandle['rootId'];
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
    parentRootId,
    state,
    unloadedDirectories,
  } = args;

  const progressReporter = createProgressReporter(onProgress, state);
  const recordDirectoryUpdate = createDirectoryUpdateRecorder(state);

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
      const children = await scanDirectory({
        abortSignal,
        adapter: fileSystemAdapter,
        filterTreeFn,
        node,
        parentRootId,
        // Shared recorder: same opt-in contract as throughput mode.
        recordDirectoryUpdate,
      });
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
    parentRootId,
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
  parentRootId: DirectoryHandle['rootId'];
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
    parentRootId,
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
      parentRootId,
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
  parentRootId: DirectoryHandle['rootId'];
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
    parentRootId,
    progressReporter,
    scanAbortController,
    state,
    unloadedDirectories,
  } = args;

  // Same shared factory as every other mode — retention cannot diverge.
  const recordDirectoryUpdate = createDirectoryUpdateRecorder(state);

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
      parentRootId,
      recordDirectoryUpdate,
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
    // Cancellation is a completion OUTCOME, not a silent no-op: an adapter
    // read that settles after the caller cancelled carries its AbortError
    // here, and rejecting lets handleSelectionError report { cancelled }.
    // Resolving instead would commit a partial selection as success.
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
  parentRootId: DirectoryHandle['rootId'];
  recordDirectoryUpdate: (update: RecursiveSelectionDirectoryUpdate) => void;
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
    parentRootId,
    recordDirectoryUpdate,
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
    const task = scanDirectory({
      abortSignal: scanAbortController.signal,
      adapter: fileSystemAdapter,
      filterTreeFn,
      node,
      parentRootId,
      recordDirectoryUpdate,
    })
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
    directoryUpdates: state.directoryUpdates,
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

/**
 * Scan a set of root nodes recursively and return every file matching the
 * include/exclude filters, up to `maxResults`.
 *
 * ## Concurrency assumptions (single-threaded queue/frontier invariants)
 *
 * Everything below assumes the single JavaScript thread of a renderer or
 * worker: there are no locks, because all shared state mutations happen
 * synchronously between awaits. The scan is breadth-first by tree depth:
 * each iteration processes the loaded portion of the current frontier
 * synchronously, then scans that frontier's unloaded directories before
 * descending into the next one.
 *
 * - Two scan modes, selected once from `maxResults`: **early-stop**
 *   (`maxResults <= LOW_LIMIT_SCAN_THRESHOLD`) reads directories strictly
 *   sequentially and stops at the first cap-filling match; **throughput**
 *   reads concurrently, clamping caller `concurrency` into
 *   `[1, MAX_SCAN_CONCURRENCY]`.
 * - Throughput scheduling drains one bounded batch at a time: up to
 *   `effectiveConcurrency` adapter reads start together, results flow through
 *   a FIFO async scan queue, and the batch closes exactly once when spawning
 *   is finished AND every task has settled (a synchronous fallback close
 *   covers tasks that drained before the spawn loop observed them). A batch
 *   never mixes with the next frontier's reads.
 * - Traversal deduplicates by directory path across frontiers
 *   (`queuedDirectoryPaths` / `scannedDirectoryPaths`), so cycles and
 *   multi-root aliasing cannot revisit a directory; discovering more than
 *   `maxDirectories` unique paths throws.
 *
 * ## Completion outcomes
 *
 * The query settles exactly once, with ONE of:
 *
 * - a full result (frontier exhausted),
 * - a capped result with `limitReached: true` (reported only while traversal
 *   provably had more work), or
 * - a thrown error: cancellation (below), the traversal-limit error above, or
 *   the first adapter read failure.
 *
 * Cancellation is a completion OUTCOME in both modes, never a silent no-op:
 * an adapter read that observes the abort signal rejects the query with its
 * AbortError, and a read that ignores the signal but settles afterwards still
 * surfaces its AbortError through the throughput drain — plus a terminal
 * caller-signal check before the result is built, so the guarantee does not
 * depend on any read rechecking after it settles. Resolving instead would let
 * callers commit a partial selection as success. There is NO liveness
 * timeout: an adapter read that neither resolves nor rejects keeps the query
 * pending indefinitely (the concurrency bound is not a watchdog); bounding
 * that requires an explicit cancellation owner and adapter contract. Note the
 * flip side: cancelling does not force a pending adapter promise to settle,
 * so callers that reset their UI eagerly can briefly outlive a leaked
 * in-flight read — the scan owns no handle to cancel it with.
 */
export async function querySelectableFiles(
  options: RecursiveSelectionQueryOptions
): Promise<RecursiveSelectionQueryResult> {
  const {
    abortSignal,
    collectDirectoryUpdates = false,
    concurrency = DEFAULT_SCAN_CONCURRENCY,
    excludeFilters,
    fileSystemAdapter,
    filterTreeFn,
    includeFilters,
    maxDirectories = MAX_DIRECTORY_TRAVERSAL_COUNT,
    maxResults,
    onBufferProfile,
    onProgress,
    parentRootId,
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
  const state = initializeQueryState(initialRoots, matcher, collectDirectoryUpdates);
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

  // `initialRoots` may alias the caller's live tree. The traversal compacts its
  // frontier in place, so it must own this copy.
  let frontier = [...initialRoots];
  let frontierDirectoryEntries = frontier.filter((node) => node.type === 'directory').length;

  while (frontier.length > 0) {
    throwIfAborted(abortSignal);

    const nextFrontier: IFileNode[] = [];
    let unloadedDirectoryCount = 0;
    const frontierLength = frontier.length;

    // Compact unloaded directories in the traversal-owned frontier. Building
    // a second list here retained every directory twice across wide levels.
    // The write stays at or behind the iterator cursor because the compacted
    // count can increase at most once per iteration.
    for (const [index, node] of frontier.entries()) {
      const shouldScan = processFrontierNode({
        abortSignal,
        directoryTraversalState,
        filterTreeFn,
        hasKnownRemainingWork:
          index < frontierLength - 1 ||
          nextFrontier.length > 0 ||
          directoryTraversalState.queuedDirectoryPaths.size >
            directoryTraversalState.scannedDirectoryPaths.size,
        limit,
        matcher,
        nextFrontier,
        node,
        state,
      });
      if (shouldScan) {
        frontierDirectoryEntries = compactDirectoryIntoFrontier({
          directoryEntries: frontierDirectoryEntries,
          frontier,
          node,
          targetIndex: unloadedDirectoryCount,
        });
        unloadedDirectoryCount++;
      }
      onBufferProfile?.({
        bufferedDirectoryEntries: frontierDirectoryEntries + nextFrontier.length,
      });
      progressReporter.emit();
      if (state.limitReached) {
        break;
      }
    }
    frontier.length = unloadedDirectoryCount;
    frontierDirectoryEntries = unloadedDirectoryCount;
    onBufferProfile?.({ bufferedDirectoryEntries: frontierDirectoryEntries + nextFrontier.length });

    if (state.limitReached) {
      break;
    }

    try {
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
        parentRootId,
        state,
        unloadedDirectories: frontier,
      });
    } finally {
      // The next frontier grows monotonically during a scan. Sampling on every
      // exit observes its high-water mark, including capped and aborted scans.
      onBufferProfile?.({
        bufferedDirectoryEntries: frontierDirectoryEntries + nextFrontier.length,
      });
    }

    if (state.limitReached) {
      break;
    }

    frontier = nextFrontier;
    frontierDirectoryEntries = frontier.length;
  }

  // Terminal cancellation guard: the drain loop can exit silently through its
  // scanAbortController.signal.aborted check when a late read settles
  // successfully past cancellation and discovers no further frontier work.
  // Checking the CALLER's signal here (not the internal controller) makes
  // "cancellation is a completion outcome" independent of whether every
  // adapter read honors the signal or rechecks after settling — while leaving
  // natural completions and cap-stopped scans untouched (the internal
  // controller also aborts on state.limitReached, which must stay a result,
  // never an AbortError).
  abortSignal?.throwIfAborted();

  const durationMs = timer.elapsed();
  const exceededBudget = checkBudget('recursive-selection-query', durationMs, 'treeSnapshot');
  progressReporter.emit(true);
  return buildQueryResult({ durationMs, exceededBudget, mode, roots, state });
}
