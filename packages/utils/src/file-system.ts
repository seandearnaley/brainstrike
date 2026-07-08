import type { IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { stableHash } from './hash-utils';
import { calculatePathDepth } from './path-utils';

interface ExperimentalFileSystemFeatures {
  getParent: () => Promise<FileSystemHandle | null>;
  isSameEntry: (other: FileSystemHandle) => Promise<boolean>;
}

// Custom error types for file system operations
export class BrainStrikeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public override readonly cause?: Error
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

const logger = createLogger('FileSystem');

const fileSystemCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Core file system operations and utilities
 */
export const fileSystem = {
  /**
   * Creates a file node from a file system handle
   */
  async createFileNode(
    handle: FileSystemHandle,
    parentPath = '',
    rootHandle?: FileSystemDirectoryHandle
  ): Promise<IFileNode> {
    const path = parentPath ? `${parentPath}/${handle.name}` : handle.name;
    const rootDir =
      rootHandle ||
      (handle.kind === 'directory' ? (handle as FileSystemDirectoryHandle) : undefined);
    const rootFolderId = rootDir ? await this.generateUniqueFolderId(rootDir) : 'root';

    if (handle.kind === 'file') {
      const fileHandle = handle as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      return {
        // Avoid split allocation while recursively building large file trees.
        depth: calculatePathDepth(parentPath) + 1,
        handle: fileHandle,
        lastModified: file.lastModified,
        name: handle.name,
        path,
        rootFolderId,
        selectionState: 'unchecked',
        size: file.size,
        type: 'file',
      };
    }

    // Handle directory
    const dirHandle = handle as FileSystemDirectoryHandle;
    const children: IFileNode[] = [];

    try {
      for await (const [, childHandle] of dirHandle.entries()) {
        const child = await this.createFileNode(childHandle, path, rootHandle || dirHandle);
        children.push(child);
      }
    } catch (error) {
      throw new BrainStrikeError(
        'CREATE_FILE_NODE_FAILED',
        'Failed to create file node',
        error instanceof Error ? error : undefined
      );
    }

    return {
      children: children.sort((a, b) => fileSystemCollator.compare(a.name, b.name)),
      // Avoid split allocation while recursively building large file trees.
      depth: calculatePathDepth(parentPath) + 1,
      handle: dirHandle,
      name: handle.name,
      path,
      rootFolderId,
      selectionState: 'unchecked',
      type: 'directory',
    };
  },

  /**
   * Generates a unique folder ID that takes into account the full path
   * to avoid collisions between folders with the same name but different paths.
   * Falls back to simpler strategies if advanced features are not available.
   */
  async generateUniqueFolderId(handle: FileSystemDirectoryHandle): Promise<string> {
    // Try to get the full path first
    try {
      const pathSegments: string[] = [handle.name];
      let current = handle as unknown as ExperimentalFileSystemFeatures & FileSystemDirectoryHandle;
      const visitedHandles = new Set<FileSystemHandle>();
      visitedHandles.add(handle);

      // Build path by traversing parents, handling circular references
      while (true) {
        try {
          const parent = await current.getParent();
          if (!parent) {
            break; // Root reached
          }

          // Check for circular references
          if (visitedHandles.has(parent)) {
            break;
          }
          visitedHandles.add(parent);

          pathSegments.unshift(parent.name);
          current = parent as unknown as ExperimentalFileSystemFeatures & FileSystemDirectoryHandle;
        } catch (error) {
          logger.debug('getParent failed while generating folder id, using fallback path segment', {
            error,
            handleName: handle.name,
          });
          // If getParent fails, try to use just the handle name with a prefix
          const fallbackPath = `root/${handle.name}`;
          return `h${await stableHash(fallbackPath)}`;
        }
      }

      // Join path segments and hash
      const fullPath = pathSegments.join('/');
      return `h${await stableHash(fullPath)}`;
    } catch (error) {
      logger.warn('Failed to traverse directory tree while generating folder id', {
        error,
        handleName: handle.name,
      });
      return `h${await stableHash(`fallback/${handle.name}_${Date.now()}`)}`;
    }
  },

  /**
   * Gets the full path of a directory handle by traversing parents
   */
  async getFullPath(handle: FileSystemDirectoryHandle): Promise<string> {
    const parts: string[] = [handle.name];
    let current = handle as unknown as ExperimentalFileSystemFeatures & FileSystemDirectoryHandle;

    while (current && 'getParent' in current) {
      try {
        const parent = await current.getParent();
        if (parent && 'name' in parent) {
          parts.unshift(parent.name);
          current = parent as unknown as ExperimentalFileSystemFeatures & FileSystemDirectoryHandle;
        } else {
          break;
        }
      } catch (_error) {
        throw new BrainStrikeError(
          'GET_FULL_PATH_FAILED',
          'Failed to get full path of directory',
          _error instanceof Error ? _error : undefined
        );
      }
    }

    return parts.join('/');
  },
  /**
   * Checks if two directory handles point to the same folder
   * Uses multiple strategies to handle various edge cases and API availability
   */
  async isSameDirectory(
    handle1: FileSystemDirectoryHandle,
    handle2: FileSystemDirectoryHandle
  ): Promise<boolean> {
    // First try the native isSameEntry API if available
    if ('isSameEntry' in handle1) {
      try {
        return await (handle1 as unknown as ExperimentalFileSystemFeatures).isSameEntry(handle2);
      } catch (error) {
        logger.warn('isSameEntry API failed, falling back to path comparison', { error });
      }
    }

    // Fall back to comparing paths if getParent is available
    if ('getParent' in handle1 && 'getParent' in handle2) {
      try {
        const path1 = await this.getFullPath(handle1);
        const path2 = await this.getFullPath(handle2);
        return path1 === path2;
      } catch (error) {
        throw new BrainStrikeError(
          'Failed to compare directory paths',
          'isSameDirectory',
          error instanceof Error ? error : undefined
        );
      }
    }

    // Last resort: compare handle names (not reliable for all cases)
    return handle1.name === handle2.name;
  },

  /**
   * Read the content of a file handle as text
   */
  async readFileContent(fileHandle: FileSystemFileHandle): Promise<string> {
    const file = await fileHandle.getFile();

    // Try text() first, fallback to arrayBuffer if not available
    try {
      return await file.text();
    } catch (error) {
      logger.debug('Failed to read file via text(), falling back to arrayBuffer', {
        error,
        fileName: file.name,
      });
      try {
        const arrayBuffer = await file.arrayBuffer();
        // Ensure we're using a proper TextDecoder instance
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(new Uint8Array(arrayBuffer));
      } catch (innerError) {
        throw new BrainStrikeError(
          'READ_FILE_CONTENT_FAILED',
          'Failed to read file content',
          innerError instanceof Error ? innerError : undefined
        );
      }
    }
  },
};
