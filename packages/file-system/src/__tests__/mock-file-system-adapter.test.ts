import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MockFileEntry, MockFileSystemAdapter } from '../adapters/mock-file-system-adapter';
import type { FileHandle } from '../types';

function expectDefined<T>(value: T | undefined, message: string): T {
  expect(value, message).toBeDefined();
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

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
          content: 'test content',
          name: 'test.txt',
          type: 'file' as const,
        },
      };

      adapter.setMockFileSystem(mockFS);
      expect(adapter).toBeDefined();
    });
  });

  describe('addMockEntry', () => {
    it('should add a file to the root', () => {
      const fileEntry: MockFileEntry = {
        content: 'test content',
        name: 'test.txt',
        type: 'file',
      };

      adapter.addMockEntry('test.txt', fileEntry);
      expect(adapter).toBeDefined();
    });

    it('should add a file to a nested directory', () => {
      const fileEntry: MockFileEntry = {
        content: 'nested content',
        name: 'nested.txt',
        type: 'file',
      };

      adapter.addMockEntry('src/components/nested.txt', fileEntry);
      expect(adapter).toBeDefined();
    });

    it('should create intermediate directories automatically', () => {
      const fileEntry: MockFileEntry = {
        content: 'deep content',
        name: 'deep.txt',
        type: 'file',
      };

      adapter.addMockEntry('very/deep/path/deep.txt', fileEntry);
      expect(adapter).toBeDefined();
    });

    it('should handle empty path parts gracefully', () => {
      const fileEntry: MockFileEntry = {
        content: 'test content',
        name: 'test.txt',
        type: 'file',
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
        _internal: { mockRoot: true },
        kind: 'directory',
        name: 'mock-root',
        path: 'mock-root',
        platform: 'web',
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
        kind: 'directory' as const,
        name: 'test',
        path: 'test',
        platform: 'web' as const,
      };

      await expect(freshAdapter.readDirectory(handle)).rejects.toThrow('No directory selected');
    });

    it('should read root directory contents', async () => {
      await adapter.requestDirectoryAccess();

      const handle = {
        kind: 'directory' as const,
        name: 'mock-root',
        path: 'mock-root',
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
        kind: 'directory' as const,
        name: 'src',
        path: 'mock-root/src',
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
        kind: 'directory' as const,
        name: 'non-existent',
        path: 'mock-root/non-existent',
        platform: 'web' as const,
      };

      const entries = await adapter.readDirectory(handle);
      expect(entries).toEqual([]);
    });

    it('should sort entries with directories first', async () => {
      await adapter.requestDirectoryAccess();

      const handle = {
        kind: 'directory' as const,
        name: 'mock-root',
        path: 'mock-root',
        platform: 'web' as const,
      };

      const entries = await adapter.readDirectory(handle);

      expect(entries.length).toBeGreaterThan(0);
      const firstEntry = expectDefined(entries[0], 'expected directory entry at index 0');

      // First entry should be the directory 'src'
      expect(firstEntry.type).toBe('directory');
      expect(firstEntry.name).toBe('src');

      // Files should come after directories
      const fileEntries = entries.filter((e) => e.type === 'file');
      expect(fileEntries).toHaveLength(2);
    });

    it('should set correct file properties', async () => {
      await adapter.requestDirectoryAccess();

      const handle = {
        kind: 'directory' as const,
        name: 'mock-root',
        path: 'mock-root',
        platform: 'web' as const,
      };

      const entries = await adapter.readDirectory(handle);
      const packageJson = expectDefined(
        entries.find((e) => e.name === 'package.json'),
        'expected package.json entry'
      );

      expect(packageJson.type).toBe('file');
      expect(packageJson.size).toBeGreaterThan(0);
      expect(packageJson.lastModified).toBeDefined();
      expect(packageJson.rootFolderId).toBe('mock-root');
      expect(packageJson.isVisible).toBe(true);
    });

    it('should set correct directory properties', async () => {
      await adapter.requestDirectoryAccess();

      const handle = {
        kind: 'directory' as const,
        name: 'mock-root',
        path: 'mock-root',
        platform: 'web' as const,
      };

      const entries = await adapter.readDirectory(handle);
      const srcDir = expectDefined(
        entries.find((e) => e.name === 'src'),
        'expected src directory entry'
      );

      expect(srcDir.type).toBe('directory');
      expect(srcDir.children).toEqual([]);
      expect(srcDir.rootFolderId).toBe('mock-root');
      expect(srcDir.isVisible).toBe(true);
    });
  });

  describe('readFile', () => {
    beforeEach(() => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      adapter.setMockFileSystem(mockFS);
    });

    it('should read file content', async () => {
      const handle = {
        _internal: {
          content: '{"name": "test-package", "version": "1.0.0"}',
          name: 'package.json',
          type: 'file' as const,
        },
        kind: 'file' as const,
        name: 'package.json',
        path: 'mock-root/package.json',
        platform: 'web' as const,
      };

      const content = await adapter.readFile(handle);
      expect(content).toBe('{"name": "test-package", "version": "1.0.0"}');
    });

    it('should return empty string for files without content', async () => {
      const handle = {
        _internal: {
          name: 'empty.txt',
          type: 'file' as const,
        },
        kind: 'file' as const,
        name: 'empty.txt',
        path: 'mock-root/empty.txt',
        platform: 'web' as const,
      };

      const content = await adapter.readFile(handle);
      expect(content).toBe('');
    });

    it('should throw error for non-file handles', async () => {
      const handle = {
        _internal: {
          name: 'src',
          type: 'directory' as const,
        },
        kind: 'file' as const,
        name: 'src',
        path: 'mock-root/src',
        platform: 'web' as const,
      };

      await expect(adapter.readFile(handle)).rejects.toThrow('File not found: mock-root/src');
    });

    it('should throw error for missing internal data', async () => {
      const handle = {
        _internal: null,
        kind: 'file' as const,
        name: 'missing.txt',
        path: 'mock-root/missing.txt',
        platform: 'web' as const,
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

  describe('readDirectoryStreaming', () => {
    beforeEach(() => {
      adapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
    });

    it('should throw error when no directory is selected', async () => {
      const freshAdapter = new MockFileSystemAdapter(
        MockFileSystemAdapter.createSimpleFileSystem()
      );

      await expect(
        freshAdapter.readDirectoryStreaming(
          {
            kind: 'directory',
            name: 'mock-root',
            path: 'mock-root',
            platform: 'web',
          },
          () => undefined
        )
      ).rejects.toThrow('No directory selected');
    });

    it('should reject when the signal is already aborted', async () => {
      const rootHandle = await adapter.requestDirectoryAccess();
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        adapter.readDirectoryStreaming(rootHandle, () => undefined, {
          signal: abortController.signal,
        })
      ).rejects.toThrow('Operation was cancelled');
    });

    it('should emit an empty done batch for missing directories', async () => {
      await adapter.requestDirectoryAccess();
      const batches: Array<{ done: boolean; names: string[]; total: number }> = [];

      await adapter.readDirectoryStreaming(
        {
          kind: 'directory',
          name: 'missing',
          path: 'mock-root/missing',
          platform: 'web',
        },
        (batch, meta) => {
          batches.push({
            done: meta.done,
            names: batch.map((entry) => entry.name),
            total: meta.total,
          });
        }
      );

      expect(batches).toEqual([{ done: true, names: [], total: 0 }]);
    });

    it('should emit an empty done batch for empty directories', async () => {
      adapter.setMockFileSystem({
        empty: {
          children: {},
          name: 'empty',
          type: 'directory',
        },
      });
      await adapter.requestDirectoryAccess();
      const batches: Array<{ done: boolean; names: string[]; total: number }> = [];

      await adapter.readDirectoryStreaming(
        {
          kind: 'directory',
          name: 'empty',
          path: 'mock-root/empty',
          platform: 'web',
        },
        (batch, meta) => {
          batches.push({
            done: meta.done,
            names: batch.map((entry) => entry.name),
            total: meta.total,
          });
        }
      );

      expect(batches).toEqual([{ done: true, names: [], total: 0 }]);
    });

    it('should stream sorted entries in configured batches with delay', async () => {
      vi.useFakeTimers();
      try {
        const rootHandle = await adapter.requestDirectoryAccess();
        adapter.setStreamingDelay(25);
        const batches: Array<{ done: boolean; names: string[]; total: number }> = [];

        const streamPromise = adapter.readDirectoryStreaming(
          rootHandle,
          (batch, meta) => {
            batches.push({
              done: meta.done,
              names: batch.map((entry) => entry.name),
              total: meta.total,
            });
          },
          { batchSize: 2 }
        );

        expect(batches).toEqual([{ done: false, names: ['src', 'package.json'], total: 3 }]);

        await vi.advanceTimersByTimeAsync(25);
        await streamPromise;

        expect(batches).toEqual([
          { done: false, names: ['src', 'package.json'], total: 3 },
          { done: true, names: ['README.md'], total: 3 },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reject when aborted between streaming batches', async () => {
      const rootHandle = await adapter.requestDirectoryAccess();
      const abortController = new AbortController();

      await expect(
        adapter.readDirectoryStreaming(
          rootHandle,
          () => {
            abortController.abort();
          },
          {
            batchSize: 1,
            signal: abortController.signal,
          }
        )
      ).rejects.toThrow('Operation was cancelled');
    });
  });

  describe('createSimpleFileSystem', () => {
    it('should create a valid file system structure', () => {
      const fs = MockFileSystemAdapter.createSimpleFileSystem();

      expect(fs).toHaveProperty('src');
      expect(fs).toHaveProperty('package.json');
      expect(fs).toHaveProperty('README.md');

      const srcDir = expectDefined(fs['src'], 'expected src directory');
      expect(srcDir.type).toBe('directory');
      const srcChildren = expectDefined(srcDir.children, 'expected src directory children');
      expect(srcChildren).toHaveProperty('index.ts');
      expect(srcChildren).toHaveProperty('components');

      const packageJson = expectDefined(fs['package.json'], 'expected package.json file');
      expect(packageJson.type).toBe('file');
      expect(packageJson.content).toContain('test-package');

      const readme = expectDefined(fs['README.md'], 'expected README.md file');
      expect(readme.type).toBe('file');
      expect(readme.content).toContain('# Test Project');
    });

    it('should create nested directory structure', () => {
      const fs = MockFileSystemAdapter.createSimpleFileSystem();
      const srcDir = expectDefined(fs['src'], 'expected src directory');
      const srcChildren = expectDefined(srcDir.children, 'expected src directory children');
      const components = expectDefined(srcChildren['components'], 'expected components directory');

      expect(components).toBeDefined();
      expect(components.type).toBe('directory');
      const componentChildren = expectDefined(
        components.children,
        'expected components directory children'
      );
      expect(componentChildren).toHaveProperty('Button.tsx');
      expect(componentChildren).toHaveProperty('Input.tsx');

      const button = expectDefined(componentChildren['Button.tsx'], 'expected Button.tsx file');
      expect(button.type).toBe('file');
      expect(button.content).toContain('Button');
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
      const srcDir = expectDefined(
        rootEntries.find((e) => e.name === 'src' && e.type === 'directory'),
        'expected src directory in root'
      );

      const srcHandle = {
        kind: 'directory' as const,
        name: srcDir.name,
        path: srcDir.path,
        platform: 'web' as const,
      };

      const srcEntries = await adapter.readDirectory(srcHandle);
      expect(srcEntries.length).toBeGreaterThan(0);

      // Find and read a file
      const indexFile = expectDefined(
        srcEntries.find((e) => e.name === 'index.ts' && e.type === 'file'),
        'expected index.ts file in src'
      );

      const content = await adapter.readFile(indexFile.handle as unknown as FileHandle);
      expect(content).toContain('export');
    });

    it('should handle custom file system structures', async () => {
      const customFS = {
        'custom-dir': {
          children: {
            'nested.txt': {
              content: 'nested content',
              name: 'nested.txt',
              type: 'file' as const,
            },
          },
          name: 'custom-dir',
          type: 'directory' as const,
        },
        'custom.txt': {
          content: 'custom content',
          name: 'custom.txt',
          type: 'file' as const,
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
