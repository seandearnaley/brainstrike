import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ElectronRendererFileSystemAdapter,
  ElectronRendererStorageAdapter,
} from '../../renderer/adapters';
import { mockElectronAPI } from '../setup';

describe('ElectronRendererFileSystemAdapter', () => {
  let adapter: ElectronRendererFileSystemAdapter;

  beforeEach(() => {
    adapter = new ElectronRendererFileSystemAdapter();
    vi.clearAllMocks();
  });

  describe('requestDirectoryAccess', () => {
    it('should call electronAPI.fileSystem.requestDirectoryAccess', async () => {
      const result = await adapter.requestDirectoryAccess();

      expect(mockElectronAPI.fileSystem.requestDirectoryAccess).toHaveBeenCalledOnce();
      expect(result).toEqual({
        path: '/mock/path',
        name: 'mock-directory',
        kind: 'directory',
        platform: 'electron',
      });
    });

    it('should save folder path when handle has path', async () => {
      const mockHandle = {
        path: '/test/folder/path',
        name: 'test-directory',
        kind: 'directory' as const,
        platform: 'electron' as const,
      };

      mockElectronAPI.fileSystem.requestDirectoryAccess.mockResolvedValueOnce(mockHandle);

      await adapter.requestDirectoryAccess();

      expect(mockElectronAPI.fileSystem.saveLastFolder).toHaveBeenCalledWith('/test/folder/path');
    });

    it('should not save folder path when handle has no path', async () => {
      const mockHandle = {
        path: '',
        name: 'test-directory',
        kind: 'directory' as const,
        platform: 'electron' as const,
      };

      mockElectronAPI.fileSystem.requestDirectoryAccess.mockResolvedValueOnce(mockHandle);

      await adapter.requestDirectoryAccess();

      expect(mockElectronAPI.fileSystem.saveLastFolder).not.toHaveBeenCalled();
    });
  });

  describe('readDirectory', () => {
    it('should call electronAPI.fileSystem.readDirectory with handle', async () => {
      const mockHandle = {
        path: '/test',
        name: 'test',
        kind: 'directory' as const,
        platform: 'electron' as const,
      };
      const mockFiles = [
        {
          name: 'file1.txt',
          path: '/test/file1.txt',
          type: 'file',
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'test',
          isVisible: true,
        },
      ];

      mockElectronAPI.fileSystem.readDirectory.mockResolvedValue(mockFiles);

      const result = await adapter.readDirectory(mockHandle);

      expect(mockElectronAPI.fileSystem.readDirectory).toHaveBeenCalledWith(mockHandle);
      expect(result).toEqual(mockFiles);
    });
  });

  describe('readFile', () => {
    it('should call electronAPI.fileSystem.readFile with handle', async () => {
      const mockHandle = {
        path: '/test/file.txt',
        name: 'file.txt',
        kind: 'file' as const,
        platform: 'electron' as const,
      };
      const mockContent = 'file content';

      mockElectronAPI.fileSystem.readFile.mockResolvedValue(mockContent);

      const result = await adapter.readFile(mockHandle);

      expect(mockElectronAPI.fileSystem.readFile).toHaveBeenCalledWith(mockHandle);
      expect(result).toBe(mockContent);
    });
  });

  describe('exists', () => {
    it('should call electronAPI.fileSystem.exists with path', async () => {
      const testPath = '/test/path';
      mockElectronAPI.fileSystem.exists.mockResolvedValue(true);

      const result = await adapter.exists(testPath);

      expect(mockElectronAPI.fileSystem.exists).toHaveBeenCalledWith(testPath);
      expect(result).toBe(true);
    });

    it('should return false when file does not exist', async () => {
      const testPath = '/nonexistent/path';
      mockElectronAPI.fileSystem.exists.mockResolvedValue(false);

      const result = await adapter.exists(testPath);

      expect(result).toBe(false);
    });
  });

  // BST-307: Tests for readFileByPath
  describe('readFileByPath', () => {
    it('should call electronAPI.fileSystem.readFileByPath with absolute path', async () => {
      const absolutePath = '/Users/test/project/file.ts';
      const mockContent = 'export const example = "hello";';

      mockElectronAPI.fileSystem.readFileByPath.mockResolvedValue(mockContent);

      const result = await adapter.readFileByPath(absolutePath);

      expect(mockElectronAPI.fileSystem.readFileByPath).toHaveBeenCalledWith(absolutePath);
      expect(result).toBe(mockContent);
    });

    it('should return file content for valid paths', async () => {
      const testPath = '/test/documents/readme.md';
      const expectedContent = '# Test README\n\nThis is a test file.';

      mockElectronAPI.fileSystem.readFileByPath.mockResolvedValue(expectedContent);

      const result = await adapter.readFileByPath(testPath);

      expect(result).toBe(expectedContent);
    });

    it('should handle errors from the IPC call', async () => {
      const testPath = '/nonexistent/file.txt';

      mockElectronAPI.fileSystem.readFileByPath.mockRejectedValue(new Error('File not found'));

      await expect(adapter.readFileByPath(testPath)).rejects.toThrow('File not found');
    });

    it('should propagate path validation errors from main process', async () => {
      const invalidPath = '/etc/passwd';

      mockElectronAPI.fileSystem.readFileByPath.mockRejectedValue(new Error('Invalid path'));

      await expect(adapter.readFileByPath(invalidPath)).rejects.toThrow('Invalid path');
      expect(mockElectronAPI.fileSystem.readFileByPath).toHaveBeenCalledWith(invalidPath);
    });
  });

  describe('addRoot', () => {
    it('should call electronAPI.fileSystem.addRoot and return the descriptor', async () => {
      const mockDescriptor = {
        displayName: 'my-project',
        handle: {
          kind: 'directory' as const,
          name: 'my-project',
          path: '/test/my-project',
          platform: 'electron' as const,
        },
        kind: 'path' as const,
        permissionState: 'granted' as const,
        persisted: true,
        rootId: 'abc-123',
      };
      mockElectronAPI.fileSystem.addRoot.mockResolvedValueOnce(mockDescriptor);

      const result = await adapter.addRoot();

      expect(mockElectronAPI.fileSystem.addRoot).toHaveBeenCalledOnce();
      expect(result).toEqual(mockDescriptor);
    });
  });

  describe('restoreRoots', () => {
    it('should call electronAPI.fileSystem.restoreRoots and return descriptors', async () => {
      const mockDescriptors = [
        {
          displayName: 'project-a',
          handle: {
            kind: 'directory' as const,
            name: 'project-a',
            path: '/test/project-a',
            platform: 'electron' as const,
          },
          kind: 'path' as const,
          permissionState: 'granted' as const,
          persisted: true,
          rootId: 'root-a',
        },
      ];
      mockElectronAPI.fileSystem.restoreRoots.mockResolvedValueOnce(mockDescriptors);

      const result = await adapter.restoreRoots();

      expect(mockElectronAPI.fileSystem.restoreRoots).toHaveBeenCalledOnce();
      expect(result).toEqual(mockDescriptors);
    });

    it('should return empty array when no roots are stored', async () => {
      mockElectronAPI.fileSystem.restoreRoots.mockResolvedValueOnce([]);

      const result = await adapter.restoreRoots();

      expect(result).toEqual([]);
    });
  });

  describe('restoreLastFolder', () => {
    it('should call electronAPI.fileSystem.restoreLastFolder', async () => {
      const mockHandle = {
        path: '/restored/folder/path',
        name: 'restored-folder',
        kind: 'directory' as const,
        platform: 'electron' as const,
      };

      mockElectronAPI.fileSystem.restoreLastFolder.mockResolvedValue(mockHandle);

      const result = await adapter.restoreLastFolder();

      expect(mockElectronAPI.fileSystem.restoreLastFolder).toHaveBeenCalledOnce();
      expect(result).toEqual(mockHandle);
    });

    it('should return null when no folder to restore', async () => {
      mockElectronAPI.fileSystem.restoreLastFolder.mockResolvedValue(null);

      const result = await adapter.restoreLastFolder();

      expect(mockElectronAPI.fileSystem.restoreLastFolder).toHaveBeenCalledOnce();
      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockElectronAPI.fileSystem.restoreLastFolder.mockRejectedValue(new Error('Restore failed'));

      await expect(adapter.restoreLastFolder()).rejects.toThrow('Restore failed');
    });
  });
});

describe('ElectronRendererStorageAdapter', () => {
  let adapter: ElectronRendererStorageAdapter;

  beforeEach(() => {
    adapter = new ElectronRendererStorageAdapter();
    vi.clearAllMocks();
  });

  describe('getItem', () => {
    it('should call electronAPI.storage.getItem with key', async () => {
      const key = 'test-key';
      const value = 'test-value';
      mockElectronAPI.storage.getItem.mockResolvedValue(value);

      const result = await adapter.getItem(key);

      expect(mockElectronAPI.storage.getItem).toHaveBeenCalledWith(key);
      expect(result).toBe(value);
    });

    it('should return null for non-existent key', async () => {
      const key = 'nonexistent-key';
      mockElectronAPI.storage.getItem.mockResolvedValue(null);

      const result = await adapter.getItem(key);

      expect(result).toBeNull();
    });
  });

  describe('setItem', () => {
    it('should call electronAPI.storage.setItem with key and value', async () => {
      const key = 'test-key';
      const value = 'test-value';

      await adapter.setItem(key, value);

      expect(mockElectronAPI.storage.setItem).toHaveBeenCalledWith(key, value);
    });
  });

  describe('removeItem', () => {
    it('should call electronAPI.storage.removeItem with key', async () => {
      const key = 'test-key';

      await adapter.removeItem(key);

      expect(mockElectronAPI.storage.removeItem).toHaveBeenCalledWith(key);
    });
  });

  describe('clear', () => {
    it('should call electronAPI.storage.clear', async () => {
      await adapter.clear();

      expect(mockElectronAPI.storage.clear).toHaveBeenCalledOnce();
    });
  });

  describe('getAllKeys', () => {
    it('should call electronAPI.storage.getAllKeys', async () => {
      const mockKeys = ['key1', 'key2', 'key3'];
      mockElectronAPI.storage.getAllKeys.mockResolvedValue(mockKeys);

      const result = await adapter.getAllKeys();

      expect(mockElectronAPI.storage.getAllKeys).toHaveBeenCalledOnce();
      expect(result).toEqual(mockKeys);
    });

    it('should return empty array when no keys exist', async () => {
      mockElectronAPI.storage.getAllKeys.mockResolvedValue([]);

      const result = await adapter.getAllKeys();

      expect(result).toEqual([]);
    });
  });
});
