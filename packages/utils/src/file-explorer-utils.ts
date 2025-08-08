import type { IFileNode } from '@brainstrike/types';
import { fileFilter } from './path-filter';

// Build and cache an index for fast O(1) path lookups per tree instance
type FileNodeIndex = Map<string, Map<string, IFileNode>>; // folderId -> (path -> node)
const treeToIndex = new WeakMap<IFileNode[], FileNodeIndex>();

function buildFileNodeIndex(roots: IFileNode[]): FileNodeIndex {
  const index: FileNodeIndex = new Map();

  const addToIndex = (node: IFileNode) => {
    const folderId = node.rootFolderId;
    let folderMap = index.get(folderId);
    if (!folderMap) {
      folderMap = new Map<string, IFileNode>();
      index.set(folderId, folderMap);
    }
    folderMap.set(node.path, node);
  };

  const stack: IFileNode[] = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    addToIndex(current);
    if (current.type === 'directory' && current.children && current.children.length > 0) {
      for (const child of current.children) {
        stack.push(child);
      }
    }
  }

  return index;
}

/**
 * Ensures the index for a given tree is built and cached.
 */
export function primeFileNodeIndex(roots: IFileNode[]): void {
  if (!treeToIndex.has(roots)) {
    const index = buildFileNodeIndex(roots);
    treeToIndex.set(roots, index);
  }
}

/**
 * Invalidates the cached index for a given tree (use if the same array instance
 * is structurally mutated or paths change). Typically unnecessary if you replace
 * the tree array, since WeakMap keys are by identity.
 */
export function invalidateFileNodeIndex(roots: IFileNode[]): void {
  treeToIndex.delete(roots);
}

/**
 * Utilities for exploring and manipulating file trees
 */
export const fileExplorer = {
  /**
   * Gets all file paths in a directory recursively
   */
  getAllFilePathsInDirectory(node: IFileNode): string[] {
    if (node.type === 'file') return [node.path];
    if (!node.children) return [];

    const allPaths: string[] = [];
    const stack = [...node.children];

    while (stack.length > 0) {
      const currentNode = stack.pop();
      if (!currentNode) continue;

      if (currentNode.type === 'file') {
        allPaths.push(currentNode.path);
      } else if (currentNode.type === 'directory' && currentNode.children) {
        stack.push(...currentNode.children);
      }
    }

    return allPaths;
  },

  /**
   * Finds a node in the file tree by its path and optionally root folder ID
   */
  findNodeByPath(roots: IFileNode[], path: string, rootFolderId?: string): IFileNode | null {
    // Fast path: use cached index per tree
    let index = treeToIndex.get(roots);
    if (!index) {
      index = buildFileNodeIndex(roots);
      treeToIndex.set(roots, index);
    }

    if (rootFolderId) {
      const folderMap = index.get(rootFolderId);
      return folderMap?.get(path) ?? null;
    }

    // Fallback: if no folderId provided, check all folder maps
    for (const [, folderMap] of index) {
      const found = folderMap.get(path);
      if (found) return found;
    }
    return null;
  },

  /**
   * Gets the extension of a file
   */
  getFileExtension(filePath: string): string {
    const lastDotIndex = filePath.lastIndexOf('.');
    return lastDotIndex > -1 ? filePath.slice(lastDotIndex) : '';
  },

  /**
   * Counts files in a directory node
   */
  getFolderFileCount(node: IFileNode): { count: number; isComplete: boolean } {
    if (node.type === 'file') return { count: 1, isComplete: true };
    if (!node.children) return { count: 0, isComplete: true };

    let totalCount = 0;
    let isComplete = true;

    for (const child of node.children) {
      const result = this.getFolderFileCount(child);
      totalCount += result.count;
      isComplete = isComplete && result.isComplete;
    }

    return { count: totalCount, isComplete };
  },

  /**
   * Generates a text representation of the folder tree
   */
  generateFullFolderTreeText(
    fileTree: IFileNode[],
    includeFilters: string[],
    excludeFilters: string[],
    useRegex: boolean
  ): string {
    const lines: string[] = [];

    const traverse = (node: IFileNode, depth: number) => {
      const indent = '  '.repeat(depth);
      const prefix = node.type === 'directory' ? '📁 ' : '📄 ';
      lines.push(`${indent}${prefix}${node.name}`);

      if (node.type === 'directory' && node.children) {
        const filteredChildren = node.children
          .map((child) =>
            fileFilter.filterNode(child, {
              includeFilters,
              excludeFilters,
              useRegex,
            })
          )
          .filter((child): child is IFileNode => child !== null)
          .sort((a, b) => {
            if (a.type !== b.type) {
              return a.type === 'directory' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
          });

        for (const child of filteredChildren) {
          traverse(child, depth + 1);
        }
      }
    };

    for (const root of fileTree) {
      traverse(root, 0);
    }

    return lines.join('\n');
  },
};

/**
 * Create a memoized version of a function that takes a file node
 */
function memoizeByNode<T extends object, R>(fn: (arg: T) => R) {
  const cache = new WeakMap<T, R>();
  return (arg: T): R => {
    const cached = cache.get(arg);
    if (cached !== undefined) return cached;
    const result = fn(arg);
    cache.set(arg, result);
    return result;
  };
}

export const memoizedFileExplorer = {
  getAllFilePathsInDirectory: memoizeByNode<IFileNode, string[]>(
    fileExplorer.getAllFilePathsInDirectory.bind(fileExplorer)
  ),
  getFolderFileCount: memoizeByNode<IFileNode, { count: number; isComplete: boolean }>(
    fileExplorer.getFolderFileCount.bind(fileExplorer)
  ),
};
