/**
 * Parallel Directory Walker
 *
 * Implements concurrent directory traversal with configurable parallelism.
 * Instead of depth-first sequential traversal, this uses a work queue
 * to process multiple directories concurrently.
 */

import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { fileFilter } from '@brainstrike/utils';
import { getFinalPath } from './get-final-path';

/** Default number of concurrent directory reads */
const DEFAULT_CONCURRENCY = 10;

/** Minimum concurrency limit */
const MIN_CONCURRENCY = 1;

/** Maximum concurrency limit */
const MAX_CONCURRENCY = 50;

export type ParallelWalkerOptions = {
  /** Maximum number of concurrent directory reads (default: 10) */
  concurrency?: number | undefined;
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal | undefined;
  /** Callback for progress updates */
  onProgress?: ((path: string) => void) | undefined;
  /** Custom sort function for nodes */
  sortFileNodes?: ((nodes: IFileNode[]) => IFileNode[]) | undefined;
};

type WorkItem = {
  handle: DirectoryHandle;
  parentPath: string;
  parentNode: IFileNode | null;
  depth: number;
};

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
  return { promise, resolve, reject };
}

/**
 * Default sort function: directories first, then alphabetically
 */
function defaultSortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === 'directory') return -1;
      if (b.type === 'directory') return 1;
    }
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
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
    onProgress,
    sortFileNodes = defaultSortFileNodes,
  } = options;

  // Clamp concurrency to valid range
  const effectiveConcurrency = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, concurrency));

  const rootFolderId = rootHandle.name;
  const rootNodes: IFileNode[] = [];

  // Work queue for directories to process
  const workQueue: WorkItem[] = [];

  // Track active workers
  let activeWorkers = 0;

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
      path: finalPath,
      depth: relativePath.split('/').length - 1,
      selectionState: 'unchecked',
      rootFolderId,
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
      path: finalPath,
      depth: relativePath.split('/').length - 1,
      children: [], // Will be populated by child processing
      selectionState: 'unchecked',
      rootFolderId,
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
    return {
      path: finalPath,
      name: entry.name,
      kind: 'directory',
      platform: parentHandle.platform,
      _internal: entry.handle,
    };
  }

  /**
   * Process a single work item (directory)
   */
  async function processWorkItem(item: WorkItem): Promise<void> {
    checkAbort();

    const { handle, parentPath, parentNode, depth } = item;

    try {
      const entries = await fileSystemAdapter.readDirectory(handle);

      checkAbort();

      const processedNodes: IFileNode[] = [];

      for (const entry of entries) {
        checkAbort();

        const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

        if (fileFilter.shouldIgnorePath(relativePath)) {
          continue;
        }

        onProgress?.(relativePath);

        if (entry.type === 'file') {
          const fileNode = processFileEntry(entry, relativePath, handle);
          processedNodes.push(fileNode);
        } else if (entry.type === 'directory') {
          const dirNode = processDirectoryEntry(entry, relativePath, handle);
          processedNodes.push(dirNode);

          // Queue child directory for parallel processing
          const childHandle = buildChildHandle(entry, dirNode.path, handle);
          workQueue.push({
            handle: childHandle,
            parentPath: relativePath,
            parentNode: dirNode,
            depth: depth + 1,
          });
        }
      }

      // Sort and attach nodes to parent
      const sortedNodes = sortFileNodes(processedNodes);

      if (parentNode === null) {
        // Root level nodes
        rootNodes.push(...sortedNodes);
      } else {
        // Child nodes - attach to parent's children array
        parentNode.children = sortedNodes;
      }
    } catch (error) {
      // Always re-throw abort errors
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }

      // For root directory (depth 0), propagate the error
      // For subdirectories, silently skip (permission errors, etc.)
      if (depth === 0) {
        // Convert non-Error exceptions to proper Error objects
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(String(error));
      }
      // Silently skip unreadable subdirectories
    }
  }

  /**
   * Worker function that processes items from the queue
   */
  async function worker(): Promise<void> {
    while (workQueue.length > 0 && !hasError) {
      checkAbort();

      const item = workQueue.shift();
      if (!item) break;

      await processWorkItem(item);
    }
  }

  /**
   * Start workers and manage concurrency
   */
  async function runWorkers(): Promise<void> {
    // Add initial work item (root directory)
    workQueue.push({
      handle: rootHandle,
      parentPath: '',
      parentNode: null,
      depth: 0,
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
  return sortFileNodes(rootNodes);
}
