import type { IFileNode } from '@brainstrike/types';
import { AccessError } from '../errors';
import type {
  DirectoryHandle,
  DirectoryReadOptions,
  DirectoryStreamCallback,
  FileHandle,
  FileSystemAdapter,
  StreamingDirectoryReadOptions,
} from '../types';
import {
  isFileSystemDirectoryHandle,
  isFileSystemFileHandle,
  normalizeDirectoryReadOptions,
} from '../utils';
import { type HandleCache, type StoredRootHandle, WebHandleCache } from './web-handle-cache';

// Type declarations for File System Access API
declare global {
  interface Window {
    showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
  }

  interface FileSystemDirectoryHandle extends FileSystemHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    readonly kind: 'directory';
    readonly name: string;
  }

  interface FileSystemFileHandle extends FileSystemHandle {
    getFile(): Promise<File>;
    readonly kind: 'file';
    readonly name: string;
  }

  interface FileSystemHandle {
    readonly kind: 'file' | 'directory';
    readonly name: string;
    queryPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
    requestPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
  }

  interface FileSystemPermissionDescriptor {
    mode?: 'read' | 'readwrite';
  }
}

// limiter shared via utils

/**
 * Create a directory node from a FileSystemDirectoryHandle.
 * Helper to reduce complexity in readDirectoryStreaming.
 */
function createDirectoryNode(
  name: string,
  parentPath: string,
  entryHandle: FileSystemDirectoryHandle,
  parentHandleName: string
): IFileNode {
  return {
    name,
    path: `${parentPath}/${name}`,
    type: 'directory',
    handle: entryHandle,
    depth: 0,
    selectionState: 'unchecked',
    children: [],
    rootFolderId: parentHandleName,
    isVisible: true,
  };
}

/**
 * Create a file node from a FileSystemFileHandle.
 * Optionally includes metadata (size, lastModified).
 * Helper to reduce complexity in readDirectoryStreaming.
 */
async function createFileNode(
  name: string,
  parentPath: string,
  fileHandle: FileSystemFileHandle,
  parentHandleName: string,
  includeMetadata: boolean
): Promise<IFileNode> {
  const baseNode: IFileNode = {
    name,
    path: `${parentPath}/${name}`,
    type: 'file',
    handle: fileHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: parentHandleName,
    isVisible: true,
  };

  if (!includeMetadata) {
    return baseNode;
  }

  try {
    const file = await fileHandle.getFile();
    return {
      ...baseNode,
      size: file.size,
      lastModified: file.lastModified,
    };
  } catch {
    // Fallback to basic node if getFile fails
    return baseNode;
  }
}

export interface WebFileSystemAdapterOptions {
  handleCache?: HandleCache;
}

export class WebFileSystemAdapter implements FileSystemAdapter {
  public readonly platform = 'web' as const;
  private readonly handleCache: HandleCache;
  private lastRootFolderId: string | null = null;

  constructor(options?: WebFileSystemAdapterOptions) {
    this.handleCache = options?.handleCache ?? new WebHandleCache();
  }

  getHandleCache(): HandleCache {
    return this.handleCache;
  }

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API not supported');
    }

    const dirHandle = await window.showDirectoryPicker();
    try {
      await this.handleCache.storeRootHandle(dirHandle.name, dirHandle);
      this.lastRootFolderId = dirHandle.name;
    } catch {
      // Best-effort persistence; ignore failures.
    }

    return {
      path: dirHandle.name, // Web API doesn't give full path for security
      name: dirHandle.name,
      kind: 'directory',
      platform: 'web',
      _internal: dirHandle,
    };
  }

  async readDirectory(
    handle: DirectoryHandle,
    options?: DirectoryReadOptions
  ): Promise<IFileNode[]> {
    const dirHandle = handle._internal;
    if (!isFileSystemDirectoryHandle(dirHandle)) {
      throw new AccessError('Invalid directory handle', handle.path, 'read');
    }
    const { includeMetadata, limiter } = normalizeDirectoryReadOptions(options);

    const dirNodes: IFileNode[] = [];
    const fileWorks: Promise<IFileNode | null>[] = [];

    for await (const [name, entryHandle] of dirHandle.entries()) {
      if (entryHandle.kind === 'directory') {
        dirNodes.push({
          name,
          path: `${handle.path}/${name}`,
          type: 'directory',
          handle: entryHandle as FileSystemDirectoryHandle,
          depth: 0, // This should be calculated by the caller
          selectionState: 'unchecked',
          children: [], // Lazy loaded
          rootFolderId: handle.name, // Use the handle name as root folder ID
          isVisible: true,
        });
      } else {
        const fileHandle = entryHandle as FileSystemFileHandle;
        if (includeMetadata) {
          fileWorks.push(
            limiter(async () => {
              try {
                const file = await fileHandle.getFile();
                return {
                  name,
                  path: `${handle.path}/${name}`,
                  type: 'file',
                  handle: fileHandle,
                  depth: 0, // This should be calculated by the caller
                  selectionState: 'unchecked',
                  rootFolderId: handle.name, // Use the handle name as root folder ID
                  isVisible: true,
                  size: file.size,
                  lastModified: file.lastModified,
                } satisfies IFileNode;
              } catch {
                return null;
              }
            })
          );
        } else {
          dirNodes.push({
            name,
            path: `${handle.path}/${name}`,
            type: 'file',
            handle: fileHandle,
            depth: 0, // This should be calculated by the caller
            selectionState: 'unchecked',
            rootFolderId: handle.name, // Use the handle name as root folder ID
            isVisible: true,
          });
        }
      }
    }

    const settled = await Promise.allSettled(fileWorks);
    const fileNodes: IFileNode[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        fileNodes.push(r.value);
      }
    }

    const entries: IFileNode[] = [...dirNodes, ...fileNodes];

    return entries.sort((a, b) => {
      // Directories first, then files
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  async readFile(handle: FileHandle): Promise<string> {
    // Import config dynamically to avoid circular dependencies
    const { formatFileSize, getFileSizeConfig } = await import('../config.js');
    const { maxFileSize } = getFileSizeConfig();

    const fileHandle = handle._internal;
    if (!isFileSystemFileHandle(fileHandle)) {
      throw new AccessError('Invalid file handle', handle.path, 'read');
    }
    try {
      const folderId = handle.rootFolderId ?? this.lastRootFolderId;
      if (folderId) {
        await this.handleCache.storeFileHandle(folderId, handle.path, fileHandle);
      }
    } catch {
      // Best-effort persistence; ignore failures.
    }
    const file = await fileHandle.getFile();

    // Check file size before reading
    if (file.size > maxFileSize) {
      throw new AccessError(
        `File too large: ${formatFileSize(file.size)} (max: ${formatFileSize(maxFileSize)})`,
        handle.path,
        'read'
      );
    }

    return await file.text();
  }

  async exists(_path: string): Promise<boolean> {
    // Web API doesn't provide a direct way to check existence without access
    // This would need to be implemented differently
    return false;
  }

  async restoreLastFolder(): Promise<DirectoryHandle | null> {
    const handles = await this.handleCache.getAllRootHandles();
    if (handles.length === 0) {
      return null;
    }

    const latest = handles.reduce<StoredRootHandle | null>((current, candidate) => {
      if (!current) {
        return candidate;
      }
      return candidate.lastAccessedAt > current.lastAccessedAt ? candidate : current;
    }, null);

    if (!(latest && isFileSystemDirectoryHandle(latest.handle))) {
      if (latest) {
        await this.handleCache.removeRootHandle(latest.folderId);
      }
      return null;
    }

    const isAccessible = await this.verifyDirectoryHandle(latest.handle);
    if (!isAccessible) {
      await this.handleCache.removeRootHandle(latest.folderId);
      return null;
    }

    this.lastRootFolderId = latest.folderId;

    return {
      path: latest.handle.name,
      name: latest.handle.name,
      kind: 'directory',
      platform: 'web',
      _internal: latest.handle,
    };
  }

  // Web API doesn't support file watching
  // watchDirectory not implemented

  /**
   * Stream directory contents with batched callbacks (BST-147).
   *
   * Uses the Web File System Access API's async iterator to stream entries,
   * calling onBatch with groups of entries as they're discovered.
   *
   * @param handle - Directory to enumerate
   * @param onBatch - Called with each batch of entries; meta.done indicates final batch
   * @param options - Streaming options including batchSize and AbortSignal
   */
  async readDirectoryStreaming(
    handle: DirectoryHandle,
    onBatch: DirectoryStreamCallback,
    options?: StreamingDirectoryReadOptions
  ): Promise<void> {
    const dirHandle = handle._internal;
    if (!isFileSystemDirectoryHandle(dirHandle)) {
      throw new AccessError('Invalid directory handle', handle.path, 'read');
    }

    const batchSize = options?.batchSize ?? 50;
    const signal = options?.signal;
    const { includeMetadata } = normalizeDirectoryReadOptions(options);

    let batch: IFileNode[] = [];
    let total = 0;

    for await (const [name, entryHandle] of dirHandle.entries()) {
      // Check for cancellation
      if (signal?.aborted) {
        break;
      }

      // Create node using extracted helper functions
      const node =
        entryHandle.kind === 'directory'
          ? createDirectoryNode(
              name,
              handle.path,
              entryHandle as FileSystemDirectoryHandle,
              handle.name
            )
          : await createFileNode(
              name,
              handle.path,
              entryHandle as FileSystemFileHandle,
              handle.name,
              includeMetadata
            );

      batch.push(node);
      total++;

      // Emit batch when full
      if (batch.length >= batchSize) {
        onBatch(batch, { done: false, total });
        batch = [];
      }
    }

    // Emit any remaining entries
    if (batch.length > 0 || total === 0) {
      onBatch(batch, { done: true, total });
    } else {
      // Signal completion with empty batch if last batch was exactly full
      onBatch([], { done: true, total });
    }
  }

  private async verifyDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<boolean> {
    try {
      const iterator = handle.entries();
      await iterator.next();
      return true;
    } catch {
      return false;
    }
  }
}
