import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { checkBudget, createTimer } from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import { fileFilter } from '@brainstrike/utils/path-filter';

import { runWithConcurrency } from './concurrency';
import { loadDirectoryChildren } from './lazy-tree-loader';

const logger = createLogger('RecursiveSelectionQuery');

const DEFAULT_SCAN_CONCURRENCY = 6;
const LOW_LIMIT_SCAN_THRESHOLD = 256;

interface PathFilterMatcher {
  shouldIncludeFile: (path: string) => boolean;
  shouldTraverseDirectory: (path: string) => boolean;
}

function processFilter(filter: string): string {
  if (filter.startsWith('!')) {
    return `!${processFilter(filter.slice(1))}`;
  }
  if (filter.startsWith('**/') || filter.startsWith('**') || filter.startsWith('/')) {
    return filter;
  }
  return `**/${filter}`;
}

function normalizePathForMatching(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function createPathFilterMatcher(
  includeFilters: string[],
  excludeFilters: string[] = [],
  useRegex = false
): PathFilterMatcher {
  const includeMatchers = includeFilters.map((pattern) =>
    fileFilter.createMatcher(useRegex ? pattern : processFilter(pattern), useRegex)
  );
  const excludeMatchers = excludeFilters.map((pattern) =>
    fileFilter.createMatcher(useRegex ? pattern : processFilter(pattern), useRegex)
  );

  const matchesInclude = (path: string): boolean => {
    if (includeMatchers.length === 0) {
      return true;
    }
    return includeMatchers.some((matcher) => matcher(path));
  };

  const matchesExclude = (path: string): boolean => {
    return excludeMatchers.some((matcher) => matcher(path));
  };

  return {
    shouldIncludeFile(path: string): boolean {
      const normalizedPath = normalizePathForMatching(path);
      return !matchesExclude(normalizedPath) && matchesInclude(normalizedPath);
    },
    shouldTraverseDirectory(path: string): boolean {
      return !matchesExclude(normalizePathForMatching(path));
    },
  };
}

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

function applyOptionalFilter(
  nodes: IFileNode[],
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[]
): IFileNode[] {
  return filterTreeFn ? filterTreeFn(nodes) : nodes;
}

function recordMatchedFile(state: MutableQueryState, node: IFileNode, maxResults: number): boolean {
  state.filesMatched++;
  state.fileNodes.push(node);
  if (state.fileNodes.length >= maxResults) {
    state.limitReached = Number.isFinite(maxResults);
    return true;
  }
  return false;
}

function consumeNodes(args: {
  matcher: ReturnType<typeof createPathFilterMatcher>;
  maxResults: number;
  nextFrontier: IFileNode[];
  nodes: IFileNode[];
  state: MutableQueryState;
}): boolean {
  const { matcher, maxResults, nextFrontier, nodes, state } = args;

  for (const node of nodes) {
    if (node.isVisible === false) {
      continue;
    }

    state.currentPath = node.path;

    if (node.type === 'file') {
      state.filesVisited++;
      if (matcher.shouldIncludeFile(node.path) && recordMatchedFile(state, node, maxResults)) {
        return true;
      }
      continue;
    }

    if (!matcher.shouldTraverseDirectory(node.path)) {
      continue;
    }

    nextFrontier.push(node);
    state.directoriesDiscovered++;
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
      filesMatched: 0,
      filesVisited: 0,
      durationMs: timer.elapsed(),
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
  filterTreeFn: ((tree: IFileNode[]) => IFileNode[]) | undefined;
  limit: number;
  matcher: PathFilterMatcher;
  nextFrontier: IFileNode[];
  node: IFileNode;
  state: MutableQueryState;
  unloadedDirectories: IFileNode[];
}): void {
  const {
    abortSignal,
    filterTreeFn,
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
    if (matcher.shouldIncludeFile(node.path) && recordMatchedFile(state, node, limit)) {
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

  if (unloadedDirectories.length === 0) {
    return;
  }

  if (mode === 'early-stop') {
    for (const node of unloadedDirectories) {
      throwIfAborted(abortSignal);
      const children = await scanDirectory(fileSystemAdapter, node, filterTreeFn, abortSignal);
      state.currentPath = node.path;
      state.directoriesReadFromAdapter++;
      state.directoriesCompleted++;
      const stopped = consumeNodes({
        matcher,
        maxResults: limit,
        nextFrontier,
        nodes: children,
        state,
      });
      onProgress?.(snapshotProgress(state));
      if (stopped) {
        return;
      }
    }
    return;
  }

  const results = await runWithConcurrency(
    unloadedDirectories,
    effectiveConcurrency,
    async (node) => ({
      children: await scanDirectory(fileSystemAdapter, node, filterTreeFn, abortSignal),
      node,
    })
  );

  for (const result of results) {
    state.currentPath = result.node.path;
    state.directoriesReadFromAdapter++;
    state.directoriesCompleted++;
    const stopped = consumeNodes({
      matcher,
      maxResults: limit,
      nextFrontier,
      nodes: result.children,
      state,
    });
    onProgress?.(snapshotProgress(state));
    if (stopped) {
      return;
    }
  }
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
    roots: roots.length,
    mode,
    matchedFiles: state.fileNodes.length,
    directoriesCompleted: state.directoriesCompleted,
    directoriesReadFromAdapter: state.directoriesReadFromAdapter,
    limitReached: state.limitReached,
    durationMs: Math.round(durationMs),
    exceededBudget,
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
  const effectiveConcurrency = Math.max(1, concurrency);
  const initialRoots = applyOptionalFilter(roots, filterTreeFn);
  const state = initializeQueryState(initialRoots, matcher);

  let frontier = initialRoots;

  while (frontier.length > 0) {
    throwIfAborted(abortSignal);

    const nextFrontier: IFileNode[] = [];
    const unloadedDirectories: IFileNode[] = [];

    for (const node of frontier) {
      processFrontierNode({
        abortSignal,
        filterTreeFn,
        limit,
        matcher,
        nextFrontier,
        node,
        state,
        unloadedDirectories,
      });
      onProgress?.(snapshotProgress(state));
      if (state.limitReached) {
        break;
      }
    }

    if (state.limitReached) {
      break;
    }

    await scanUnloadedDirectories({
      abortSignal,
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
  return buildQueryResult({ durationMs, exceededBudget, mode, roots, state });
}
