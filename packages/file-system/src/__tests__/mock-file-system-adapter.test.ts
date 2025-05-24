import { beforeEach, describe, expect, it } from 'vitest';
import { type MockFileEntry, MockFileSystemAdapter } from '../adapters/mock-file-system-adapter';
import type { FileHandle } from '../types';

describe('MockFileSystemAdapter', () => {
  let adapter: MockFileSystemAdapter;

  beforeEach(() => {
    adapter = new MockFileSystemAdapter();
  });

  describe('constructor', () => {
    it('should create an empty file system by default', () => {
      const emptyAdapter = new MockFileSystemAdapter();
      expect(emptyAdapter).toBeDefined();
    });

    it('should accept initial file system structure', () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      const adapterWithData = new MockFileSystemAdapter(mockFS);
      expect(adapterWithData).toBeDefined();
    });
  });

  describe('setMockFileSystem', () => {
    it('should set the file system structure', () => {
      const mockFS = {
        'test.txt': {
          name: 'test.txt',
          type: 'file' as const,
          content: 'test content',
        },
      };

      adapter.setMockFileSystem(mockFS);
      expect(adapter).toBeDefined();
    });
  });

  describe('addMockEntry', () => {
    it('should add a file to the root', () => {
      const fileEntry: MockFileEntry = {
        name: 'test.txt',
        type: 'file',
        content: 'test content',
      };

      adapter.addMockEntry('test.txt', fileEntry);
      expect(adapter).toBeDefined();
    });

    it('should add a file to a nested directory', () => {
      const fileEntry: MockFileEntry = {
        name: 'nested.txt',
        type: 'file',
        content: 'nested content',
      };

      adapter.addMockEntry('src/components/nested.txt', fileEntry);
      expect(adapter).toBeDefined();
    });

    it('should create intermediate directories automatically', () => {
      const fileEntry: MockFileEntry = {
        name: 'deep.txt',
        type: 'file',
        content: 'deep content',
      };

      adapter.addMockEntry('very/deep/path/deep.txt', fileEntry);
      expect(adapter).toBeDefined();
    });

    it('should handle empty path parts gracefully', () => {
      const fileEntry: MockFileEntry = {
        name: 'test.txt',
        type: 'file',
        content: 'test content',
      };

      adapter.addMockEntry('//test.txt', fileEntry);
      expect(adapter).toBeDefined();
    });
  });

  describe('requestDirectoryAccess', () => {
    it('should throw error when no file system is configured', async () => {
      await expect(adapter.requestDirectoryAccess()).rejects.toThrow(
        'No mock file system configured'
      );
    });

    it('should return a directory handle when file system is configured', async () => {
      adapter.setMockFileSystem({ 'test.txt': { name: 'test.txt', type: 'file' } });

      const handle = await adapter.requestDirectoryAccess();

      expect(handle).toEqual({
        path: 'mock-root',
        name: 'mock-root',
        kind: 'directory',
        platform: 'web',
        _internal: { mockRoot: true },
      });
    });
  });

  describe('readDirectory', () => {
    beforeEach(() => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      adapter.setMockFileSystem(mockFS);
    });

    it('should throw error when no directory is selected', async () => {
      const freshAdapter = new MockFileSystemAdapter();
      const handle = {
        path: 'test',
        name: 'test',
        kind: 'directory' as const,
        platform: 'web' as const,
      };

      await expect(freshAdapter.readDirectory(handle)).rejects.toThrow('No directory selected');
    });

    it('should read root directory contents', async () => {
      await adapter.requestDirectoryAccess();

      const handle = {
        path: 'mock-root',
        name: 'mock-root',
        kind: 'directory' as const,
        platform: 'web' as const,
      };

      const entries = await adapter.readDirectory(handle);

      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.name)).toContain('src');
      expect(entries.map((e) => e.name)).toContain('package.json');
      expect(entries.map((e) => e.name)).toContain('README.md');
    });

    it('should read subdirectory contents', async () => {
      await adapter.requestDirectoryAccess();

      const handle = {
        path: 'mock-root/src',
        name: 'src',
        kind: 'directory' as const,
        platform: 'web' as const,
      };

      const entries = await adapter.readDirectory(handle);

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name)).toContain('index.ts');
      expect(entries.map((e) => e.name)).toContain('components');
    });

    it('should return empty array for non-existent directory', async () => {
      await adapter.requestDirectoryAccess();

      const handle = {
        path: 'mock-root/non-existent',
        name: 'non-existent',
        kind: 'directory' as const,
        platform: 'web' as const,
      };

      const entries = await adapter.readDirectory(handle);
      expect(entries).toEqual([]);
    });

    it('should sort entries with directories first', async () => {
      await adapter.requestDirectoryAccess();

      const handle = {
        path: 'mock-root',
        name: 'mock-root',
        kind: 'directory' as const,
        platform: 'web' as const,
      };

      const entries = await adapter.readDirectory(handle);

      // First entry should be the directory 'src'
      expect(entries[0].type).toBe('directory');
      expect(entries[0].name).toBe('src');

      // Files should come after directories
      const fileEntries = entries.filter((e) => e.type === 'file');
      expect(fileEntries).toHaveLength(2);
    });

    it('should set correct file properties', async () => {
      await adapter.requestDirectoryAccess();

      const handle = {
        path: 'mock-root',
        name: 'mock-root',
        kind: 'directory' as const,
        platform: 'web' as const,
      };

      const entries = await adapter.readDirectory(handle);
      const packageJson = entries.find((e) => e.name === 'package.json');

      expect(packageJson).toBeDefined();
      expect(packageJson?.type).toBe('file');
      expect(packageJson?.size).toBeGreaterThan(0);
      expect(packageJson?.lastModified).toBeDefined();
      expect(packageJson?.rootFolderId).toBe('mock-root');
      expect(packageJson?.isVisible).toBe(true);
    });

    it('should set correct directory properties', async () => {
      await adapter.requestDirectoryAccess();

      const handle = {
        path: 'mock-root',
        name: 'mock-root',
        kind: 'directory' as const,
        platform: 'web' as const,
      };

      const entries = await adapter.readDirectory(handle);
      const srcDir = entries.find((e) => e.name === 'src');

      expect(srcDir).toBeDefined();
      expect(srcDir?.type).toBe('directory');
      expect(srcDir?.children).toEqual([]);
      expect(srcDir?.rootFolderId).toBe('mock-root');
      expect(srcDir?.isVisible).toBe(true);
    });
  });

  describe('readFile', () => {
    beforeEach(() => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      adapter.setMockFileSystem(mockFS);
    });

    it('should read file content', async () => {
      const handle = {
        path: 'mock-root/package.json',
        name: 'package.json',
        kind: 'file' as const,
        platform: 'web' as const,
        _internal: {
          name: 'package.json',
          type: 'file' as const,
          content: '{"name": "test-package", "version": "1.0.0"}',
        },
      };

      const content = await adapter.readFile(handle);
      expect(content).toBe('{"name": "test-package", "version": "1.0.0"}');
    });

    it('should return empty string for files without content', async () => {
      const handle = {
        path: 'mock-root/empty.txt',
        name: 'empty.txt',
        kind: 'file' as const,
        platform: 'web' as const,
        _internal: {
          name: 'empty.txt',
          type: 'file' as const,
        },
      };

      const content = await adapter.readFile(handle);
      expect(content).toBe('');
    });

    it('should throw error for non-file handles', async () => {
      const handle = {
        path: 'mock-root/src',
        name: 'src',
        kind: 'file' as const,
        platform: 'web' as const,
        _internal: {
          name: 'src',
          type: 'directory' as const,
        },
      };

      await expect(adapter.readFile(handle)).rejects.toThrow('File not found: mock-root/src');
    });

    it('should throw error for missing internal data', async () => {
      const handle = {
        path: 'mock-root/missing.txt',
        name: 'missing.txt',
        kind: 'file' as const,
        platform: 'web' as const,
        _internal: null,
      };

      await expect(adapter.readFile(handle)).rejects.toThrow(
        'File not found: mock-root/missing.txt'
      );
    });
  });

  describe('exists', () => {
    beforeEach(() => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      adapter.setMockFileSystem(mockFS);
    });

    it('should return false when no directory is selected', async () => {
      const freshAdapter = new MockFileSystemAdapter();
      const exists = await freshAdapter.exists('any/path');
      expect(exists).toBe(false);
    });

    it('should return true for existing files', async () => {
      await adapter.requestDirectoryAccess();
      const exists = await adapter.exists('mock-root/package.json');
      expect(exists).toBe(true);
    });

    it('should return true for existing directories', async () => {
      await adapter.requestDirectoryAccess();
      const exists = await adapter.exists('mock-root/src');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent paths', async () => {
      await adapter.requestDirectoryAccess();
      const exists = await adapter.exists('mock-root/non-existent.txt');
      expect(exists).toBe(false);
    });

    it('should handle nested paths correctly', async () => {
      await adapter.requestDirectoryAccess();
      const exists = await adapter.exists('mock-root/src/components');
      expect(exists).toBe(true);
    });
  });

  describe('createSimpleFileSystem', () => {
    it('should create a valid file system structure', () => {
      const fs = MockFileSystemAdapter.createSimpleFileSystem();

      expect(fs).toHaveProperty('src');
      expect(fs).toHaveProperty('package.json');
      expect(fs).toHaveProperty('README.md');

      expect(fs.src.type).toBe('directory');
      expect(fs.src.children).toHaveProperty('index.ts');
      expect(fs.src.children).toHaveProperty('components');

      expect(fs['package.json'].type).toBe('file');
      expect(fs['package.json'].content).toContain('test-package');

      expect(fs['README.md'].type).toBe('file');
      expect(fs['README.md'].content).toContain('# Test Project');
    });

    it('should create nested directory structure', () => {
      const fs = MockFileSystemAdapter.createSimpleFileSystem();
      const components = fs.src.children?.components;

      expect(components).toBeDefined();
      expect(components?.type).toBe('directory');
      expect(components?.children).toHaveProperty('Button.tsx');
      expect(components?.children).toHaveProperty('Input.tsx');

      expect(components?.children?.['Button.tsx'].type).toBe('file');
      expect(components?.children?.['Button.tsx'].content).toContain('Button');
    });
  });

  describe('integration scenarios', () => {
    it('should work with the complete file explorer workflow', async () => {
      // Set up a file system
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      adapter.setMockFileSystem(mockFS);

      // Request directory access
      const rootHandle = await adapter.requestDirectoryAccess();
      expect(rootHandle.name).toBe('mock-root');

      // Read root directory
      const rootEntries = await adapter.readDirectory(rootHandle);
      expect(rootEntries.length).toBeGreaterThan(0);

      // Find and read a subdirectory
      const srcDir = rootEntries.find((e) => e.name === 'src' && e.type === 'directory');
      expect(srcDir).toBeDefined();

      expect(srcDir).toBeDefined();
      const srcHandle = {
        path: srcDir?.path ?? '',
        name: srcDir?.name ?? '',
        kind: 'directory' as const,
        platform: 'web' as const,
      };

      const srcEntries = await adapter.readDirectory(srcHandle);
      expect(srcEntries.length).toBeGreaterThan(0);

      // Find and read a file
      const indexFile = srcEntries.find((e) => e.name === 'index.ts' && e.type === 'file');
      expect(indexFile).toBeDefined();

      expect(indexFile).toBeDefined();
      const content = await adapter.readFile(indexFile?.handle as unknown as FileHandle);
      expect(content).toContain('export');
    });

    it('should handle custom file system structures', async () => {
      const customFS = {
        'custom.txt': {
          name: 'custom.txt',
          type: 'file' as const,
          content: 'custom content',
        },
        'custom-dir': {
          name: 'custom-dir',
          type: 'directory' as const,
          children: {
            'nested.txt': {
              name: 'nested.txt',
              type: 'file' as const,
              content: 'nested content',
            },
          },
        },
      };

      adapter.setMockFileSystem(customFS);
      const rootHandle = await adapter.requestDirectoryAccess();
      const entries = await adapter.readDirectory(rootHandle);

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name)).toContain('custom.txt');
      expect(entries.map((e) => e.name)).toContain('custom-dir');
    });
  });
});
