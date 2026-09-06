/**
 * Lazy Tree Loader Utilities
 *
 * Provides functions for on-demand directory loading. Instead of loading
 * the entire file tree upfront, directories are loaded when expanded.
 *
 * Generic tree operations are imported from @brainstrike/utils.
 */

import {
  findNodeByPath as findNodeByPathGeneric,
  isLoading as isLoadingGeneric,
  needsLoading as needsLoadingGeneric,
  setNodeLoadState as setNodeLoadStateGeneric,
  sortTreeNodes,
  updateNodeChildren as updateNodeChildrenGeneric,
} from '@brainstrike/file-tree-worker';
import type {
  DirectoryHandle,
  DirectoryLoadState,
  FileSystemAdapter,
  IFileNode,
} from '@brainstrike/types';
import { fileFilter } from '@brainstrike/utils/path-filter';

export interface LazyLoadOptions {
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal;
  /** Whether to include file metadata (size, lastModified) */
  includeMetadata?: boolean;
  /** Durable root identity inherited when a raw child handle is unstamped. */
  parentRootId?: DirectoryHandle['rootId'];
  /**
   * Override the rootFolderId stamped on loaded nodes.
   * Since storage v5 this is the durable RootId UUID; when absent the
   * loader falls back to `rootHandle.path` (pre-v5 behaviour preserved for
   * callers that have not yet threaded the identity).
   */
  rootFolderId?: string;
  /** Custom sort function for nodes */
  sortFileNodes?: (nodes: IFileNode[]) => IFileNode[];
}

/**
 * Default sort function: directories first, then alphabetically
 */
function defaultSortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return sortTreeNodes(nodes);
}

/**
 * Detect platform from a native handle
 */
function detectPlatform(handle: unknown): 'web' | 'electron' {
  // Check if it's already a DirectoryHandle with platform info
  if (handle && typeof handle === 'object' && 'platform' in handle) {
    return (handle as { platform: string }).platform === 'electron' ? 'electron' : 'web';
  }
  // Check for web FileSystemDirectoryHandle (has entries() method)
  if (handle && typeof handle === 'object' && 'entries' in handle) {
    return 'web';
  }
  // Assume electron otherwise
  return 'electron';
}

/**
 * Build a DirectoryHandle from an IFileNode
 */
function buildDirectoryHandle(
  node: IFileNode,
  parentRootId: DirectoryHandle['rootId']
): DirectoryHandle {
  // IFileNode.handle is a required field (never optional in the type), so a
  // directory node without one is a malformed input, not a legitimate shape
  // to tolerate — silently defaulting `platform` via detectPlatform(undefined)
  // would produce a plausible-but-wrong handle instead of surfacing the bug.
  // Per NO SILENT FALLBACKS: throw loudly instead of degrading quietly.
  if (node.handle === undefined) {
    throw new Error(`Directory node is missing its native handle: ${node.path}`);
  }
  const nodeHandle = node.handle as Partial<DirectoryHandle>;
  const rootId = nodeHandle.rootId ?? parentRootId;
  return {
    _internal: node.handle,
    kind: 'directory',
    name: node.name,
    path: node.path,
    platform: detectPlatform(node.handle),
    ...(rootId === undefined ? {} : { rootId }),
  };
}

/**
 * Load root directory contents (initial load).
 *
 * Only loads immediate children. Subdirectories are marked as 'unloaded'
 * with children: undefined, ready for lazy expansion.
 *
 * @param adapter - File system adapter
 * @param rootHandle - Root directory handle
 * @param options - Load options
 * @returns Array of child nodes with directories marked as unloaded
 */
export async function loadRootDirectory(
  adapter: FileSystemAdapter,
  rootHandle: DirectoryHandle,
  options: LazyLoadOptions = {}
): Promise<IFileNode[]> {
  const {
    abortSignal,
    includeMetadata = false,
    rootFolderId: rootFolderIdOverride,
    sortFileNodes = defaultSortFileNodes,
  } = options;

  abortSignal?.throwIfAborted();

  if (!rootHandle.path) {
    throw new Error('Root directory handle is missing its canonical path');
  }

  // Storage v5: prefer the durable RootId UUID when provided; fall back to
  // handle.path for callers that have not yet threaded the identity.
  const resolvedRootFolderId = rootFolderIdOverride ?? rootHandle.path;

  // Read immediate children only
  let children: IFileNode[];
  try {
    children = await adapter.readDirectory(rootHandle, {
      includeMetadata,
    });
  } catch (error) {
    abortSignal?.throwIfAborted();
    throw error;
  }

  abortSignal?.throwIfAborted();

  // Filter ignored paths and transform nodes for lazy loading
  const lazyNodes: IFileNode[] = children
    .filter((child) => !fileFilter.shouldIgnorePath(child.name))
    .map((child) => {
      // For directories: omit children to ensure lazy loading triggers
      // (adapters may set children: [], which we need to remove)
      if (child.type === 'directory') {
        const { children: _children, ...rest } = child;
        return {
          ...rest,
          depth: 0,
          loadState: 'unloaded' as const,
          rootFolderId: resolvedRootFolderId,
        };
      }
      // Files: just add depth and rootFolderId
      return {
        ...child,
        depth: 0,
        rootFolderId: resolvedRootFolderId,
      };
    });

  return sortFileNodes(lazyNodes);
}

/**
 * Load children of a specific directory on-demand.
 *
 * Called when user expands a directory. Returns children with
 * subdirectories marked as 'unloaded' for further lazy expansion.
 *
 * @param adapter - File system adapter
 * @param parentNode - The directory node to load children for
 * @param options - Load options
 * @returns Array of child nodes
 */
export async function loadDirectoryChildren(
  adapter: FileSystemAdapter,
  parentNode: IFileNode,
  options: LazyLoadOptions = {}
): Promise<IFileNode[]> {
  if (parentNode.type !== 'directory') {
    throw new Error('Cannot load children of non-directory node');
  }

  const { abortSignal, includeMetadata = false, sortFileNodes = defaultSortFileNodes } = options;

  abortSignal?.throwIfAborted();

  // Build DirectoryHandle from the node
  const handle = buildDirectoryHandle(parentNode, options.parentRootId);

  // Read immediate children only
  let children: IFileNode[];
  try {
    children = await adapter.readDirectory(handle, {
      includeMetadata,
    });
  } catch (error) {
    abortSignal?.throwIfAborted();
    throw error;
  }

  abortSignal?.throwIfAborted();

  // Filter ignored paths and transform nodes for lazy loading
  const lazyNodes: IFileNode[] = children
    .filter((child) => {
      const relativePath = `${parentNode.path}/${child.name}`;
      return !fileFilter.shouldIgnorePath(relativePath);
    })
    .map((child) => {
      // For directories: omit children to ensure lazy loading triggers
      // (adapters may set children: [], which we need to remove)
      if (child.type === 'directory') {
        const { children: _children, ...rest } = child;
        return {
          ...rest,
          depth: parentNode.depth + 1,
          loadState: 'unloaded' as const,
          rootFolderId: parentNode.rootFolderId,
        };
      }
      // Files: just add depth and rootFolderId
      return {
        ...child,
        depth: parentNode.depth + 1,
        rootFolderId: parentNode.rootFolderId,
      };
    });

  return sortFileNodes(lazyNodes);
}

// Re-export generic functions typed for IFileNode for backward compatibility
export function updateNodeChildren(
  tree: IFileNode[],
  targetPath: string,
  children: IFileNode[],
  loadState: DirectoryLoadState = 'loaded'
): IFileNode[] {
  return updateNodeChildrenGeneric(tree, targetPath, children, loadState);
}

export function setNodeLoadState(
  tree: IFileNode[],
  targetPath: string,
  loadState: DirectoryLoadState,
  error?: string
): IFileNode[] {
  return setNodeLoadStateGeneric(tree, targetPath, loadState, error);
}

export function findNodeByPath(tree: IFileNode[], targetPath: string): IFileNode | null {
  return findNodeByPathGeneric(tree, targetPath);
}

export function needsLoading(node: IFileNode): boolean {
  return needsLoadingGeneric(node);
}

export function isLoading(node: IFileNode): boolean {
  return isLoadingGeneric(node);
}

// ============================================================================
// Streaming API (BST-147)
// ============================================================================

/**
 * Callback for receiving streamed directory entries.
 * Receives transformed nodes ready for lazy loading.
 */
export type StreamingLoadCallback = (
  nodes: IFileNode[],
  meta: { done: boolean; total: number }
) => void;

/**
 * Options for streaming directory loads.
 */
export type StreamingLoadOptions = LazyLoadOptions & {
  /** Batch size for streaming (default: 50) */
  batchSize?: number;
};

/**
 * Transform raw nodes from adapter for lazy loading.
 * Directories get loadState: 'unloaded', files get depth/rootFolderId.
 */
function transformNodesForLazyLoading(
  nodes: IFileNode[],
  depth: number,
  rootFolderId: string,
  parentPath?: string
): IFileNode[] {
  return nodes
    .filter((child) => {
      const relativePath = parentPath ? `${parentPath}/${child.name}` : child.name;
      return !fileFilter.shouldIgnorePath(relativePath);
    })
    .map((child) => {
      if (child.type === 'directory') {
        const { children: _children, ...rest } = child;
        return {
          ...rest,
          depth,
          loadState: 'unloaded' as const,
          rootFolderId,
        };
      }
      return {
        ...child,
        depth,
        rootFolderId,
      };
    });
}

/**
 * Load directory children with streaming support (BST-147).
 *
 * If the adapter supports `readDirectoryStreaming`, entries are streamed
 * in batches via the `onBatch` callback. Otherwise, falls back to
 * non-streaming `readDirectory`.
 *
 * @param adapter - File system adapter
 * @param parentNode - The directory node to load children for
 * @param onBatch - Callback for each batch of nodes
 * @param options - Load options including batchSize
 */
export async function loadDirectoryChildrenStreaming(
  adapter: FileSystemAdapter,
  parentNode: IFileNode,
  onBatch: StreamingLoadCallback,
  options: StreamingLoadOptions = {}
): Promise<void> {
  if (parentNode.type !== 'directory') {
    throw new Error('Cannot load children of non-directory node');
  }

  const {
    abortSignal,
    includeMetadata = false,
    sortFileNodes = defaultSortFileNodes,
    batchSize = 50,
  } = options;

  abortSignal?.throwIfAborted();

  const handle = buildDirectoryHandle(parentNode, options.parentRootId);
  const depth = parentNode.depth + 1;
  const rootFolderId = parentNode.rootFolderId;

  // Check if adapter supports streaming
  if (adapter.readDirectoryStreaming) {
    // Use const + push for O(n) accumulation instead of spread which is O(n²)
    const accumulated: IFileNode[] = [];

    await adapter.readDirectoryStreaming(
      handle,
      (nodes, meta) => {
        // Transform nodes for lazy loading
        const transformed = transformNodesForLazyLoading(
          nodes,
          depth,
          rootFolderId,
          parentNode.path
        );

        // In-place accumulation avoids per-batch array reallocation
        for (const node of transformed) {
          accumulated.push(node);
        }

        if (meta.done) {
          // Final batch: emit all accumulated nodes, sorted
          const sorted = sortFileNodes(accumulated);
          onBatch(sorted, { done: true, total: meta.total });
        } else {
          // Intermediate batch: emit only current batch (accumulated used for final sort)
          onBatch(transformed, { done: false, total: meta.total });
        }
      },
      {
        batchSize,
        includeMetadata,
        ...(abortSignal && { signal: abortSignal }),
      }
    );
  } else {
    // Fallback to non-streaming
    const children = await loadDirectoryChildren(adapter, parentNode, options);
    onBatch(children, { done: true, total: children.length });
  }
}

/**
 * Load root directory with streaming support (BST-147).
 *
 * If the adapter supports `readDirectoryStreaming`, entries are streamed
 * in batches via the `onBatch` callback. Otherwise, falls back to
 * non-streaming `readDirectory`.
 *
 * @param adapter - File system adapter
 * @param rootHandle - Root directory handle
 * @param onBatch - Callback for each batch of nodes
 * @param options - Load options including batchSize
 */
export async function loadRootDirectoryStreaming(
  adapter: FileSystemAdapter,
  rootHandle: DirectoryHandle,
  onBatch: StreamingLoadCallback,
  options: StreamingLoadOptions = {}
): Promise<void> {
  if (!rootHandle.path) {
    throw new Error('Root directory handle is missing its canonical path');
  }

  const {
    abortSignal,
    includeMetadata = false,
    rootFolderId: rootFolderIdOverride,
    sortFileNodes = defaultSortFileNodes,
    batchSize = 50,
  } = options;

  // Storage v5: prefer the durable RootId UUID when provided.
  const resolvedRootFolderId = rootFolderIdOverride ?? rootHandle.path;

  abortSignal?.throwIfAborted();

  // Check if adapter supports streaming
  if (adapter.readDirectoryStreaming) {
    // Use const + push for O(n) accumulation instead of spread which is O(n²)
    const accumulated: IFileNode[] = [];

    await adapter.readDirectoryStreaming(
      rootHandle,
      (nodes, meta) => {
        // Transform nodes for lazy loading (depth 0, rootFolderId from RootId)
        const transformed = transformNodesForLazyLoading(nodes, 0, resolvedRootFolderId);

        // In-place accumulation avoids per-batch array reallocation
        for (const node of transformed) {
          accumulated.push(node);
        }

        if (meta.done) {
          // Final batch: emit all accumulated nodes, sorted
          const sorted = sortFileNodes(accumulated);
          onBatch(sorted, { done: true, total: meta.total });
        } else {
          // Intermediate batch: emit only current batch (accumulated used for final sort)
          onBatch(transformed, { done: false, total: meta.total });
        }
      },
      {
        batchSize,
        includeMetadata,
        ...(abortSignal && { signal: abortSignal }),
      }
    );
  } else {
    // Fallback to non-streaming
    const children = await loadRootDirectory(adapter, rootHandle, options);
    onBatch(children, { done: true, total: children.length });
  }
}

/**
 * Check if an adapter supports streaming directory reads.
 */
export function supportsStreaming(adapter: FileSystemAdapter): boolean {
  return typeof adapter.readDirectoryStreaming === 'function';
}
