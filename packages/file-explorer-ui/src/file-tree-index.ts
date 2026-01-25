import type { IFileNode } from '@brainstrike/types';

/**
 * Electron-style handle with path property for direct file system access.
 * Used when running in Electron environment where files are accessed by path.
 */
export interface ElectronFileHandle {
  path: string;
  name: string;
  kind: 'file';
  platform: 'electron';
}

/**
 * Combined handle information for a file node.
 * Supports both Web File System Access API handles and Electron path-based handles.
 */
export interface HandleInfo {
  /** Web File System Access API handle (browser environment) */
  webHandle?: FileSystemFileHandle;
  /** Electron path-based handle (desktop environment) */
  electronHandle?: ElectronFileHandle;
  /** File name for binary detection and display */
  fileName: string;
  /** File size in bytes (if known) for large file filtering */
  fileSize: number | undefined;
}

/**
 * Statistics about the indexed file tree.
 * Provides O(1) access to tree metrics without traversal.
 */
export interface FileTreeIndexStats {
  /** Total number of nodes (files + directories) in the index */
  totalNodes: number;
  /** Total number of file nodes */
  totalFiles: number;
  /** Total number of directory nodes */
  totalDirectories: number;
}

/**
 * Type guard to check if a handle is an Electron handle with path property.
 *
 * @param handle - The handle to check
 * @returns True if the handle is an ElectronFileHandle
 */
export function isElectronHandle(handle: unknown): handle is ElectronFileHandle {
  return (
    handle !== null &&
    typeof handle === 'object' &&
    'platform' in handle &&
    (handle as ElectronFileHandle).platform === 'electron' &&
    'path' in handle &&
    typeof (handle as ElectronFileHandle).path === 'string'
  );
}

/**
 * Type guard to check if a handle is a Web FileSystemFileHandle.
 *
 * @param handle - The handle to check
 * @returns True if the handle is a FileSystemFileHandle
 */
export function isWebFileHandle(handle: unknown): handle is FileSystemFileHandle {
  return (
    handle !== null &&
    typeof handle === 'object' &&
    'getFile' in handle &&
    typeof (handle as FileSystemFileHandle).getFile === 'function'
  );
}

/**
 * Centralized index for file tree nodes and handles.
 *
 * This class provides O(1) lookups for nodes and handles by key,
 * eliminating the need for expensive O(N) tree traversals.
 * It maintains accurate statistics about the indexed tree structure.
 *
 * @example
 * ```typescript
 * const index = new FileTreeIndex();
 *
 * // Add nodes from tree traversal
 * index.addNodes(fileTree);
 *
 * // O(1) lookups
 * const node = index.getNode('/path/to/file.ts');
 * const handle = index.getHandle('/path/to/file.ts');
 *
 * // Access stats without traversal
 * console.log(index.stats.totalFiles);
 * ```
 */
export class FileTreeIndex {
  /** Map of node keys to file nodes for O(1) lookups */
  private readonly nodeByKey = new Map<string, IFileNode>();

  /** Map of node keys to handle information for O(1) handle access */
  private readonly handleByKey = new Map<string, HandleInfo>();

  /** Cached statistics about the indexed tree */
  private _stats: FileTreeIndexStats = {
    totalNodes: 0,
    totalFiles: 0,
    totalDirectories: 0,
  };

  /**
   * Get current statistics about the indexed tree.
   * Returns a copy to prevent external mutation.
   */
  get stats(): FileTreeIndexStats {
    return { ...this._stats };
  }

  /**
   * Clear all indexed data and reset statistics.
   * Call this when the file tree is being replaced entirely.
   */
  clear(): void {
    this.nodeByKey.clear();
    this.handleByKey.clear();
    this._stats = {
      totalNodes: 0,
      totalFiles: 0,
      totalDirectories: 0,
    };
  }
}
