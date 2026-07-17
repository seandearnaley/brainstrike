import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';

/**
 * Electron-style handle with path property for direct file system access.
 * Used when running in Electron environment where files are accessed by path.
 */
export interface ElectronFileHandle {
  kind: 'file';
  name: string;
  path: string;
  platform: 'electron';
}

/**
 * Combined handle information for a file node.
 * Supports both Web File System Access API handles and Electron path-based handles.
 */
export interface HandleInfo {
  /** Electron path-based handle (desktop environment) */
  electronHandle?: ElectronFileHandle;
  /** File name for binary detection and display */
  fileName: string;
  /** File size in bytes (if known) for large file filtering */
  fileSize: number | undefined;
  /** Synthetic handles rely on cached metadata and should stay retryable. */
  isSynthetic?: boolean;
  /** Web File System Access API handle (browser environment) */
  webHandle?: FileSystemFileHandle;
}

/**
 * Statistics about the indexed file tree.
 * Provides O(1) access to tree metrics without traversal.
 */
export interface FileTreeIndexStats {
  /** Total number of directory nodes */
  totalDirectories: number;
  /** Total number of file nodes */
  totalFiles: number;
  /** Total number of nodes (files + directories) in the index */
  totalNodes: number;
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
    totalDirectories: 0,
    totalFiles: 0,
    totalNodes: 0,
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
      totalDirectories: 0,
      totalFiles: 0,
      totalNodes: 0,
    };
  }

  /**
   * Remove ONLY the given folder's entries (Phase 6 forest sharing: multiple
   * FileTreeProviders write into one shared index, so a root switch/disconnect
   * must not wipe sibling roots' entries the way `clear()` would).
   *
   * @param folderId - RootId UUID (or legacy path) whose entries to remove
   */
  clearFolder(folderId: string): void {
    // Prefix matches encodeFileSelection's key shape (folderId|@|path);
    // encodeFileSelection itself rejects an empty path, so build directly.
    const prefix = `${folderId}|@|`;
    for (const [key, node] of this.nodeByKey) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      this.nodeByKey.delete(key);
      this.handleByKey.delete(key);
      this._stats.totalNodes--;
      if (node.type === 'file') {
        this._stats.totalFiles--;
      } else if (node.type === 'directory') {
        this._stats.totalDirectories--;
      }
    }
  }

  /**
   * Extract handle information from a file node.
   * Returns null if the node has no valid handle.
   *
   * @param node - The file node to extract handle info from
   * @returns HandleInfo object or null if no handle
   */
  private extractHandleInfo(node: IFileNode): HandleInfo | null {
    const handle = node.handle;
    if (!handle) {
      return null;
    }

    if (isWebFileHandle(handle)) {
      return {
        fileName: node.name,
        fileSize: node.size,
        webHandle: handle,
      };
    }

    if (isElectronHandle(handle)) {
      return {
        electronHandle: handle,
        fileName: node.name,
        fileSize: node.size,
      };
    }

    return null;
  }

  /**
   * Update statistics when a node is added or updated.
   * Handles new nodes, unchanged updates, and type changes.
   *
   * @param existingNode - The previous node at this key (if any)
   * @param newNode - The new node being added
   */
  private updateStats(existingNode: IFileNode | undefined, newNode: IFileNode): void {
    if (!existingNode) {
      // New node: increment appropriate counter
      if (newNode.type === 'file') {
        this._stats.totalFiles++;
      } else if (newNode.type === 'directory') {
        this._stats.totalDirectories++;
      }
      this._stats.totalNodes++;
      return;
    }

    // Existing node - check for type change
    if (existingNode.type === newNode.type) {
      return; // No change needed
    }

    // Type changed: adjust counters to prevent drift
    // Decrement old type
    if (existingNode.type === 'file') {
      this._stats.totalFiles--;
    } else if (existingNode.type === 'directory') {
      this._stats.totalDirectories--;
    }
    // Increment new type
    if (newNode.type === 'file') {
      this._stats.totalFiles++;
    } else if (newNode.type === 'directory') {
      this._stats.totalDirectories++;
    }
    // Note: totalNodes stays the same since it's still one node
  }

  /**
   * Add nodes to the index, recursively processing children.
   * Updates statistics as nodes are added.
   *
   * @param nodes - Array of file nodes to add
   * @param _parentPath - Parent path (reserved for future use)
   */
  addNodes(nodes: IFileNode[], _parentPath: string | null): void {
    for (const node of nodes) {
      // Skip nodes without rootFolderId as they can't be keyed
      if (!node.rootFolderId) {
        continue;
      }

      // Create unique key for this node
      const key = encodeFileSelection(node.rootFolderId, node.path);

      // Check if node already exists to avoid double-counting stats
      const existingNode = this.nodeByKey.get(key);

      // Add or update node in the map
      this.nodeByKey.set(key, node);

      // Update statistics (handles new nodes, unchanged updates, and type changes)
      this.updateStats(existingNode, node);

      // Extract and store handle info for files (always update, even for existing nodes)
      // If handle extraction fails, delete stale entry to prevent using revoked/invalid handles
      if (node.type === 'file') {
        const handleInfo = this.extractHandleInfo(node);
        if (handleInfo) {
          this.handleByKey.set(key, handleInfo);
        } else {
          // Delete stale handle - node was re-added without a valid handle
          this.handleByKey.delete(key);
        }
      } else {
        // Directories don't have handles - clean up if previously misclassified
        this.handleByKey.delete(key);
      }

      // Recursively process children if present
      if (node.children && node.children.length > 0) {
        this.addNodes(node.children, node.path);
      }
    }
  }

  /**
   * Get a node by folder ID and path.
   * Provides O(1) lookup using the encoded key.
   *
   * @param folderId - The root folder ID
   * @param path - The file path within the folder
   * @returns The file node or undefined if not found
   */
  getNode(folderId: string, path: string): IFileNode | undefined {
    const key = encodeFileSelection(folderId, path);
    return this.nodeByKey.get(key);
  }

  /**
   * Get handle information by folder ID and path.
   * Provides O(1) lookup for file handles.
   *
   * @param folderId - The root folder ID
   * @param path - The file path within the folder
   * @returns The handle info or undefined if not found
   */
  getHandle(folderId: string, path: string): HandleInfo | undefined {
    const key = encodeFileSelection(folderId, path);
    return this.handleByKey.get(key);
  }
}
