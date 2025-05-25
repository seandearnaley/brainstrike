import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { IFileNode } from '@brainstrike/types';
import type { DirectoryHandle, FileHandle, FileSystemAdapter, FileSystemChange } from '../types';

export class ElectronFileSystemAdapter implements FileSystemAdapter {
  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    // Dynamically import electron to avoid issues in browser/test environments
    let dialog: any;
    try {
      const electron = await import('electron');
      dialog = electron.dialog;
    } catch {
      throw new Error(
        'Electron is not available - this adapter should only be used in the main process'
      );
    }

    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select a folder to explore',
    });

    if (result.canceled || result.filePaths.length === 0) {
      throw new Error('User cancelled directory selection');
    }

    const selectedPath = result.filePaths[0];
    if (!selectedPath) {
      throw new Error('No directory path selected');
    }

    return {
      path: selectedPath,
      name: path.basename(selectedPath),
      kind: 'directory',
      platform: 'electron',
    };
  }

  async readDirectory(_handle: DirectoryHandle): Promise<IFileNode[]> {
    const entries = await fsPromises.readdir(_handle.path, { withFileTypes: true });
    const result: IFileNode[] = [];

    for (const entry of entries) {
      const fullPath = path.join(_handle.path, entry.name);
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
    }

    return result.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(_handle: FileHandle): Promise<string> {
    return fsPromises.readFile(_handle.path, 'utf8');
  }

  async exists(_path: string): Promise<boolean> {
    try {
      await fsPromises.access(_path);
      return true;
    } catch {
      return false;
    }
  }

  watchDirectory(
    _handle: DirectoryHandle,
    _callback: (changes: FileSystemChange[]) => void
  ): () => void {
    const watcher = fs.watch(
      _handle.path,
      { recursive: true },
      (eventType: string, filename: string | null) => {
        if (!filename) return;
        const fullPath = path.join(_handle.path, filename);
        const existsNow = fs.existsSync(fullPath);
        const kind: 'file' | 'directory' =
          existsNow && fs.statSync(fullPath).isDirectory() ? 'directory' : 'file';
        const type: FileSystemChange['type'] =
          eventType === 'rename' ? (existsNow ? 'added' : 'removed') : 'modified';
        _callback([{ type, path: fullPath, kind }]);
      }
    );

    return () => watcher.close();
  }
}
