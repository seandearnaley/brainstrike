/**
 * Tree Operations
 *
 * Pure functions for tree manipulation that run in the worker.
 * These are CPU-bound operations moved off the main thread.
 */

import type { BatchLoadResult, DirectoryLoadState, WorkerFileNode } from './types';

/**
 * Sort nodes: directories first, then alphabetically.
 */
export function sortFileNodes(nodes: WorkerFileNode[]): WorkerFileNode[] {
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
 * Find a node by path in the tree.
 * O(n) where n is total nodes in tree.
 */
export function findNodeByPath(tree: WorkerFileNode[], targetPath: string): WorkerFileNode | null {
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
 */
export function needsLoading(node: WorkerFileNode): boolean {
  return (
    node.type === 'directory' && (node.loadState === 'unloaded' || node.loadState === undefined)
  );
}

/**
 * Immutably update a node's children in the tree.
 * Returns a new tree with the update applied.
 */
export function updateNodeChildren(
  tree: WorkerFileNode[],
  targetPath: string,
  children: WorkerFileNode[],
  loadState: DirectoryLoadState = 'loaded'
): WorkerFileNode[] {
  return tree.map((node): WorkerFileNode => {
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
 */
export function setNodeLoadState(
  tree: WorkerFileNode[],
  targetPath: string,
  loadState: DirectoryLoadState,
  error?: string
): WorkerFileNode[] {
  return tree.map((node): WorkerFileNode => {
    // Found the target node
    if (node.path === targetPath) {
      // Destructure to omit loadError, then conditionally add it back
      const { loadError: _loadError, ...rest } = node;
      const updated: WorkerFileNode = {
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
 * Collect all directory paths from a tree recursively.
 */
export function collectDirectoryPaths(nodes: WorkerFileNode[], paths: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'directory') {
      paths.add(node.path);
      if (node.children) {
        collectDirectoryPaths(node.children, paths);
      }
    }
  }
}

/**
 * Get directories that need loading from a wave of paths.
 */
export function getUnloadedDirectories(
  currentWave: Set<string>,
  processed: Set<string>,
  tree: WorkerFileNode[]
): string[] {
  const toLoad: string[] = [];
  for (const path of currentWave) {
    if (processed.has(path)) {
      continue;
    }
    processed.add(path);
    const node = findNodeByPath(tree, path);
    if (node?.type === 'directory' && needsLoading(node)) {
      toLoad.push(path);
    }
  }
  return toLoad;
}

/**
 * Discover child directories from loaded nodes.
 */
export function discoverChildDirectories(
  currentWave: Set<string>,
  processed: Set<string>,
  tree: WorkerFileNode[]
): { nextWave: Set<string>; newCount: number } {
  const nextWave = new Set<string>();
  let newCount = 0;
  for (const path of currentWave) {
    const node = findNodeByPath(tree, path);
    if (node?.children) {
      for (const child of node.children) {
        if (child.type === 'directory' && !processed.has(child.path)) {
          nextWave.add(child.path);
          newCount++;
        }
      }
    }
  }
  return { nextWave, newCount };
}

/**
 * Apply batch results to the tree.
 */
export function applyBatchResultsToTree(
  tree: WorkerFileNode[],
  results: BatchLoadResult[]
): WorkerFileNode[] {
  let newTree = tree;
  for (const result of results) {
    if (result.children) {
      newTree = updateNodeChildren(newTree, result.path, result.children, 'loaded');
    } else if (result.error) {
      newTree = setNodeLoadState(newTree, result.path, 'error', result.error);
    }
  }
  return newTree;
}

/**
 * Check if a node can be loaded (exists, is a directory, and needs loading).
 */
export function canLoadNode(node: WorkerFileNode | null | undefined): node is WorkerFileNode {
  if (!node || node.type !== 'directory') {
    return false;
  }
  return node.loadState !== 'loaded' && node.loadState !== 'loading';
}

/**
 * Collect all expanded paths from the tree.
 */
export function collectExpandedPaths(tree: WorkerFileNode[]): string[] {
  const paths: string[] = [];

  function traverse(nodes: WorkerFileNode[]): void {
    for (const node of nodes) {
      if (node.type === 'directory' && node.loadState === 'loaded' && node.children) {
        paths.push(node.path);
        traverse(node.children);
      }
    }
  }

  traverse(tree);
  return paths;
}
