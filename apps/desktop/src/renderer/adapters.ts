import type { DirectoryHandle, FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import type { ElectronAPI, IFileNode, RootDescriptor } from '@brainstrike/types';

function requireElectronAPI(): ElectronAPI {
  const api = window.electronAPI;
  if (!api) {
    throw new Error('Electron API is not available in the renderer process');
  }
  return api;
}

export class ElectronRendererFileSystemAdapter implements FileSystemAdapter {
  public readonly platform = 'electron' as const;

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    const api = requireElectronAPI().fileSystem;
    const handle = await api.requestDirectoryAccess();

    // Save the selected folder path for future auto-restore
    if (handle?.path) {
      await api.saveLastFolder(handle.path);
    }
    return handle;
  }

  async addRoot(): Promise<RootDescriptor> {
    return requireElectronAPI().fileSystem.addRoot();
  }

  async restoreRoots(): Promise<RootDescriptor[]> {
    return requireElectronAPI().fileSystem.restoreRoots();
  }

  /**
   * Disconnect a root by RootId. Disconnect ≠ delete — only the persisted
   * rootsList entry (and a matching lastFolderPath) is forgotten; DB rows are
   * deliberately KEPT so re-adding the same folder resumes without re-indexing.
   */
  async removeRoot(rootId: string): Promise<void> {
    return requireElectronAPI().fileSystem.removeRoot(rootId);
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    return requireElectronAPI().fileSystem.readDirectory(handle);
  }

  async readFile(handle: FileHandle): Promise<string> {
    return requireElectronAPI().fileSystem.readFile(handle);
  }

  /**
   * Read a file directly by its absolute path.
   * BST-307: Enables loading persisted file tabs before the file tree is available.
   */
  async readFileByPath(absolutePath: string): Promise<string> {
    return requireElectronAPI().fileSystem.readFileByPath(absolutePath);
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
