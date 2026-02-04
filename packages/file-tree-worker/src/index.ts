/**
 * @brainstrike/file-tree-worker
 *
 * Web Worker for off-main-thread file tree operations with BFS expand-all.
 *
 * The worker handles all CPU-bound tree operations:
 * - BFS traversal for expand-all
 * - Tree updates and sorting
 * - Path lookups and traversal
 *
 * The main thread handles all I/O operations:
 * - Directory reading (requires FileSystemHandle)
 * - File content loading
 *
 * @example
 * ```ts
 * import {
 *   resolveFileTreeWorkerUrl,
 *   createFileTreeWorkerPort,
 *   toWorkerFileNode,
 * } from '@brainstrike/file-tree-worker';
 *
 * // Create worker and port
 * const worker = new Worker(resolveFileTreeWorkerUrl(), { type: 'module' });
 * const port = createFileTreeWorkerPort(worker);
 *
 * // Register handlers
 * port.onRequestLoad(async (requestId, paths) => {
 *   // Load directories using FileSystemHandles (main thread only)
 *   const results = await loadDirectories(paths);
 *   return results;
 * });
 *
 * port.onTreeSnapshot((tree, expandedPaths) => {
 *   // Update React state with new tree
 *   setFileTree(rehydrateTree(tree, handleMap));
 * });
 *
 * // Initialize with root nodes
 * const workerNodes = rootNodes.map(toWorkerFileNode);
 * port.init(workerNodes, folderId);
 *
 * // Expand all
 * const { tree, expandedPaths } = await port.expandAll(folderId);
 * ```
 */

// Re-export port
export { createFileTreeWorkerPort, type FileTreeWorkerPort } from './port';
// Re-export tree operations for main thread usage
export {
  collectExpandedPaths,
  findNodeByPath,
  needsLoading,
  sortFileNodes,
  updateNodeChildren,
} from './tree-operations';
// Re-export types
export type {
  BatchLoadResult,
  DirectoryLoadState,
  FlattenedNode,
  MainToWorkerMessage,
  WorkerFileNode,
  WorkerToMainMessage,
} from './types';

/**
 * Resolve the file tree worker URL that Vite/bundlers can turn into a Worker reference.
 * Uses the MDN-recommended `new URL(..., import.meta.url)` pattern for bundlers.
 *
 * @example
 * ```ts
 * import { resolveFileTreeWorkerUrl } from '@brainstrike/file-tree-worker';
 *
 * const worker = new Worker(resolveFileTreeWorkerUrl(), { type: 'module' });
 * ```
 */
export function resolveFileTreeWorkerUrl(): URL {
  if (typeof import.meta !== 'undefined' && typeof import.meta.url === 'string') {
    return new URL('./file-tree.worker.js', import.meta.url);
  }
  if (typeof import.meta.dirname === 'string') {
    return new URL('./file-tree.worker.js', `file://${import.meta.dirname}/`);
  }
  throw new Error('Unable to resolve file tree worker URL in this runtime');
}
