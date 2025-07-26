import type { IFileNode } from '@brainstrike/types';
import { AccessError } from '../errors';
import type { DirectoryHandle, FileHandle, FileSystemAdapter } from '../types';

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
  }
}

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

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    const dirHandle = handle._internal as FileSystemDirectoryHandle;
    const entries: IFileNode[] = [];

    for await (const [name, entryHandle] of dirHandle.entries()) {
      if (entryHandle.kind === 'directory') {
        entries.push({
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
        const file = await fileHandle.getFile();
        entries.push({
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
        });
      }
    }

    return entries.sort((a, b) => {
      // Directories first, then files
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(handle: FileHandle): Promise<string> {
    const fileHandle = handle._internal as FileSystemFileHandle;
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
