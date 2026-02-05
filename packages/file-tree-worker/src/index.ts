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

interface ImportMetaLike {
  url?: string;
  dirname?: string;
}

const IMPORT_META_OVERRIDE_KEY = '__BRAINSTRIKE_IMPORT_META__';

function readImportMetaOverride(): ImportMetaLike | null {
  const override = (globalThis as Record<string, unknown>)[IMPORT_META_OVERRIDE_KEY];
  if (!override || typeof override !== 'object') {
    return null;
  }
  const importMeta = override as ImportMetaLike;
  return importMeta;
}

function getImportMeta(): ImportMetaLike | null {
  const override = readImportMetaOverride();
  if (override) {
    return override;
  }
  if (typeof import.meta !== 'undefined') {
    return import.meta as ImportMetaLike;
  }
  return null;
}

function describeImportMeta(meta: ImportMetaLike | null): string {
  if (!meta) {
    return 'import.meta is undefined (CommonJS context?)';
  }
  const urlDescription =
    typeof meta.url === 'string' ? `import.meta.url: ${meta.url}` : 'import.meta.url is undefined';
  const dirnameDescription =
    typeof meta.dirname === 'string'
      ? `import.meta.dirname: ${meta.dirname}`
      : 'import.meta.dirname is undefined';
  return `${urlDescription}; ${dirnameDescription}`;
}

function resolveWorkerUrl(workerPath: string, workerName: string): URL {
  const meta = getImportMeta();
  if (meta && typeof meta.url === 'string') {
    return new URL(workerPath, meta.url);
  }
  if (meta && typeof meta.dirname === 'string') {
    return new URL(workerPath, `file://${meta.dirname}/`);
  }
  const context = describeImportMeta(meta);
  throw new Error(
    `Unable to resolve ${workerName} worker URL in this runtime. Context: ${context}. ` +
      'This package must be imported as ESM, not CommonJS.'
  );
}

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
  return resolveWorkerUrl('./file-tree.worker.js', 'file tree');
}
