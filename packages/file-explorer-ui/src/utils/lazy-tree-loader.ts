/**
 * Lazy Tree Loader Utilities
 *
 * Provides functions for on-demand directory loading. Instead of loading
 * the entire file tree upfront, directories are loaded when expanded.
 */

import type {
  DirectoryHandle,
  DirectoryLoadState,
  FileSystemAdapter,
  IFileNode,
} from '@brainstrike/types';
import { fileFilter } from '@brainstrike/utils';

export type LazyLoadOptions = {
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal;
  /** Whether to include file metadata (size, lastModified) */
  includeMetadata?: boolean;
  /** Custom sort function for nodes */
  sortFileNodes?: (nodes: IFileNode[]) => IFileNode[];
};

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
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
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
function buildDirectoryHandle(node: IFileNode): DirectoryHandle {
  return {
    path: node.path,
    name: node.name,
    kind: 'directory',
    platform: detectPlatform(node.handle),
    _internal: node.handle,
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
  const { abortSignal, includeMetadata = false, sortFileNodes = defaultSortFileNodes } = options;

  // Check for cancellation
  if (abortSignal?.aborted) {
    throw new DOMException('Operation was cancelled', 'AbortError');
  }

  // Read immediate children only
  const children = await adapter.readDirectory(rootHandle, {
    includeMetadata,
  });

  // Check for cancellation after async operation
  if (abortSignal?.aborted) {
    throw new DOMException('Operation was cancelled', 'AbortError');
  }

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
          rootFolderId: rootHandle.name,
          loadState: 'unloaded' as const,
        };
      }
      // Files: just add depth and rootFolderId
      return {
        ...child,
        depth: 0,
        rootFolderId: rootHandle.name,
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

  // Check for cancellation
  if (abortSignal?.aborted) {
    throw new DOMException('Operation was cancelled', 'AbortError');
  }

  // Build DirectoryHandle from the node
  const handle = buildDirectoryHandle(parentNode);

  // Read immediate children only
  const children = await adapter.readDirectory(handle, {
    includeMetadata,
  });

  // Check for cancellation after async operation
  if (abortSignal?.aborted) {
    throw new DOMException('Operation was cancelled', 'AbortError');
  }

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
          rootFolderId: parentNode.rootFolderId,
          loadState: 'unloaded' as const,
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

/**
 * Immutably update a node's children in the tree.
 *
 * Traverses the tree to find the target path and updates its children.
 * Returns a new tree with the update applied immutably.
 *
 * @param tree - Current tree
 * @param targetPath - Path of the node to update
 * @param children - New children array
 * @param loadState - New load state (defaults to 'loaded')
 * @returns Updated tree (new references for modified branches)
 */
export function updateNodeChildren(
  tree: IFileNode[],
  targetPath: string,
  children: IFileNode[],
  loadState: DirectoryLoadState = 'loaded'
): IFileNode[] {
  return tree.map((node): IFileNode => {
    // Found the target node
    if (node.path === targetPath) {
      // Destructure to omit loadError when successfully loaded
      const { loadError: _loadError, ...rest } = node;
      return {
        ...rest,
        children,
        loadState,
      };
    }

    // Check if target is a descendant of this node
    if (targetPath.startsWith(`${node.path}/`) && node.children) {
      return {
        ...node,
        children: updateNodeChildren(node.children, targetPath, children, loadState),
      };
    }

    // No change needed for this branch
    return node;
  });
}

/**
 * Set loading state for a directory without changing its children.
 *
 * Used to show loading spinners or error states.
 *
 * @param tree - Current tree
 * @param targetPath - Path of the node to update
 * @param loadState - New load state
 * @param error - Optional error message (for 'error' state)
 * @returns Updated tree
 */
export function setNodeLoadState(
  tree: IFileNode[],
  targetPath: string,
  loadState: DirectoryLoadState,
  error?: string
): IFileNode[] {
  return tree.map((node): IFileNode => {
    // Found the target node
    if (node.path === targetPath) {
      // Destructure to omit loadError, then conditionally add it back
      const { loadError: _loadError, ...rest } = node;
      const updated: IFileNode = {
        ...rest,
        loadState,
      };
      // Only include loadError if error is defined
      if (error !== undefined) {
        updated.loadError = error;
      }
      return updated;
    }

    // Check if target is a descendant of this node
    if (targetPath.startsWith(`${node.path}/`) && node.children) {
      return {
        ...node,
        children: setNodeLoadState(node.children, targetPath, loadState, error),
      };
    }

    // No change needed for this branch
    return node;
  });
}

/**
 * Find a node by path in the tree.
 *
 * @param tree - Tree to search
 * @param targetPath - Path to find
 * @returns Found node or null
 */
export function findNodeByPath(tree: IFileNode[], targetPath: string): IFileNode | null {
  for (const node of tree) {
    if (node.path === targetPath) {
      return node;
    }

    // Check descendants if this could be an ancestor
    if (targetPath.startsWith(`${node.path}/`) && node.children) {
      const found = findNodeByPath(node.children, targetPath);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

/**
 * Check if a directory needs to be loaded.
 *
 * @param node - Node to check
 * @returns true if the node is a directory that hasn't been loaded
 */
export function needsLoading(node: IFileNode): boolean {
  return (
    node.type === 'directory' && (node.loadState === 'unloaded' || node.loadState === undefined)
  );
}

/**
 * Check if a directory is currently loading.
 *
 * @param node - Node to check
 * @returns true if the node is loading
 */
export function isLoading(node: IFileNode): boolean {
  return node.type === 'directory' && node.loadState === 'loading';
}
