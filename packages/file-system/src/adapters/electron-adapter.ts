import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { IFileNode } from '@brainstrike/types';
import { BaseDatabaseAwareAdapter } from '../database-adapter';
import { AccessError, DialogError, PermissionError, UserCancelledError } from '../errors';
import type { DirectoryHandle, FileHandle, FileSystemChange } from '../types';

/**
 * File system adapter for Electron applications
 *
 * This adapter provides file system access using Node.js APIs within the Electron main process.
 * It handles directory selection via Electron's dialog API and file operations using Node.js fs module.
 *
 * Key features:
 * - Proper error handling with custom error types
 * - User cancellation detection
 * - Permission and access validation
 * - File watching capabilities
 * - Database-first file loading support
 */
export class ElectronFileSystemAdapter extends BaseDatabaseAwareAdapter {
  /**
   * Requests directory access from the user via Electron's dialog
   *
   * @returns Promise<DirectoryHandle> The selected directory handle
   * @throws {UserCancelledError} When user cancels the dialog
   * @throws {PermissionError} When access is denied due to permissions
   * @throws {AccessError} When the selected path is invalid or inaccessible
   * @throws {DialogError} When the dialog fails to open
   */
  async requestDirectoryAccess(options?: {
    populateDatabase?: boolean;
    onProgress?: (loaded: number, total: number) => void;
  }): Promise<DirectoryHandle> {
    // Dynamically import electron to avoid issues in browser/test environments
    let dialog: Electron.Dialog;
    try {
      const electron = await import('electron');
      dialog = electron.dialog;
    } catch {
      throw new Error(
        'Electron is not available - this adapter should only be used in the main process'
      );
    }

    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select a folder to explore',
        // Add these properties to improve dialog behavior
        buttonLabel: 'Select Folder',
        message: 'Choose a directory to explore with BrainStrike',
      });

      if (result.canceled || result.filePaths.length === 0) {
        throw new UserCancelledError('User cancelled directory selection');
      }

      const selectedPath = result.filePaths[0];
      if (!selectedPath) {
        throw new Error('No directory path selected');
      }

      // Validate that the selected path exists and is accessible
      try {
        const stats = await fsPromises.stat(selectedPath);
        if (!stats.isDirectory()) {
          throw new AccessError('Selected path is not a directory', selectedPath, 'access');
        }
      } catch (accessError) {
        if (accessError instanceof AccessError) {
          throw accessError; // Re-throw our custom error
        }
        throw new PermissionError(
          `Cannot access selected directory: ${accessError instanceof Error ? accessError.message : 'Unknown error'}`,
          selectedPath
        );
      }

      const handle: DirectoryHandle = {
        path: selectedPath,
        name: path.basename(selectedPath),
        kind: 'directory',
        platform: 'electron',
      };

      // If database population is requested and we have a folder service
      if (options?.populateDatabase && this.folderService && this.databaseMode) {
        try {
          // Create a mock FileSystemDirectoryHandle for Electron
          const electronDirHandle = {
            kind: 'directory' as const,
            name: path.basename(selectedPath),
            // Create an async iterator for entries
            async *entries() {
              const files = await fsPromises.readdir(selectedPath, { withFileTypes: true });
              for (const dirent of files) {
                const entryPath = path.join(selectedPath, dirent.name);
                if (dirent.isDirectory()) {
                  yield [
                    dirent.name,
                    {
                      kind: 'directory' as const,
                      name: dirent.name,
                    },
                  ] as [string, { kind: 'directory'; name: string }];
                } else {
                  yield [
                    dirent.name,
                    {
                      kind: 'file' as const,
                      name: dirent.name,
                      async getFile() {
                        const content = await fsPromises.readFile(entryPath);
                        const stats = await fsPromises.stat(entryPath);
                        return new File([content], dirent.name, {
                          lastModified: stats.mtime.getTime(),
                        });
                      },
                    },
                  ] as [string, { kind: 'file'; name: string; getFile: () => Promise<File> }];
                }
              }
            },
          };

          const folderId = await this.folderService.openFolder(
            electronDirHandle as unknown as FileSystemDirectoryHandle,
            {
              ...(options.onProgress && { onProgress: options.onProgress }),
              // Default options for Electron
              maxFileSize: 50 * 1024 * 1024, // 50MB limit for Electron
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
                  'app',
                ];
                return !binaryExtensions.includes(ext);
              },
            }
          );

          // Store folder ID in handle for reference
          (handle as { folderId?: string }).folderId = folderId;
        } catch (error) {
          console.error('Failed to populate database from folder:', error);
          // Continue without database population on error
        }
      }

      return handle;
    } catch (error) {
      // Re-throw with better error handling
      if (
        error instanceof UserCancelledError ||
        error instanceof PermissionError ||
        error instanceof AccessError
      ) {
        throw error; // Preserve our custom errors
      }
      if (error instanceof Error) {
        throw new DialogError(`Failed to open directory dialog: ${error.message}`);
      }
      throw new DialogError('Unknown error occurred while opening directory dialog');
    }
  }

  async readDirectory(_handle: DirectoryHandle): Promise<IFileNode[]> {
    // Check if we have a folder ID and database mode is enabled
    const folderId = (_handle as { folderId?: string }).folderId;
    if (folderId && this.databaseMode) {
      const dbEntries = await this.readDirectoryFromDatabase(folderId);
      if (dbEntries) {
        return dbEntries;
      }
    }

    // Fallback to file system reading
    try {
      const entries = await fsPromises.readdir(_handle.path, { withFileTypes: true });
      const result: IFileNode[] = [];

      for (const entry of entries) {
        const fullPath = path.join(_handle.path, entry.name);
        try {
          const stat = await fsPromises.stat(fullPath);
          if (entry.isDirectory()) {
            result.push({
              name: entry.name,
              path: fullPath,
              type: 'directory',
              depth: 0,
              selectionState: 'unchecked',
              children: [],
              rootFolderId: _handle.name,
              isVisible: true,
              handle: {
                path: fullPath,
                name: entry.name,
                kind: 'directory',
                platform: 'electron',
              } as unknown as FileSystemDirectoryHandle,
            });
          } else {
            result.push({
              name: entry.name,
              path: fullPath,
              type: 'file',
              depth: 0,
              selectionState: 'unchecked',
              rootFolderId: _handle.name,
              isVisible: true,
              size: stat.size,
              lastModified: stat.mtimeMs,
              handle: {
                path: fullPath,
                name: entry.name,
                kind: 'file',
                platform: 'electron',
              } as unknown as FileSystemFileHandle,
            });
          }
        } catch (statError) {
          // Skip files that can't be accessed (permissions, etc.)
          console.warn(`Could not access ${fullPath}:`, statError);
        }
      }

      return result.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      throw new AccessError(
        `Failed to read directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
        _handle.path,
        'read'
      );
    }
  }

  async readFile(_handle: FileHandle): Promise<string> {
    // Check if we can read from database first
    if (this.databaseMode && this.folderService) {
      // Try to determine folder ID from path or handle
      const folderId =
        (_handle as { folderId?: string; rootFolderId?: string }).folderId ||
        (_handle as { folderId?: string; rootFolderId?: string }).rootFolderId;
      if (folderId) {
        const dbContent = await this.readFileFromDatabase(folderId, _handle.path);
        if (dbContent !== null) {
          return dbContent;
        }
      }
    }

    // Fallback to file system reading
    try {
      return await fsPromises.readFile(_handle.path, 'utf-8');
    } catch (error) {
      throw new AccessError(
        `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        _handle.path,
        'read'
      );
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fsPromises.access(path);
      return true;
    } catch {
      return false;
    }
  }

  watchDirectory(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[]) => void
  ): () => void {
    // Workers disabled for now - complex to bundle in monorepo
    // Always use main thread fs.watch
    // Note: Using fs.watch (non-recursive) for directory watching

    // Simple fs.watch implementation
    let watcher: fs.FSWatcher | null = null;
    try {
      watcher = fs.watch(handle.path, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(handle.path, filename);

        let kind: FileSystemChange['kind'] = 'file';
        try {
          const stats = fs.statSync(fullPath);
          kind = stats.isDirectory() ? 'directory' : 'file';
        } catch {}

        let changeType: FileSystemChange['type'] = 'modified';
        if (eventType === 'rename') {
          changeType = fs.existsSync(fullPath) ? 'added' : 'removed';
        }

        callback([{ type: changeType, path: fullPath, kind }]);
      });

      return () => {
        watcher?.close();
      };
    } catch (error) {
      console.warn('Failed to watch directory:', error);
      return () => {};
    }
  }
}
