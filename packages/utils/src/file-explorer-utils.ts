import type { IFileNode } from '@brainstrike/types';
import { defaultCollator } from './collator';
import { getFileExtension as getNormalizedFileExtension } from './file-utils';
import { fileFilter } from './path-filter';

/**
 * Utilities for exploring and manipulating file trees
 */
export const fileExplorer = {
  /**
   * Finds a node in the file tree by its path and optionally root folder ID.
   * Uses DFS with stack (pop is O(1)) instead of BFS with queue (shift is O(n)).
   */
  findNodeByPath(roots: IFileNode[], path: string, rootFolderId?: string): IFileNode | null {
    const stack = [...roots];

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }

      if (node.path === path) {
        // If rootFolderId is provided, ensure it matches
        if (rootFolderId && node.rootFolderId !== rootFolderId) {
          continue;
        }
        return node;
      }

      if (node.type === 'directory' && node.children) {
        // Push children to stack (DFS); push in reverse order to maintain
        // left-to-right traversal if needed, but for path lookup order doesn't matter
        for (const child of node.children) {
          stack.push(child);
        }
      }
    }

    return null;
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
    const filterOptions = {
      excludeFilters,
      includeFilters,
      useRegex,
    };

    const sortNodes = (a: IFileNode, b: IFileNode): number => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return defaultCollator.compare(a.name, b.name);
    };

    const printNode = (node: IFileNode, depth: number): void => {
      const indent = '  '.repeat(depth);
      const prefix = node.type === 'directory' ? '📁 ' : '📄 ';
      lines.push(`${indent}${prefix}${node.name}`);

      if (node.type === 'directory' && node.children) {
        const sortedChildren = [...node.children].sort(sortNodes);

        for (const child of sortedChildren) {
          printNode(child, depth + 1);
        }
      }
    };

    for (const root of fileTree) {
      if (root.type === 'directory' && root.children) {
        const filteredChildren = root.children
          .map((child) => fileFilter.filterNode(child, filterOptions))
          .filter((child): child is IFileNode => child !== null);

        printNode({ ...root, children: filteredChildren }, 0);
        continue;
      }

      printNode(root, 0);
    }

    return lines.join('\n');
  },
  /**
   * Gets all file paths in a directory recursively
   */
  getAllFilePathsInDirectory(node: IFileNode): string[] {
    if (node.type === 'file') {
      return [node.path];
    }
    if (!node.children) {
      return [];
    }

    const allPaths: string[] = [];
    const stack = [...node.children];

    while (stack.length > 0) {
      const currentNode = stack.pop();
      if (!currentNode) {
        continue;
      }

      if (currentNode.type === 'file') {
        allPaths.push(currentNode.path);
      } else if (currentNode.type === 'directory' && currentNode.children) {
        stack.push(...currentNode.children);
      }
    }

    return allPaths;
  },

  /**
   * Gets the extension of a file
   */
  getFileExtension(filePath: string): string {
    return getNormalizedFileExtension(filePath);
  },

  /**
   * Counts files in a directory node
   */
  getFolderFileCount(node: IFileNode): { count: number; isComplete: boolean } {
    if (node.type === 'file') {
      return { count: 1, isComplete: true };
    }
    // A directory's subtree is complete only when the directory itself has
    // finished loading AND every descendant directory has too. Lazily-loaded
    // trees mark pending directories with loadState 'unloaded'/'loading', so a
    // count over an incomplete subtree understates the true total — consumers
    // (e.g. tri-state checkbox derivation) must not treat it as exhaustive.
    const selfComplete = node.loadState === 'loaded';
    if (!node.children) {
      return { count: 0, isComplete: selfComplete };
    }

    let totalCount = 0;
    let isComplete = selfComplete;

    for (const child of node.children) {
      const result = this.getFolderFileCount(child);
      totalCount += result.count;
      isComplete = isComplete && result.isComplete;
    }

    return { count: totalCount, isComplete };
  },
};

/**
 * Create a memoized version of a function that takes a file node
 */
function memoizeByNode<T extends object, R>(fn: (arg: T) => R) {
  const cache = new WeakMap<T, R>();
  return (arg: T): R => {
    const cached = cache.get(arg);
    if (cached !== undefined) {
      return cached;
    }
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
