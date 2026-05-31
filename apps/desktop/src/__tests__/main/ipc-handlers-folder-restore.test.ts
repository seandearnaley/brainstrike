import path from 'node:path';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Electron modules first
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  app: {
    getPath: vi.fn(),
  },
}));

import { ipcMain } from 'electron';
// Import after mocking
import { registerIpcHandlers } from '../../ipc-handlers';

function resolveTestPath(testPath: string): string {
  return path.resolve(testPath);
}

describe('IPC Handlers - Auto-Restore Folder Functionality', () => {
  let mockFileSystem: ElectronFileSystemAdapter;
  let mockStorage: ElectronStorageAdapter;
  let mockStore: Record<string, unknown>;
  let registeredHandlers: Map<string, (...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers = new Map();

    // Mock IPC main to capture registered handlers
    const mockIpcMain = vi.mocked(ipcMain);
    mockIpcMain.handle.mockImplementation(
      (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, (...args: unknown[]) =>
          handler({} as IpcMainInvokeEvent, ...args)
        );
      }
    );

    // Mock file system adapter
    mockFileSystem = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
      watchDirectory: vi.fn(),
    } as ElectronFileSystemAdapter;

    // Mock storage adapter with proper vitest mock functions
    mockStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      getAllKeys: vi.fn(),
    } as unknown as ElectronStorageAdapter;

    // Mock store
    mockStore = {} as Record<string, unknown>;

    // Register handlers
    registerIpcHandlers(mockFileSystem, mockStorage, mockStore as never);
  });

  describe('fs:restoreLastFolder handler', () => {
    it('should register the restoreLastFolder handler', () => {
      expect(registeredHandlers.has('fs:restoreLastFolder')).toBe(true);
    });

    it('should return null when no last folder path is stored', async () => {
      vi.mocked(mockStorage.getItem).mockResolvedValue(null);

      const handler = registeredHandlers.get('fs:restoreLastFolder');
      const result = await handler?.();

      expect(mockStorage.getItem).toHaveBeenCalledWith('lastFolderPath');
      expect(result).toBeNull();
    });

    it('should return null when stored folder path does not exist', async () => {
      const testPath = '/test/folder/path';
      const resolvedPath = resolveTestPath(testPath);
      vi.mocked(mockStorage.getItem).mockResolvedValue(testPath);
      vi.mocked(mockFileSystem.exists).mockResolvedValue(false);

      const handler = registeredHandlers.get('fs:restoreLastFolder');
      const result = await handler?.();

      expect(mockStorage.getItem).toHaveBeenCalledWith('lastFolderPath');
      expect(mockFileSystem.exists).toHaveBeenCalledWith(resolvedPath);
      expect(mockStorage.removeItem).toHaveBeenCalledWith('lastFolderPath');
      expect(result).toBeNull();
    });

    it('should return DirectoryHandle when stored folder exists', async () => {
      const testPath = '/test/folder/path';
      const resolvedPath = resolveTestPath(testPath);
      const expectedHandle: DirectoryHandle = {
        path: resolvedPath,
        name: path.basename(resolvedPath),
        kind: 'directory' as const,
        platform: 'electron' as const,
      };

      vi.mocked(mockStorage.getItem).mockResolvedValue(testPath);
      vi.mocked(mockFileSystem.exists).mockResolvedValue(true);

      const handler = registeredHandlers.get('fs:restoreLastFolder');
      const result = await handler?.();

      expect(mockStorage.getItem).toHaveBeenCalledWith('lastFolderPath');
      expect(mockFileSystem.exists).toHaveBeenCalledWith(resolvedPath);
      expect(mockStorage.removeItem).not.toHaveBeenCalled();
      expect(result).toEqual(expectedHandle);
    });

    it('should handle errors gracefully and return null', async () => {
      vi.mocked(mockStorage.getItem).mockRejectedValue(new Error('Storage error'));

      const handler = registeredHandlers.get('fs:restoreLastFolder');
      const result = await handler?.();

      expect(result).toBeNull();
    });

    it('should handle file system exists check errors gracefully', async () => {
      const testPath = '/test/folder/path';
      vi.mocked(mockStorage.getItem).mockResolvedValue(testPath);
      vi.mocked(mockFileSystem.exists).mockRejectedValue(new Error('File system error'));

      const handler = registeredHandlers.get('fs:restoreLastFolder');
      const result = await handler?.();

      expect(result).toBeNull();
    });
  });

  describe('fs:saveLastFolder handler', () => {
    it('should register the saveLastFolder handler', () => {
      expect(registeredHandlers.has('fs:saveLastFolder')).toBe(true);
    });

    it('should save folder path to storage', async () => {
      const testPath = '/test/folder/path';
      const resolvedPath = resolveTestPath(testPath);
      vi.mocked(mockStorage.setItem).mockResolvedValue(undefined);

      const handler = registeredHandlers.get('fs:saveLastFolder');
      await handler?.(testPath);

      expect(mockStorage.setItem).toHaveBeenCalledWith('lastFolderPath', resolvedPath);
    });

    it('should handle storage errors gracefully', async () => {
      const testPath = '/test/folder/path';
      const resolvedPath = resolveTestPath(testPath);
      vi.mocked(mockStorage.setItem).mockRejectedValue(new Error('Storage error'));

      const handler = registeredHandlers.get('fs:saveLastFolder');

      // Should not throw
      await expect(handler?.(testPath)).resolves.toBeUndefined();
      expect(mockStorage.setItem).toHaveBeenCalledWith('lastFolderPath', resolvedPath);
    });
  });

  describe('Integration scenarios', () => {
    it('should handle save and restore cycle correctly', async () => {
      const testPath = '/test/folder/path';
      const resolvedPath = resolveTestPath(testPath);

      // Save folder path
      vi.mocked(mockStorage.setItem).mockResolvedValue(undefined);
      const saveHandler = registeredHandlers.get('fs:saveLastFolder');
      await saveHandler?.(testPath);

      // Restore folder path
      vi.mocked(mockStorage.getItem).mockResolvedValue(testPath);
      vi.mocked(mockFileSystem.exists).mockResolvedValue(true);
      const restoreHandler = registeredHandlers.get('fs:restoreLastFolder');
      const result = await restoreHandler?.();

      expect(result).toEqual({
        path: resolvedPath,
        name: path.basename(resolvedPath),
        kind: 'directory',
        platform: 'electron',
      });
    });

    it('should clean up invalid paths during restore', async () => {
      const invalidPath = '/invalid/path';

      // Setup storage to return invalid path
      vi.mocked(mockStorage.getItem).mockResolvedValue(invalidPath);
      vi.mocked(mockFileSystem.exists).mockResolvedValue(false);
      vi.mocked(mockStorage.removeItem).mockResolvedValue(undefined);

      const restoreHandler = registeredHandlers.get('fs:restoreLastFolder');
      const result = await restoreHandler?.();

      expect(mockStorage.removeItem).toHaveBeenCalledWith('lastFolderPath');
      expect(result).toBeNull();
    });

    it('should handle Windows-style paths correctly', async () => {
      const windowsPath = 'C:\\Users\\Test\\Documents';

      vi.mocked(mockStorage.getItem).mockResolvedValue(windowsPath);
      vi.mocked(mockFileSystem.exists).mockResolvedValue(true);

      const restoreHandler = registeredHandlers.get('fs:restoreLastFolder');
      const result = await restoreHandler?.();

      expect(result).toEqual({
        path: windowsPath,
        name: path.basename(windowsPath),
        kind: 'directory',
        platform: 'electron',
      });
    });

    it('should handle Unix-style paths correctly', async () => {
      const unixPath = '/home/user/documents';
      const resolvedPath = resolveTestPath(unixPath);

      vi.mocked(mockStorage.getItem).mockResolvedValue(unixPath);
      vi.mocked(mockFileSystem.exists).mockResolvedValue(true);

      const restoreHandler = registeredHandlers.get('fs:restoreLastFolder');
      const result = await restoreHandler?.();

      expect(result).toEqual({
        path: resolvedPath,
        name: path.basename(resolvedPath),
        kind: 'directory',
        platform: 'electron',
      });
    });
  });
});
