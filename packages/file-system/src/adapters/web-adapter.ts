import type { IFileNode } from '@brainstrike/types';
import { BaseDatabaseAwareAdapter } from '../database-adapter';
import type { DirectoryHandle, FileHandle } from '../types';

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

export class WebFileSystemAdapter extends BaseDatabaseAwareAdapter {
  async requestDirectoryAccess(options?: {
    populateDatabase?: boolean;
    onProgress?: (loaded: number, total: number) => void;
  }): Promise<DirectoryHandle> {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API not supported');
    }

    const dirHandle = await window.showDirectoryPicker();

    const handle: DirectoryHandle = {
      path: dirHandle.name, // Web API doesn't give full path for security
      name: dirHandle.name,
      kind: 'directory',
      platform: 'web',
      _internal: dirHandle,
    };

    // If database population is requested and we have a folder service
    if (options?.populateDatabase && this.folderService && this.databaseMode) {
      try {
        const folderId = await this.folderService.openFolder(dirHandle, {
          ...(options.onProgress && { onProgress: options.onProgress }),
          // Default options for web
          maxFileSize: 10 * 1024 * 1024, // 10MB limit for web
          includeHidden: false,
          fileFilter: (fileName) => {
            // Filter out common binary and large files
            const ext = fileName.toLowerCase().split('.').pop() || '';
            const binaryExtensions = [
              'jpg',
              'jpeg',
              'png',
              'gif',
              'mp4',
              'mp3',
              'zip',
              'tar',
              'gz',
              'exe',
              'dll',
              'so',
              'dylib',
            ];
            return !binaryExtensions.includes(ext);
          },
        });

        // Store folder ID in handle for reference
        (handle as { folderId?: string }).folderId = folderId;
      } catch (error) {
        console.error('Failed to populate database from folder:', error);
        // Continue without database population on error
      }
    }

    return handle;
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    // Check if we have a folder ID and database mode is enabled
    const folderId = (handle as { folderId?: string }).folderId;
    if (folderId && this.databaseMode) {
      const dbEntries = await this.readDirectoryFromDatabase(folderId);
      if (dbEntries) {
        return dbEntries;
      }
    }

    // Fallback to file system reading
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
    // Check if we can read from database first
    if (this.databaseMode && this.folderService) {
      // Try to determine folder ID from path or handle
      const folderId =
        (handle as { folderId?: string; rootFolderId?: string }).folderId ||
        (handle as { folderId?: string; rootFolderId?: string }).rootFolderId;
      if (folderId) {
        const dbContent = await this.readFileFromDatabase(folderId, handle.path);
        if (dbContent !== null) {
          return dbContent;
        }
      }
    }

    // Fallback to file system reading
    const fileHandle = handle._internal as FileSystemFileHandle;
    const file = await fileHandle.getFile();
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
