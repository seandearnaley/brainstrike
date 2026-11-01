import type { FileHandle } from '@brainstrike/file-system';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFileExplorerStore } from '../store';

describe('Adapter Integration', () => {
  let mockFileSystem: MockFileSystemAdapter;

  beforeEach(() => {
    localStorage.clear();
    mockFileSystem = new MockFileSystemAdapter(MockFileSystemAdapter.createSimpleFileSystem());
  });

  describe('Persistence', () => {
    it('restores the saved view state when the Explorer opens again', () => {
      const store = createFileExplorerStore();
      store.getState().setCurrentFolderId('test-folder');
      store.getState().addSelectedFile('test-folder', 'test-file.txt');
      store.getState().toggleDirectoryExpansion('test-directory');

      const reopened = createFileExplorerStore().getState();

      expect(reopened.selectedFilePaths.has('test-folder|@|test-file.txt')).toBe(true);
      expect(reopened.expandedDirectoryPaths.has('test-directory')).toBe(true);
    });
  });

  describe('File System Adapter Integration', () => {
    it('should work with mock file system adapter', async () => {
      // Request directory access
      const rootHandle = await mockFileSystem.requestDirectoryAccess();
      expect(rootHandle.name).toBe('mock-root');

      // Read directory contents
      const entries = await mockFileSystem.readDirectory(rootHandle);
      expect(entries.length).toBeGreaterThan(0);

      // Verify expected files exist
      const fileNames = entries.map((e: IFileNode) => e.name);
      expect(fileNames).toContain('src');
      expect(fileNames).toContain('package.json');
      expect(fileNames).toContain('README.md');
    });

    it('should read file contents correctly', async () => {
      const rootHandle = await mockFileSystem.requestDirectoryAccess();
      const entries = await mockFileSystem.readDirectory(rootHandle);

      const packageJson = entries.find((e: IFileNode) => e.name === 'package.json');
      expect(packageJson).toBeDefined();

      if (packageJson) {
        const content = await mockFileSystem.readFile(packageJson.handle as unknown as FileHandle);
        expect(content).toContain('test-package');
        expect(content).toContain('1.0.0');
      }
    });

    it('should handle nested directory navigation', async () => {
      const rootHandle = await mockFileSystem.requestDirectoryAccess();
      const rootEntries = await mockFileSystem.readDirectory(rootHandle);

      const srcDir = rootEntries.find((e: IFileNode) => e.name === 'src' && e.type === 'directory');
      expect(srcDir).toBeDefined();

      if (srcDir) {
        const srcHandle = {
          kind: 'directory' as const,
          name: srcDir.name,
          path: srcDir.path,
          platform: 'web' as const,
        };

        const srcEntries = await mockFileSystem.readDirectory(srcHandle);
        expect(srcEntries.length).toBeGreaterThan(0);

        const componentNames = srcEntries.map((e: IFileNode) => e.name);
        expect(componentNames).toContain('index.ts');
        expect(componentNames).toContain('components');
      }
    });

    it('should support custom file system structures', async () => {
      const customFS = {
        'custom-dir': {
          children: {
            'nested-file.txt': {
              content: 'nested content',
              name: 'nested-file.txt',
              type: 'file' as const,
            },
          },
          name: 'custom-dir',
          type: 'directory' as const,
        },
        'custom-file.txt': {
          content: 'custom content',
          name: 'custom-file.txt',
          type: 'file' as const,
        },
      };

      const customAdapter = new MockFileSystemAdapter(customFS);
      const rootHandle = await customAdapter.requestDirectoryAccess();
      const entries = await customAdapter.readDirectory(rootHandle);

      expect(entries).toHaveLength(2);
      expect(entries.map((e: IFileNode) => e.name)).toContain('custom-file.txt');
      expect(entries.map((e: IFileNode) => e.name)).toContain('custom-dir');
    });
  });

  describe('Combined Adapter Usage', () => {
    it('should work with both adapters in a realistic scenario', async () => {
      const store = createFileExplorerStore();

      // Simulate file system operations
      const rootHandle = await mockFileSystem.requestDirectoryAccess();
      const entries = await mockFileSystem.readDirectory(rootHandle);

      // Set current folder in store
      store.getState().setCurrentFolderId(rootHandle.name);

      // Select some files
      const files = entries.filter((e: IFileNode) => e.type === 'file');
      for (const file of files) {
        store.getState().addSelectedFile(rootHandle.name, file.path);
      }

      // Expand some directories
      const directories = entries.filter((e: IFileNode) => e.type === 'directory');
      for (const dir of directories) {
        store.getState().toggleDirectoryExpansion(dir.path);
      }

      expect(localStorage.getItem('file-explorer-storage-v5')).not.toBeNull();

      const state = store.getState();
      expect(state.currentFolderId).toBe(rootHandle.name);
      expect(state.selectedFilePaths.size).toBe(files.length);
      expect(state.expandedDirectoryPaths.size).toBe(directories.length);
    });
  });

  describe('Error Handling', () => {
    it('should handle file system errors gracefully', async () => {
      const errorFS = new MockFileSystemAdapter();
      // Don't set any mock file system, so it will throw errors

      await expect(errorFS.requestDirectoryAccess()).rejects.toThrow(
        'No mock file system configured'
      );
    });
  });
});
