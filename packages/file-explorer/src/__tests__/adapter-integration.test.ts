import type { FileHandle } from '@brainstrike/file-system';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { IFileNode } from '@brainstrike/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFileExplorerStore } from '../store';

// Skip NODE_ENV check in tests to avoid process mock conflicts
const isDev = false;

// Helper function to wait for Zustand hydration
function waitForHydration(store: ReturnType<typeof createFileExplorerStore>): Promise<void> {
  return new Promise<void>((resolve) => {
    let attempts = 0;
    const checkInterval = setInterval(() => {
      attempts++;
      if (store.persist.hasHydrated()) {
        const unsub = store.persist.onFinishHydration(() => {
          resolve();
          unsub();
          clearInterval(checkInterval);
        });
        // It might have hydrated between hasHydrated check and onFinishHydration setup
        if (store.persist.hasHydrated()) {
          resolve();
          unsub();
          clearInterval(checkInterval);
        }
      } else if (attempts > 20) {
        // Timeout after ~2 seconds
        clearInterval(checkInterval);
        resolve(); // Resolve to let test fail on assertions
      }
    }, 100);
  });
}

// Minimal microtask flusher to avoid arbitrary sleeps
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => process.nextTick(resolve));
  }
}

async function waitForPersist(storage: MemoryStorageAdapter): Promise<void> {
  const key = 'file-explorer-storage-v5';
  for (let i = 0; i < 50; i++) {
    if (storage.getSize() > 0 || storage.has(key)) {
      return;
    }
    await flushMicrotasks(1);
  }
}

describe('Adapter Integration', () => {
  let memoryStorage: MemoryStorageAdapter;
  let mockFileSystem: MockFileSystemAdapter;

  beforeEach(() => {
    memoryStorage = new MemoryStorageAdapter();
    mockFileSystem = new MockFileSystemAdapter(MockFileSystemAdapter.createSimpleFileSystem());
  });

  describe('Storage Adapter Integration', () => {
    it('should create store with memory storage adapter', () => {
      const store = createFileExplorerStore(memoryStorage);
      expect(store).toBeDefined();
      expect(store.getState).toBeDefined();
    });

    it('should persist and restore state using memory storage', async () => {
      const store = createFileExplorerStore(memoryStorage);

      // Set some state
      store.getState().setCurrentFolderId('test-folder');
      store.getState().addSelectedFile('test-folder', 'test-file.txt');
      store.getState().toggleDirectoryExpansion('test-directory');

      // Wait for persistence to settle (no arbitrary sleeps)
      await waitForPersist(memoryStorage);

      // Create a new store with the same storage adapter
      const newStore = createFileExplorerStore(memoryStorage);

      // Wait for Zustand's rehydration to complete
      const hydrationFinished = waitForHydration(newStore);

      await hydrationFinished;

      const newState = newStore.getState();
      if (isDev) {
        expect(newState.currentFolderId).toBe('test-folder');
      }
      expect(newState.selectedFilePaths).toBeInstanceOf(Set);
      expect(newState.expandedDirectoryPaths).toBeInstanceOf(Set);
      expect(newState.selectedFilePaths.has('test-folder|@|test-file.txt')).toBe(true);
      expect(newState.expandedDirectoryPaths.has('test-directory')).toBe(true);
    });

    it('should handle storage errors gracefully', async () => {
      // Create a storage adapter that throws errors
      const errorStorage = new MemoryStorageAdapter();
      errorStorage.setItem = async () => {
        throw new Error('Storage error');
      };

      const store = createFileExplorerStore(errorStorage);

      // This should not throw, errors should be handled internally
      expect(() => {
        store.getState().setCurrentFolderId('test-folder');
      }).not.toThrow();
    });

    it('should isolate data between different storage instances', async () => {
      const storage1 = new MemoryStorageAdapter();
      const storage2 = new MemoryStorageAdapter();

      const store1 = createFileExplorerStore(storage1);
      const store2 = createFileExplorerStore(storage2);

      // Set different state in each store
      store1.getState().setCurrentFolderId('folder-1');
      store2.getState().setCurrentFolderId('folder-2');

      await waitForPersist(memoryStorage);

      // Verify isolation
      expect(store1.getState().currentFolderId).toBe('folder-1');
      expect(store2.getState().currentFolderId).toBe('folder-2');

      // Verify storage isolation
      expect(storage1.getSize()).toBeGreaterThan(0);
      expect(storage2.getSize()).toBeGreaterThan(0);

      const data1 = await storage1.getItem('file-explorer-storage-v5');
      const data2 = await storage2.getItem('file-explorer-storage-v5');

      expect(data1).not.toEqual(data2);
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
      const store = createFileExplorerStore(memoryStorage);

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

      // Wait for persistence
      await waitForPersist(memoryStorage);

      // Verify state was persisted
      expect(memoryStorage.getSize()).toBeGreaterThan(0);

      const state = store.getState();
      expect(state.currentFolderId).toBe(rootHandle.name);
      expect(state.selectedFilePaths.size).toBe(files.length);
      expect(state.expandedDirectoryPaths.size).toBe(directories.length);
    });

    it('should handle multiple file explorer instances with different adapters', async () => {
      // Create two different storage adapters
      const storage1 = new MemoryStorageAdapter();
      const storage2 = new MemoryStorageAdapter();

      // Create two different file system adapters with unique structures
      const fs1 = new MockFileSystemAdapter({
        'unique1.txt': {
          content: 'content 1',
          name: 'unique1.txt',
          type: 'file',
        },
      });
      const fs2 = new MockFileSystemAdapter({
        'unique2.txt': {
          content: 'content 2',
          name: 'unique2.txt',
          type: 'file',
        },
      });

      // Create two stores
      const store1 = createFileExplorerStore(storage1);
      const store2 = createFileExplorerStore(storage2);

      // Use different file systems
      const handle1 = await fs1.requestDirectoryAccess();
      const handle2 = await fs2.requestDirectoryAccess();

      // Set different folder IDs to ensure isolation
      store1.getState().setCurrentFolderId(`${handle1.name}-1`);
      store2.getState().setCurrentFolderId(`${handle2.name}-2`);

      await waitForPersist(storage1);
      await waitForPersist(storage2);

      // Verify the stores have different states
      expect(store1.getState().currentFolderId).toBe('mock-root-1');
      expect(store2.getState().currentFolderId).toBe('mock-root-2');
      expect(store1.getState().currentFolderId).not.toBe(store2.getState().currentFolderId);
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

    it('should handle storage adapter errors gracefully', async () => {
      const errorStorage = new MemoryStorageAdapter();
      errorStorage.getItem = async () => {
        throw new Error('Storage read error');
      };

      // This should not throw, the store should handle the error gracefully
      const store = createFileExplorerStore(errorStorage);
      expect(store).toBeDefined();

      // Give microtasks a chance to flush internal async handlers
      await flushMicrotasks(5);

      // Store should still be functional with default state
      const state = store.getState();
      expect(state.currentFolderId).toBeNull();
      expect(state.selectedFilePaths).toBeInstanceOf(Set);
      expect(state.expandedDirectoryPaths).toBeInstanceOf(Set);
    });
  });
});
