import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { IFileNode } from '@brainstrike/types';
import type { DirectoryHandle, FileHandle, FileSystemAdapter, FileSystemChange } from '../types';

export class ElectronFileSystemAdapter implements FileSystemAdapter {
  async requestDirectoryAccess(): Promise<DirectoryHandle> {
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
        // Return a more specific error for user cancellation
        const error = new Error('User cancelled directory selection');
        error.name = 'UserCancelledError';
        throw error;
      }

      const selectedPath = result.filePaths[0];
      if (!selectedPath) {
        throw new Error('No directory path selected');
      }

      // Validate that the selected path exists and is accessible
      try {
        const stats = await fsPromises.stat(selectedPath);
        if (!stats.isDirectory()) {
          throw new Error('Selected path is not a directory');
        }
      } catch (accessError) {
        throw new Error(
          `Cannot access selected directory: ${accessError instanceof Error ? accessError.message : 'Unknown error'}`
        );
      }

      return {
        path: selectedPath,
        name: path.basename(selectedPath),
        kind: 'directory',
        platform: 'electron',
      };
    } catch (error) {
      // Re-throw with better error handling
      if (error instanceof Error) {
        // Preserve user cancellation errors
        if (error.name === 'UserCancelledError') {
          throw error;
        }
        // Handle other dialog errors
        throw new Error(`Failed to open directory dialog: ${error.message}`);
      }
      throw new Error('Unknown error occurred while opening directory dialog');
    }
  }

  async readDirectory(_handle: DirectoryHandle): Promise<IFileNode[]> {
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
      throw new Error(
        `Failed to read directory: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async readFile(_handle: FileHandle): Promise<string> {
    try {
      return await fsPromises.readFile(_handle.path, 'utf-8');
    } catch (error) {
      throw new Error(
        `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`
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
    let watcher: fs.FSWatcher | null = null;

    try {
      watcher = fs.watch(handle.path, { recursive: false }, (eventType, filename) => {
        if (filename) {
          const fullPath = path.join(handle.path, filename);
          const change: FileSystemChange = {
            type: eventType === 'rename' ? 'modified' : 'modified',
            path: fullPath,
            kind: 'file', // Default to file, could be enhanced to check actual type
          };
          callback([change]);
        }
      });

      return () => {
        if (watcher) {
          watcher.close();
          watcher = null;
        }
      };
    } catch (error) {
      console.warn('Failed to watch directory:', error);
      // Return a no-op function if watching fails
      return () => {};
    }
  }
}
