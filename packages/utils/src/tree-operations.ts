import { fileNodeCollator } from './collator';

/**
 * Tree Operations
 *
 * Generic tree manipulation functions that work with any tree node type
 * following the TreeNode interface. Used by both main thread (IFileNode)
 * and worker thread (WorkerFileNode) code.
 *
 * @module tree-operations
 */

/**
 * Load state for directories
 */
export type DirectoryLoadState = 'unloaded' | 'loading' | 'loaded' | 'error';

/**
 * Minimal type for tree nodes that these operations can work with.
 * Both IFileNode and WorkerFileNode satisfy this type.
 */
export interface TreeNode {
  children?: TreeNode[];
  loadError?: string;
  loadState?: DirectoryLoadState;
  name: string;
  path: string;
  type: 'file' | 'directory' | 'loadMore';
}

const PATH_SEPARATOR_CODE = '/'.charCodeAt(0);

/**
 * Returns true only when targetPath is nested under ancestorPath on a path boundary.
 *
 * Invariant: shared prefixes like `/src/com` and `/src/components` are not treated
 * as ancestor/descendant matches. Keep the cheap guards ahead of `startsWith()` to
 * avoid extra work in the tree traversal hot path.
 */
export function isDescendantPath(targetPath: string, ancestorPath: string): boolean {
  return (
    targetPath.length > ancestorPath.length &&
    targetPath.charCodeAt(ancestorPath.length) === PATH_SEPARATOR_CODE &&
    targetPath.startsWith(ancestorPath)
  );
}

/**
 * Sort nodes: directories first, then alphabetically by name.
 *
 * Uses locale-aware comparison with numeric sorting enabled
 * (e.g., "file2" comes before "file10").
 *
 * @example
 * ```ts
 * const sorted = sortTreeNodes(nodes);
 * // Directories appear first, then files, all alphabetically sorted
 * ```
 */
export function sortTreeNodes<T extends TreeNode>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => {
    // Directories before files
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    // Alphabetical within same type
    // Pre-compiled Intl.Collator is ~40x faster than inline localeCompare
    return fileNodeCollator.compare(a.name, b.name);
  });
}

/**
 * Find a node by path in the tree.
 *
 * Performs O(n) traversal where n is total nodes in tree.
 * Uses path prefix matching for efficient descent.
 *
 * @param tree - Tree to search
 * @param targetPath - Full path to find
 * @returns Found node or null
 *
 * @example
 * ```ts
 * const node = findNodeByPath(tree, '/src/components/Button.tsx');
 * if (node) {
 *   console.log(node.name); // 'Button.tsx'
 * }
 * ```
 */
export function findNodeByPath<T extends TreeNode>(tree: T[], targetPath: string): T | null {
  for (const node of tree) {
    if (node.path === targetPath) {
      return node;
    }

    // Check descendants if this could be an ancestor.
    if (node.children && isDescendantPath(targetPath, node.path)) {
      const found = findNodeByPath(node.children as T[], targetPath);
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
 * A directory needs loading if it's a directory with loadState
 * of 'unloaded' or undefined.
 *
 * @param node - Node to check
 * @returns true if the node needs loading
 */
export function needsLoading<T extends TreeNode>(node: T): boolean {
  return (
    node.type === 'directory' && (node.loadState === 'unloaded' || node.loadState === undefined)
  );
}

/**
 * Check if a directory is currently loading.
 *
 * @param node - Node to check
 * @returns true if the node is in loading state
 */
export function isLoading<T extends TreeNode>(node: T): boolean {
  return node.type === 'directory' && node.loadState === 'loading';
}

/**
 * Check if a node can be loaded (exists, is a directory, and needs loading).
 *
 * Type guard that narrows node to non-null type.
 *
 * @param node - Node to check (may be null/undefined)
 * @returns true if the node can be loaded
 */
export function canLoadNode<T extends TreeNode>(node: T | null | undefined): node is T {
  if (node?.type !== 'directory') {
    return false;
  }
  return node.loadState !== 'loaded' && node.loadState !== 'loading';
}

/**
 * Immutably update a node's children in the tree.
 *
 * Traverses the tree to find the target path and updates its children.
 * Returns a new tree with the update applied immutably - only the path
 * to the modified node gets new references.
 *
 * @param tree - Current tree
 * @param targetPath - Path of the node to update
 * @param children - New children array
 * @param loadState - New load state (defaults to 'loaded')
 * @returns Updated tree with new references for modified branches
 *
 * @example
 * ```ts
 * const newTree = updateNodeChildren(tree, '/src', loadedChildren, 'loaded');
 * ```
 */
export function updateNodeChildren<T extends TreeNode>(
  tree: T[],
  targetPath: string,
  children: T[],
  loadState: DirectoryLoadState = 'loaded'
): T[] {
  return tree.map((node): T => {
    // Found the target node
    if (node.path === targetPath) {
      // Destructure to omit loadError when successfully loaded
      const { loadError: _loadError, ...rest } = node;
      // SAFETY: TypeScript can't prove spread creates valid T due to generic constraints.
      // We know it does since we're reconstructing a valid node with required properties.
      // This is a known limitation of TS generics with spread operators.
      return {
        ...rest,
        children,
        loadState,
      } as unknown as T;
    }

    // Check if target is a descendant of this node.
    if (node.children && isDescendantPath(targetPath, node.path)) {
      return {
        ...node,
        children: updateNodeChildren(node.children as T[], targetPath, children, loadState),
      } as unknown as T;
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
 * @returns Updated tree with new references for modified branches
 *
 * @example
 * ```ts
 * // Set loading state
 * const loadingTree = setNodeLoadState(tree, '/src', 'loading');
 *
 * // Set error state with message
 * const errorTree = setNodeLoadState(tree, '/src', 'error', 'Permission denied');
 * ```
 */
export function setNodeLoadState<T extends TreeNode>(
  tree: T[],
  targetPath: string,
  loadState: DirectoryLoadState,
  error?: string
): T[] {
  return tree.map((node): T => {
    // Found the target node
    if (node.path === targetPath) {
      // Destructure to omit loadError, then conditionally add it back
      const { loadError: _loadError, ...rest } = node;
      // SAFETY: See comment in updateNodeChildren - TS generic spread limitation
      const updated = {
        ...rest,
        loadState,
      } as unknown as T;
      // Only include loadError if error is defined
      if (error !== undefined) {
        (updated as TreeNode).loadError = error;
      }
      return updated;
    }

    // Check if target is a descendant of this node.
    if (node.children && isDescendantPath(targetPath, node.path)) {
      return {
        ...node,
        children: setNodeLoadState(node.children as T[], targetPath, loadState, error),
      } as unknown as T;
    }

    // No change needed for this branch
    return node;
  });
}

/**
 * Collect all directory paths from a tree recursively.
 *
 * Mutates the provided Set for efficiency.
 *
 * @param nodes - Tree nodes to traverse
 * @param paths - Set to collect paths into
 *
 * @example
 * ```ts
 * const paths = new Set<string>();
 * collectDirectoryPaths(tree, paths);
 * console.log(paths.size); // Number of directories
 * ```
 */
export function collectDirectoryPaths<T extends TreeNode>(nodes: T[], paths: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'directory') {
      paths.add(node.path);
      if (node.children) {
        collectDirectoryPaths(node.children as T[], paths);
      }
    }
  }
}

/**
 * Collect all expanded (loaded with children) directory paths.
 *
 * @param tree - Tree to traverse
 * @returns Array of paths for directories that have been loaded
 *
 * @example
 * ```ts
 * const expandedPaths = collectExpandedPaths(tree);
 * // Store these to restore expansion state later
 * ```
 */
export function collectExpandedPaths<T extends TreeNode>(tree: T[]): string[] {
  const paths: string[] = [];

  function traverse(nodes: T[]): void {
    for (const node of nodes) {
      if (node.type === 'directory' && node.loadState === 'loaded' && node.children) {
        paths.push(node.path);
        traverse(node.children as T[]);
      }
    }
  }

  traverse(tree);
  return paths;
}

/**
 * Reset a directory node to unloaded state.
 *
 * Removes children and loadError, sets loadState to 'unloaded'.
 * Non-directories are returned unchanged.
 *
 * @param node - Node to reset
 * @returns Reset node (or unchanged if not a directory)
 */
export function resetDirectoryNode<T extends TreeNode>(node: T): T {
  if (node.type === 'directory') {
    const { children: _children, loadError: _loadError, ...rest } = node;
    // SAFETY: See comment in updateNodeChildren - TS generic spread limitation
    return { ...rest, loadState: 'unloaded' } as unknown as T;
  }
  return node;
}

/**
 * Get the depth of a path (number of path segments).
 *
 * Useful for sorting paths by depth for restoration order.
 *
 * @param path - Path to measure
 * @returns Number of path segments
 *
 * @example
 * ```ts
 * getPathDepth('/src/components/Button.tsx'); // 3
 * getPathDepth('/src'); // 1
 * ```
 */
export function getPathDepth(path: string): number {
  let count = 0;
  let inSegment = false;
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) === PATH_SEPARATOR_CODE) {
      inSegment = false;
    } else if (!inSegment) {
      count++;
      inSegment = true;
    }
  }
  return count;
}
