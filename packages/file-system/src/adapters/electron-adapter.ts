import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { IFileNode } from '@brainstrike/types';

// Local ignore logic to avoid depending on @brainstrike/utils (prevents cyclical build refs)
const DEFAULT_IGNORE_PATTERNS = ['.git', 'node_modules', '.next', 'dist', 'build', '.DS_Store'];
function shouldIgnorePath(pathString: string): boolean {
  const normalizedPath = pathString.replace(/\\/g, '/');
  return DEFAULT_IGNORE_PATTERNS.some((pattern) => normalizedPath.split('/').includes(pattern));
}

import { AccessError, DialogError, PermissionError, UserCancelledError } from '../errors';
import type { DirectoryHandle, FileHandle, FileSystemAdapter, FileSystemChange } from '../types';
import { validateDirectoryPath } from '../utils';
import { handleWatcherSetupError, startChokidarWatch } from './electron-watchers';

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
 */
export class ElectronFileSystemAdapter implements FileSystemAdapter {
  /**
   * Requests directory access from the user via Electron's dialog
   *
   * @returns Promise<DirectoryHandle> The selected directory handle
   * @throws {UserCancelledError} When user cancels the dialog
   * @throws {PermissionError} When access is denied due to permissions
   * @throws {AccessError} When the selected path is invalid or inaccessible
   * @throws {DialogError} When the dialog fails to open
   */
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
        throw new UserCancelledError(
          'User cancelled directory selection',
          this.requestDirectoryAccess
        );
      }

      const selectedPath = result.filePaths[0];
      if (!selectedPath) {
        throw new Error('No directory path selected');
      }

      await validateDirectoryPath(selectedPath, this.requestDirectoryAccess);

      return {
        path: selectedPath,
        name: path.basename(selectedPath),
        kind: 'directory',
        platform: 'electron',
      };
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
        throw new DialogError(
          `Failed to open directory dialog: ${error.message}`,
          this.requestDirectoryAccess
        );
      }
      throw new DialogError(
        'Unknown error occurred while opening directory dialog',
        this.requestDirectoryAccess
      );
    }
  }

  async readDirectory(_handle: DirectoryHandle): Promise<IFileNode[]> {
    try {
      const entries = await fsPromises.readdir(_handle.path, { withFileTypes: true });
      const result: IFileNode[] = [];

      for (const entry of entries) {
        const fullPath = path.join(_handle.path, entry.name);

        // Skip ignored paths early to reduce IPC payload and processing
        if (shouldIgnorePath(fullPath)) {
          continue;
        }

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
            isSymbolicLink: entry.isSymbolicLink?.() ?? false,
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
            isSymbolicLink: entry.isSymbolicLink?.() ?? false,
            // size and lastModified intentionally omitted for performance; fetched on demand when reading file
            handle: {
              path: fullPath,
              name: entry.name,
              kind: 'file',
              platform: 'electron',
            } as unknown as FileSystemFileHandle,
          });
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
    try {
      // Check file size before reading
      const stats = await fsPromises.stat(_handle.path);
      const maxSize = 1024 * 1024; // 1MB limit

      if (stats.size > maxSize) {
        throw new AccessError(
          `File too large: ${Math.round(stats.size / 1024 / 1024)}MB (max: ${Math.round(maxSize / 1024 / 1024)}MB)`,
          _handle.path,
          'read'
        );
      }

      return await fsPromises.readFile(_handle.path, 'utf-8');
    } catch (error) {
      if (error instanceof AccessError) {
        throw error;
      }
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

  /**
   * Watch a directory and emit high-level change events.
   *
   * 1. Try to use **chokidar** (preferred - cross-platform, debounced).
   * 2. Gracefully fall back to **fs.watch** when chokidar is not present or fails.
   *
   * Always returns a valid disposer that can be called safely at any time.
   */
  watchDirectory(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[]) => void
  ): () => void {
    let closed = false;
    let dispose: () => void = () => {};

    startChokidarWatch(handle, callback)
      .then((stop) => {
        if (closed) {
          stop();
          return;
        }
        dispose = stop;
      })
      .catch((err) => {
        if (!closed) {
          dispose = handleWatcherSetupError(err, handle, callback);
        }
      });

    return () => {
      closed = true;
      dispose();
    };
  }
}
