/**
 * Read Full Tree Utility
 *
 * Provides directory tree reading with parallel traversal support.
 * Uses a work queue to process multiple directories concurrently,
 * significantly improving performance for large directory trees.
 */

import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode, StreamMeta } from '@brainstrike/types';
import { type ParallelWalkerOptions, walkDirectoryParallel } from './parallel-directory-walker';

export type ReadFullTreeOptions = {
  /** Maximum number of concurrent directory reads (default: 10) */
  concurrency?: number | undefined;
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal | undefined;
  /** Callback for progress updates (receives path and depth) */
  updateProgress?: ((path?: string, depth?: number) => void) | undefined;
  /** Custom sort function for nodes */
  sortFileNodes?: ((nodes: IFileNode[]) => IFileNode[]) | undefined;
  /** Callback for streaming tree snapshots */
  onTreeSnapshot?: ((tree: IFileNode[], meta: StreamMeta) => void) | undefined;
  /** Snapshot interval in ms (default: 100) */
  snapshotIntervalMs?: number | undefined;
};

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
  fileSystemAdapter: FileSystemAdapter,
  directoryHandle: DirectoryHandle,
  _rootHandle: DirectoryHandle,
  _parentPath = '',
  _isRoot = true,
  abortSignal?: AbortSignal,
  updateProgress?: (path?: string) => void,
  sortFileNodes: (nodes: IFileNode[]) => IFileNode[] = (nodes) => nodes
): Promise<IFileNode[]> {
  const options: ParallelWalkerOptions = {
    concurrency: 10, // Default concurrency
    abortSignal,
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
  fileSystemAdapter: FileSystemAdapter,
  rootHandle: DirectoryHandle,
  options: ReadFullTreeOptions = {}
): Promise<IFileNode[]> {
  const {
    concurrency,
    abortSignal,
    updateProgress,
    sortFileNodes,
    onTreeSnapshot,
    snapshotIntervalMs,
  } = options;

  return walkDirectoryParallel(fileSystemAdapter, rootHandle, {
    concurrency,
    abortSignal,
    onProgress: updateProgress,
    sortFileNodes,
    onTreeSnapshot,
    snapshotIntervalMs,
  });
}
