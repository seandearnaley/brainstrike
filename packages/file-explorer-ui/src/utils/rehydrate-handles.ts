/**
 * Handle Rehydration Utility
 *
 * Reattaches FileSystemHandle objects to cached tree nodes.
 * Cached trees lose handles because they can't be serialized to IndexedDB.
 * This utility re-traverses the file system to restore handles.
 */

import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/file-system';

export type RehydrateOptions = {
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal | undefined;
  /** Optional callback for progress updates */
  onProgress?: ((path: string) => void) | undefined;
};

/**
 * Rehydrates handles for a cached tree by re-traversing the file system.
 *
 * This function walks the directory structure using the file system adapter
 * and matches paths from the cached tree, attaching fresh handles to each node.
 * The tree structure itself is preserved - only handles are updated.
 *
 * @param fileSystemAdapter - The file system adapter to use
 * @param rootHandle - The root directory handle to start from
 * @param cachedTree - The cached tree nodes without handles
 * @param options - Optional configuration for rehydration
 * @returns Promise resolving to the tree with handles attached
 */
export async function rehydrateHandles(
  fileSystemAdapter: FileSystemAdapter,
  rootHandle: DirectoryHandle,
  cachedTree: IFileNode[],
  options: RehydrateOptions = {}
): Promise<IFileNode[]> {
  const { abortSignal, onProgress } = options;

  // Build a map of path -> handle for efficient lookups
  const handleMap = new Map<string, FileSystemFileHandle | FileSystemDirectoryHandle>();

  // Traverse file system to collect handles
  await populateHandleMap(fileSystemAdapter, rootHandle, handleMap, abortSignal, onProgress);

  // Attach handles to cached nodes
  return attachHandlesToTree(cachedTree, handleMap);
}

/**
 * Populates a map of path -> handle by traversing the file system.
 */
async function populateHandleMap(
  adapter: FileSystemAdapter,
  dirHandle: DirectoryHandle,
  handleMap: Map<string, FileSystemFileHandle | FileSystemDirectoryHandle>,
  abortSignal?: AbortSignal,
  onProgress?: (path: string) => void
): Promise<void> {
  if (abortSignal?.aborted) {
    return;
  }

  onProgress?.(dirHandle.path);

  // Read directory contents - this returns IFileNode[] with handles attached
  const entries = await adapter.readDirectory(dirHandle);

  for (const entry of entries) {
    if (abortSignal?.aborted) {
      return;
    }

    // Store the handle from the fresh node
    handleMap.set(entry.path, entry.handle);
    onProgress?.(entry.path);

    // Recursively process directories
    if (entry.type === 'directory' && entry.children) {
      // For directories that were expanded, process their children too
      const childDirHandle = toDirectoryHandle(entry);
      await populateHandleMap(adapter, childDirHandle, handleMap, abortSignal, onProgress);
    }
  }
}

/**
 * Converts an IFileNode to a DirectoryHandle for recursive traversal.
 */
function toDirectoryHandle(node: IFileNode): DirectoryHandle {
  return {
    path: node.path,
    name: node.name,
    kind: 'directory',
    platform: 'web', // This is used internally, actual platform is determined by adapter
    _internal: node.handle,
  };
}

/**
 * Attaches handles from the map to tree nodes by matching paths.
 */
function attachHandlesToTree(
  nodes: IFileNode[],
  handleMap: Map<string, FileSystemFileHandle | FileSystemDirectoryHandle>
): IFileNode[] {
  return nodes.map((node) => {
    const handle = handleMap.get(node.path);

    const rehydrated: IFileNode = {
      ...node,
      handle: handle ?? node.handle,
    };

    if (node.children) {
      rehydrated.children = attachHandlesToTree(node.children, handleMap);
    }

    return rehydrated;
  });
}
