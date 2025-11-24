import type { DirectoryHandle, FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import type { ElectronAPI, IFileNode } from '@brainstrike/types';

function requireElectronAPI(): ElectronAPI {
  const api = window.electronAPI;
  if (!api) {
    throw new Error('Electron API is not available in the renderer process');
  }
  return api;
}

export class ElectronRendererFileSystemAdapter implements FileSystemAdapter {
  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    const api = requireElectronAPI().fileSystem;
    const handle = await api.requestDirectoryAccess();

    // Save the selected folder path for future auto-restore
    if (handle?.path) {
      await api.saveLastFolder(handle.path);
    }
    return handle;
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    return requireElectronAPI().fileSystem.readDirectory(handle);
  }

  async readFile(handle: FileHandle): Promise<string> {
    return requireElectronAPI().fileSystem.readFile(handle);
  }

  async exists(path: string): Promise<boolean> {
    return requireElectronAPI().fileSystem.exists(path);
  }

  async restoreLastFolder(): Promise<DirectoryHandle | null> {
    return requireElectronAPI().fileSystem.restoreLastFolder();
  }
}

export class ElectronRendererStorageAdapter implements StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    return requireElectronAPI().storage.getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    return requireElectronAPI().storage.setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    return requireElectronAPI().storage.removeItem(key);
  }

  async clear(): Promise<void> {
    return requireElectronAPI().storage.clear();
  }

  async getAllKeys(): Promise<string[]> {
    return requireElectronAPI().storage.getAllKeys();
  }
}
