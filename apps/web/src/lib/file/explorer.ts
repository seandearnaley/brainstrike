import type { IFileNode } from '@brainstrike/types';
import { IGNORED_PATHS } from '../../constants/file-explorer';
import { fileFilter } from '../../lib/utils/filter';
import path from 'path';

/**
 * Utilities for exploring and manipulating file trees
 */
export const fileExplorer = {
  /**
   * Checks if a path should be ignored based on predefined patterns
   */
  shouldIgnorePath(pathString: string): boolean {
    const normalizedPath = path.normalize(pathString).startsWith('/')
      ? path.normalize(pathString).slice(1)
      : path.normalize(pathString);
    return IGNORED_PATHS.some((ignoredPath) =>
      fileFilter.matchWildcard(normalizedPath, ignoredPath)
    );
  },

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
    const queue = [...roots];

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) continue;

      if (node.path === path) {
        // If rootFolderId is provided, ensure it matches
        if (rootFolderId && node.rootFolderId !== rootFolderId) {
          continue;
        }
        return node;
      }

      if (node.type === 'directory' && node.children) {
        queue.push(...node.children);
      }
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

  /**
   * Reads the full file tree recursively from a directory handle
   */
  async readFullFileTree(
    directoryHandle: FileSystemDirectoryHandle,
    parentPath = '',
    depth = 0,
    rootFolderId = directoryHandle.name
  ): Promise<IFileNode[]> {
    const entries: IFileNode[] = [];

    for await (const [name, handle] of directoryHandle.entries()) {
      const path = `${parentPath}/${name}`;
      if (this.shouldIgnorePath(path)) continue;

      if (handle.kind === 'file') {
        entries.push({
          name,
          path,
          depth,
          type: 'file',
          handle: handle as FileSystemFileHandle,
          selectionState: 'unchecked',
          rootFolderId,
        });
      } else if (handle.kind === 'directory') {
        const children = await this.readFullFileTree(
          handle as FileSystemDirectoryHandle,
          path,
          depth + 1,
          rootFolderId
        );
        entries.push({
          name,
          path,
          depth,
          type: 'directory',
          children,
          handle: handle as FileSystemDirectoryHandle,
          selectionState: 'unchecked',
          rootFolderId,
        });
      }
    }
    return entries;
  },
};
