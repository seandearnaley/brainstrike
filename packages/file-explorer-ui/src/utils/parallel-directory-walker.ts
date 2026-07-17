/**
 * Parallel Directory Walker
 *
 * Implements concurrent directory traversal with configurable parallelism.
 * Instead of depth-first sequential traversal, this uses a work queue
 * to process multiple directories concurrently.
 */

import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { DepthProgress, IFileNode, StreamMeta } from '@brainstrike/types';
import { calculatePathDepth } from '@brainstrike/utils';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { fileFilter } from '@brainstrike/utils/path-filter';
import { checkBudget, createTimer } from '@brainstrike/utils/perf-timing';
import { fileNodeCollator } from './file-node-collator';
import { getFinalPath } from './get-final-path';

/** Default number of concurrent directory reads */
const DEFAULT_CONCURRENCY = 10;

/** Minimum concurrency limit */
const MIN_CONCURRENCY = 1;

/** Maximum concurrency limit */
const MAX_CONCURRENCY = 50;

/** Default snapshot interval for streaming updates (ms) */
const DEFAULT_SNAPSHOT_INTERVAL_MS = 100;

/** Initial estimated max depth for progress display */
const INITIAL_ESTIMATED_MAX_DEPTH = 5;

/**
 * Time a directory read operation against LIST_DIRECTORY budget.
 * Returns both the result and timing info for metrics collection.
 */
async function timeDirectoryRead<T>(
  path: string,
  operation: () => Promise<T>
): Promise<{ result: T; durationMs: number; exceededBudget: boolean }> {
  const timer = createTimer();
  const result = await operation();
  const durationMs = timer.elapsed();
  const exceededBudget = checkBudget(`read-dir:${path}`, durationMs, 'listDirectory');
  return { durationMs, exceededBudget, result };
}

export interface ParallelWalkerOptions {
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal | undefined;
  /** Maximum number of concurrent directory reads (default: 10) */
  concurrency?: number | undefined;
  /** Optional entry policy for pruning directories and files during traversal */
  entryPolicy?:
    | {
        shouldIncludeFile?:
          | ((input: {
              fileName: string;
              fileSize: number | undefined;
              relativePath: string;
            }) => boolean)
          | undefined;
        shouldTraverseDirectory?:
          | ((input: { directoryName: string; relativePath: string }) => boolean)
          | undefined;
      }
    | undefined;
  /** Callback when an entry is skipped during traversal */
  onEntrySkipped?:
    | ((entry: {
        entryType: 'directory' | 'file';
        reason: 'default-ignore' | 'entry-policy';
        relativePath: string;
      }) => void)
    | undefined;
  /** Callback for progress updates (path and depth) */
  onProgress?: ((path: string, depth: number) => void) | undefined;
  /** Callback for streaming tree snapshots */
  onTreeSnapshot?: ((tree: IFileNode[], meta: StreamMeta) => void) | undefined;
  /** Throw when a non-root subdirectory cannot be read instead of omitting it from the result. */
  propagateDirectoryReadErrors?: boolean | undefined;
  /** Snapshot interval in ms (default: 100) */
  snapshotIntervalMs?: number | undefined;
  /** Custom sort function for nodes */
  sortFileNodes?: ((nodes: IFileNode[]) => IFileNode[]) | undefined;
}

interface WorkItem {
  depth: number;
  handle: DirectoryHandle;
  parentNode: IFileNode | null;
  parentPath: string;
}

interface EntrySkipDecision {
  entryType: 'directory' | 'file';
  reason: 'default-ignore' | 'entry-policy';
}

/**
 * Creates a promise that can be resolved/rejected externally
 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

/**
 * Default sort function: directories first, then alphabetically
 */
function defaultSortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === 'directory') {
        return -1;
      }
      if (b.type === 'directory') {
        return 1;
      }
    }
    return fileNodeCollator.compare(a.name, b.name);
  });
}

/**
 * Parallel directory walker that processes directories concurrently.
 *
 * Uses a work queue with configurable concurrency to read multiple
 * directories in parallel, significantly improving performance for
 * large directory trees.
 */
export async function walkDirectoryParallel(
  fileSystemAdapter: FileSystemAdapter,
  rootHandle: DirectoryHandle,
  options: ParallelWalkerOptions = {}
): Promise<IFileNode[]> {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    abortSignal,
    entryPolicy,
    onEntrySkipped,
    onProgress,
    propagateDirectoryReadErrors,
    sortFileNodes = defaultSortFileNodes,
    onTreeSnapshot,
    snapshotIntervalMs = DEFAULT_SNAPSHOT_INTERVAL_MS,
  } = options;

  // Clamp concurrency to valid range
  const effectiveConcurrency = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, concurrency));

  if (!rootHandle.path) {
    throw new Error('Root directory handle is missing its canonical path');
  }

  const rootFolderId = rootHandle.path;
  const rootNodes: IFileNode[] = [];

  // Work queue for directories to process
  const workQueue: WorkItem[] = [];

  // Track active workers
  let activeWorkers = 0;

  // Streaming: depth statistics tracking
  const depthStats = {
    currentDepth: 0,
    directoriesCompleted: 0,
    filesFound: 0,
    maxDepthSeen: 0,
  };

  // Streaming: snapshot timing
  const startTime = performance.now();
  let lastSnapshotTime = startTime;

  /**
   * Build current depth progress for streaming metadata
   */
  function buildDepthProgress(): DepthProgress {
    return {
      currentDepth: depthStats.currentDepth,
      directoriesCompleted: depthStats.directoriesCompleted,
      directoriesRemaining: workQueue.length,
      estimatedMaxDepth: Math.max(depthStats.maxDepthSeen + 2, INITIAL_ESTIMATED_MAX_DEPTH),
      filesFound: depthStats.filesFound,
      maxDepthSeen: depthStats.maxDepthSeen,
    };
  }

  /**
   * Emit a tree snapshot if streaming is enabled and interval has passed
   */
  function maybeEmitSnapshot(forceEmit = false): void {
    if (!onTreeSnapshot) {
      return;
    }

    const now = performance.now();
    const timeSinceLastSnapshot = now - lastSnapshotTime;

    if (!forceEmit && timeSinceLastSnapshot < snapshotIntervalMs) {
      return;
    }

    lastSnapshotTime = now;

    const meta: StreamMeta = {
      depthProgress: buildDepthProgress(),
      elapsedMs: now - startTime,
      isComplete: false,
      totalNodesDiscovered: depthStats.filesFound + depthStats.directoriesCompleted,
    };

    // Clone the root nodes array (shallow) for the snapshot
    onTreeSnapshot([...rootNodes], meta);
  }

  // Completion tracking
  const {
    promise: completionPromise,
    resolve: resolveCompletion,
    reject: rejectCompletion,
  } = createDeferred<void>();

  // Error tracking
  let hasError = false;
  let firstError: Error | null = null;

  /**
   * Check if operation was aborted
   */
  function checkAbort(): void {
    if (abortSignal?.aborted) {
      throw new DOMException('Operation was cancelled', 'AbortError');
    }
  }

  function getEntrySkipDecision(entry: IFileNode, relativePath: string): EntrySkipDecision | null {
    if (fileFilter.shouldIgnorePath(relativePath)) {
      if (entry.type === 'file' || entry.type === 'directory') {
        return {
          entryType: entry.type,
          reason: 'default-ignore',
        };
      }
      return null;
    }

    if (
      entry.type === 'directory' &&
      entryPolicy?.shouldTraverseDirectory &&
      !entryPolicy.shouldTraverseDirectory({
        directoryName: entry.name,
        relativePath,
      })
    ) {
      return {
        entryType: 'directory',
        reason: 'entry-policy',
      };
    }

    if (
      entry.type === 'file' &&
      entryPolicy?.shouldIncludeFile &&
      !entryPolicy.shouldIncludeFile({
        fileName: entry.name,
        fileSize: entry.size,
        relativePath,
      })
    ) {
      return {
        entryType: 'file',
        reason: 'entry-policy',
      };
    }

    return null;
  }

  function maybeSkipEntry(entry: IFileNode, relativePath: string): boolean {
    const skipDecision = getEntrySkipDecision(entry, relativePath);
    if (!skipDecision) {
      return false;
    }
    onEntrySkipped?.({
      ...skipDecision,
      relativePath,
    });
    return true;
  }

  /**
   * Process a file entry and return the node
   */
  function processFileEntry(
    entry: IFileNode,
    relativePath: string,
    directoryHandle: DirectoryHandle
  ): IFileNode {
    const finalPath = getFinalPath(directoryHandle, entry, relativePath);
    return {
      ...entry,
      depth: calculatePathDepth(relativePath),
      path: finalPath,
      rootFolderId,
      selectionState: 'unchecked',
    };
  }

  /**
   * Process a directory entry and return the node (children populated later)
   */
  function processDirectoryEntry(
    entry: IFileNode,
    relativePath: string,
    directoryHandle: DirectoryHandle
  ): IFileNode {
    const finalPath = getFinalPath(directoryHandle, entry, relativePath);
    return {
      ...entry,
      children: [], // Will be populated by child processing
      depth: calculatePathDepth(relativePath),
      path: finalPath,
      rootFolderId,
      selectionState: 'unchecked',
    };
  }

  /**
   * Build a directory handle for a child directory
   */
  function buildChildHandle(
    entry: IFileNode,
    finalPath: string,
    parentHandle: DirectoryHandle
  ): DirectoryHandle {
    const entryHandle = entry.handle as Partial<DirectoryHandle> | undefined;
    const childPath =
      typeof entryHandle?.path === 'string' && entryHandle.path.length > 0
        ? entryHandle.path
        : finalPath;
    return {
      _internal: entry.handle,
      kind: 'directory',
      name: entry.name,
      path: childPath,
      platform: entryHandle?.platform ?? parentHandle.platform,
    };
  }

  /**
   * Handle errors from directory reading, re-throwing for root or abort errors
   */
  function handleDirectoryError(error: unknown, depth: number): void {
    if (isAbortError(error)) {
      throw error;
    }
    // For root directory (depth 0), propagate the error
    if (depth === 0 || propagateDirectoryReadErrors) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
    // Silently skip unreadable subdirectories
  }

  /**
   * Process a single entry (file or directory) and add to results
   */
  function processEntry(
    entry: IFileNode,
    relativePath: string,
    handle: DirectoryHandle,
    depth: number,
    processedNodes: IFileNode[]
  ): void {
    if (entry.type === 'file') {
      processedNodes.push(processFileEntry(entry, relativePath, handle));
      depthStats.filesFound++;
      return;
    }
    if (entry.type === 'directory') {
      const dirNode = processDirectoryEntry(entry, relativePath, handle);
      processedNodes.push(dirNode);
      workQueue.push({
        depth: depth + 1,
        handle: buildChildHandle(entry, dirNode.path, handle),
        parentNode: dirNode,
        parentPath: relativePath,
      });
    }
  }

  /**
   * Attach sorted nodes to parent or root
   */
  function attachNodes(processedNodes: IFileNode[], parentNode: IFileNode | null): void {
    const sortedNodes = sortFileNodes(processedNodes);
    if (parentNode === null) {
      rootNodes.push(...sortedNodes);
    } else {
      parentNode.children = sortedNodes;
    }
  }

  /**
   * Process a single work item (directory)
   * Includes timing instrumentation against LIST_DIRECTORY budget.
   */
  async function processWorkItem(item: WorkItem): Promise<void> {
    checkAbort();
    const { handle, parentPath, parentNode, depth } = item;

    // Update depth tracking
    depthStats.currentDepth = depth;
    if (depth > depthStats.maxDepthSeen) {
      depthStats.maxDepthSeen = depth;
    }

    try {
      // Time the directory read against LIST_DIRECTORY budget (200ms)
      const { result: entries } = await timeDirectoryRead(handle.path, () =>
        fileSystemAdapter.readDirectory(handle)
      );
      checkAbort();

      const processedNodes: IFileNode[] = [];

      for (const entry of entries) {
        checkAbort();
        const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
        if (maybeSkipEntry(entry, relativePath)) {
          continue;
        }
        onProgress?.(relativePath, depth);
        processEntry(entry, relativePath, handle, depth, processedNodes);
      }

      attachNodes(processedNodes, parentNode);

      // Track directory completion and maybe emit snapshot
      depthStats.directoriesCompleted++;
      maybeEmitSnapshot();
    } catch (error) {
      handleDirectoryError(error, depth);
    }
  }

  /**
   * Worker function that processes items from the queue
   */
  async function worker(): Promise<void> {
    while (workQueue.length > 0 && !hasError) {
      checkAbort();

      const item = workQueue.shift();
      if (!item) {
        break;
      }

      await processWorkItem(item);
    }
  }

  /**
   * Start workers and manage concurrency
   */
  async function runWorkers(): Promise<void> {
    // Add initial work item (root directory)
    workQueue.push({
      depth: 0,
      handle: rootHandle,
      parentNode: null,
      parentPath: '',
    });

    // Keep spawning workers while there's work to do
    const processLoop = async (): Promise<void> => {
      while ((workQueue.length > 0 || activeWorkers > 0) && !hasError) {
        checkAbort();

        // Spawn new workers up to concurrency limit
        while (workQueue.length > 0 && activeWorkers < effectiveConcurrency && !hasError) {
          activeWorkers++;
          worker()
            .catch((error) => {
              if (!hasError) {
                hasError = true;
                firstError = error instanceof Error ? error : new Error(String(error));
              }
            })
            .finally(() => {
              activeWorkers--;
            });
        }

        // Yield to allow workers to process
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      if (hasError && firstError) {
        rejectCompletion(firstError);
      } else {
        resolveCompletion();
      }
    };

    await processLoop();
    await completionPromise;
  }

  await runWorkers();

  // Final sort of root nodes
  const finalTree = sortFileNodes(rootNodes);

  // Emit final snapshot with isComplete: true
  if (onTreeSnapshot) {
    const finalMeta: StreamMeta = {
      depthProgress: buildDepthProgress(),
      elapsedMs: performance.now() - startTime,
      isComplete: true,
      totalNodesDiscovered: depthStats.filesFound + depthStats.directoriesCompleted,
    };
    onTreeSnapshot(finalTree, finalMeta);
  }

  return finalTree;
}
