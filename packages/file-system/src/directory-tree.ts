/**
 * Read Full Tree Utility
 *
 * Provides directory tree reading with parallel traversal support.
 * Uses a work queue to process multiple directories concurrently,
 * significantly improving performance for large directory trees.
 */

import type { IFileNode, StreamMeta } from '@brainstrike/types';
import {
  type DirectoryReadCapability,
  type ParallelWalkerOptions,
  walkDirectoryParallel,
} from './directory-tree-walker.js';
import type { DirectoryHandle } from './types.js';

export {
  DirectoryListingTruncatedError,
  type DirectoryReadCapability,
  type ParallelWalkerOptions,
  walkDirectoryParallel,
} from './directory-tree-walker.js';

export interface ReadFullTreeOptions {
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal | undefined;
  /** Maximum number of concurrent directory reads (default: 10) */
  concurrency?: number | undefined;
  /** Optional entry policy for pruning directories and files during traversal */
  entryPolicy?: ParallelWalkerOptions['entryPolicy'];
  /** Callback when a directory listing was truncated by the adapter; without it the walk fails on truncation. */
  onDirectoryTruncated?: ParallelWalkerOptions['onDirectoryTruncated'];
  /** Callback when a file or directory entry is skipped during traversal */
  onEntrySkipped?: ParallelWalkerOptions['onEntrySkipped'];
  /** Callback for streaming tree snapshots */
  onTreeSnapshot?: ((tree: IFileNode[], meta: StreamMeta) => void) | undefined;
  /** Throw when a non-root subdirectory cannot be read instead of omitting it from the result. */
  propagateDirectoryReadErrors?: boolean | undefined;
  /** Snapshot interval in ms (default: 100) */
  snapshotIntervalMs?: number | undefined;
  /** Custom sort function for nodes */
  sortFileNodes?: ((nodes: IFileNode[]) => IFileNode[]) | undefined;
  /** Callback for progress updates (receives path and depth) */
  updateProgress?: ((path?: string, depth?: number) => void) | undefined;
}

/**
 * Reads a directory tree with parallel traversal.
 *
 * This function replaces the previous sequential depth-first traversal
 * with a parallel implementation that reads multiple directories concurrently.
 *
 * @param fileSystemAdapter - The file system adapter to use
 * @param directoryHandle - The directory to start reading from
 * @param rootHandle - The root directory handle (for building relative paths)
 * @param parentPath - The parent path (for building relative paths)
 * @param _isRoot - Whether this is the root call (unused in parallel mode)
 * @param abortSignal - Optional abort signal for cancellation
 * @param updateProgress - Optional callback for progress updates
 * @param sortFileNodes - Optional custom sort function
 * @returns Promise resolving to the file tree
 */
export async function readFullTree(
  fileSystemAdapter: DirectoryReadCapability,
  directoryHandle: DirectoryHandle,
  _rootHandle: DirectoryHandle,
  _parentPath = '',
  _isRoot = true,
  abortSignal?: AbortSignal,
  updateProgress?: (path?: string) => void,
  sortFileNodes: (nodes: IFileNode[]) => IFileNode[] = (nodes) => nodes
): Promise<IFileNode[]> {
  const options: ParallelWalkerOptions = {
    abortSignal,
    concurrency: 10, // Default concurrency
    onProgress: updateProgress,
    sortFileNodes,
  };

  return walkDirectoryParallel(fileSystemAdapter, directoryHandle, options);
}

/**
 * Reads a directory tree with configurable options.
 *
 * This is the recommended API for new code, providing explicit
 * configuration of parallel traversal options including streaming
 * tree snapshots for progressive UI updates.
 */
export async function readFullTreeWithOptions(
  fileSystemAdapter: DirectoryReadCapability,
  rootHandle: DirectoryHandle,
  options: ReadFullTreeOptions = {}
): Promise<IFileNode[]> {
  const {
    concurrency,
    abortSignal,
    entryPolicy,
    onDirectoryTruncated,
    onEntrySkipped,
    propagateDirectoryReadErrors,
    updateProgress,
    sortFileNodes,
    onTreeSnapshot,
    snapshotIntervalMs,
  } = options;

  return walkDirectoryParallel(fileSystemAdapter, rootHandle, {
    abortSignal,
    concurrency,
    entryPolicy,
    onDirectoryTruncated,
    onEntrySkipped,
    onProgress: updateProgress,
    onTreeSnapshot,
    propagateDirectoryReadErrors,
    snapshotIntervalMs,
    sortFileNodes,
  });
}
