import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
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
