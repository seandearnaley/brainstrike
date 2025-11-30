import type { IFileNode } from '@brainstrike/types';
import { AccessError } from '../errors';
import type {
  DirectoryHandle,
  DirectoryReadOptions,
  FileHandle,
  FileSystemAdapter,
} from '../types';
import {
  isFileSystemDirectoryHandle,
  isFileSystemFileHandle,
  normalizeDirectoryReadOptions,
} from '../utils';

// Type declarations for File System Access API
declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
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

  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
  interface FileSystemHandle {
    readonly kind: 'file' | 'directory';
    readonly name: string;
  }
}

// limiter shared via utils

export class WebFileSystemAdapter implements FileSystemAdapter {
  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API not supported');
    }

    const dirHandle = await window.showDirectoryPicker();

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
    const fileHandle = handle._internal;
    if (!isFileSystemFileHandle(fileHandle)) {
      throw new AccessError('Invalid file handle', handle.path, 'read');
    }
    const file = await fileHandle.getFile();

    // Check file size before reading
    const maxSize = 1024 * 1024; // 1MB limit

    if (file.size > maxSize) {
      throw new AccessError(
        `File too large: ${Math.round(file.size / 1024 / 1024)}MB (max: ${Math.round(maxSize / 1024 / 1024)}MB)`,
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

  // Web API doesn't support file watching
  // watchDirectory not implemented
}
