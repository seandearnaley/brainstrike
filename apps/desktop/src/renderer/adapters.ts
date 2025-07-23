import type { DirectoryHandle, FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import type { IFileNode } from '@brainstrike/types';

export class ElectronRendererFileSystemAdapter implements FileSystemAdapter {
  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    const handle = await window.electronAPI.fileSystem.requestDirectoryAccess();

    // Save the selected folder path for future auto-restore
    if (handle?.path) {
      await window.electronAPI.fileSystem.saveLastFolder(handle.path);
    }
    return handle;
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    return window.electronAPI.fileSystem.readDirectory(handle);
  }

  async readFile(handle: FileHandle): Promise<string> {
    return window.electronAPI.fileSystem.readFile(handle);
  }

  async exists(path: string): Promise<boolean> {
    return window.electronAPI.fileSystem.exists(path);
  }

  async restoreLastFolder(): Promise<DirectoryHandle | null> {
    return window.electronAPI.fileSystem.restoreLastFolder();
  }
}

export class ElectronRendererStorageAdapter implements StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    return window.electronAPI.storage.getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    return window.electronAPI.storage.setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    return window.electronAPI.storage.removeItem(key);
  }

  async clear(): Promise<void> {
    return window.electronAPI.storage.clear();
  }

  async getAllKeys(): Promise<string[]> {
    return window.electronAPI.storage.getAllKeys();
  }
}
