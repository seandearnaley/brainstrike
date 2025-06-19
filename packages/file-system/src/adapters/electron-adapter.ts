import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { IFileNode } from '@brainstrike/types';
import { AccessError, DialogError, PermissionError, UserCancelledError } from '../errors';
import type { DirectoryHandle, FileHandle, FileSystemAdapter, FileSystemChange } from '../types';

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

      // Validate that the selected path exists and is accessible
      try {
        const stats = await fsPromises.stat(selectedPath);
        if (!stats.isDirectory()) {
          throw new AccessError(
            'Selected path is not a directory',
            selectedPath,
            'access',
            this.requestDirectoryAccess
          );
        }
      } catch (accessError) {
        if (accessError instanceof AccessError) {
          throw accessError; // Re-throw our custom error
        }
        throw new PermissionError(
          `Cannot access selected directory: ${accessError instanceof Error ? accessError.message : 'Unknown error'}`,
          selectedPath,
          this.requestDirectoryAccess
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

    /** Native fallback used when chokidar is unavailable. */
    const startFsWatch = () => {
      try {
        const native = fs.watch(handle.path, { recursive: false }, (ev, filename) => {
          if (!filename) return;
          const full = path.join(handle.path, filename);
          const exists = fs.existsSync(full);
          const isDir = exists && fs.statSync(full).isDirectory();
          const type: FileSystemChange['type'] =
            ev === 'rename' ? (exists ? 'added' : 'removed') : 'modified';
          callback([{ type, path: full, kind: isDir ? 'directory' : 'file' }]);
        });
        dispose = () => native.close();
      } catch (e) {
        console.warn('fs.watch fallback failed:', e);
        dispose = () => {};
      }
    };

    // Preferred watcher
    import('chokidar')
      .then((mod) => {
        if (closed) return;
        // CommonJS ↔ ESM inter-op normalisation
        const chokidar: typeof import('chokidar') =
          // biome-ignore lint/suspicious/noExplicitAny: inter-op handling
          (mod as any).watch ? (mod as any) : (mod.default as unknown as typeof import('chokidar'));

        const watcher = chokidar.watch(handle.path, {
          ignoreInitial: true,
          persistent: true,
          awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
          ignored: /(^|[\/\\])\../,
          depth: 0,
        });

        const toChange = (type: FileSystemChange['type'], filePath: string, isDir: boolean) => {
          callback([
            {
              type,
              path: filePath,
              kind: isDir ? 'directory' : 'file',
            },
          ]);
        };

        watcher
          .on('add', (file: string) => toChange('added', file, false))
          .on('addDir', (dir: string) => toChange('added', dir, true))
          .on('change', (file: string) => toChange('modified', file, false))
          .on('unlink', (file: string) => toChange('removed', file, false))
          .on('unlinkDir', (dir: string) => toChange('removed', dir, true))
          .on('error', (error: unknown) => {
            console.error('Chokidar watcher error:', error);
          });

        dispose = () => watcher.close();
      })
      .catch((err: unknown) => {
        // Better error type narrowing
        const e = err as NodeJS.ErrnoException;
        if (e?.code !== 'MODULE_NOT_FOUND') {
          console.warn('chokidar unavailable, falling back to fs.watch:', err);
        }
        if (!closed) startFsWatch();
      });

    return () => {
      closed = true;
      dispose();
    };
  }
}
