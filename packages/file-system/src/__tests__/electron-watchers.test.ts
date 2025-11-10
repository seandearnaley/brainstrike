import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleWatcherSetupError,
  startChokidarWatch,
  startFsWatch,
} from '../adapters/electron-watchers';
import type { DirectoryHandle, FileSystemChange } from '../types';

// Helper to wait for async conditions
async function waitForCondition(
  check: () => boolean,
  timeoutMs = 1000,
  intervalMs = 10
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitForCondition timed out');
}

describe('electron-watchers', () => {
  let tempDir: string;
  let handle: DirectoryHandle;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-watchers-test-'));
    tempDir = fs.realpathSync(tempDir);
    handle = {
      path: tempDir,
      name: path.basename(tempDir),
      kind: 'directory',
      platform: 'electron',
    };
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('startFsWatch', () => {
    it('should watch for file additions', async () => {
      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = startFsWatch(handle, callback);

      // Create a new file
      const filePath = path.join(tempDir, 'new-file.txt');
      await fsPromises.writeFile(filePath, 'test content');

      // Wait for the change event
      await waitForCondition(() => changes.length > 0, 2000);

      expect(changes.length).toBeGreaterThan(0);
      const addedEvent = changes.find((c) => c.type === 'added' && c.path === filePath);
      expect(addedEvent).toBeDefined();
      expect(addedEvent?.kind).toBe('file');

      stop();
    });

    it('should watch for file modifications', async () => {
      const filePath = path.join(tempDir, 'existing-file.txt');
      await fsPromises.writeFile(filePath, 'initial content');

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = startFsWatch(handle, callback);

      // Modify the file
      await fsPromises.writeFile(filePath, 'modified content');

      // Wait for the change event
      await waitForCondition(() => changes.length > 0, 2000);

      expect(changes.length).toBeGreaterThan(0);
      const modifiedEvent = changes.find((c) => c.type === 'modified' && c.path === filePath);
      expect(modifiedEvent).toBeDefined();

      stop();
    });

    it('should watch for file removals', async () => {
      const filePath = path.join(tempDir, 'file-to-remove.txt');
      await fsPromises.writeFile(filePath, 'content');

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = startFsWatch(handle, callback);

      // Remove the file
      await fsPromises.unlink(filePath);

      // Wait for the change event
      await waitForCondition(() => changes.length > 0, 2000);

      expect(changes.length).toBeGreaterThan(0);
      const removedEvent = changes.find((c) => c.type === 'removed' && c.path === filePath);
      expect(removedEvent).toBeDefined();
      expect(removedEvent?.kind).toBe('file');

      stop();
    });

    it('should watch for directory additions', async () => {
      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = startFsWatch(handle, callback);

      // Create a new directory
      const dirPath = path.join(tempDir, 'new-dir');
      await fsPromises.mkdir(dirPath);

      // Wait for the change event
      await waitForCondition(() => changes.length > 0, 2000);

      expect(changes.length).toBeGreaterThan(0);
      const addedEvent = changes.find((c) => c.type === 'added' && c.path === dirPath);
      expect(addedEvent).toBeDefined();
      expect(addedEvent?.kind).toBe('directory');

      stop();
    });

    it('should watch for directory removals', async () => {
      const dirPath = path.join(tempDir, 'dir-to-remove');
      await fsPromises.mkdir(dirPath);

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = startFsWatch(handle, callback);

      // Remove the directory
      await fsPromises.rmdir(dirPath);

      // Wait for the change event
      await waitForCondition(() => changes.length > 0, 2000);

      expect(changes.length).toBeGreaterThan(0);
      const removedEvent = changes.find((c) => c.type === 'removed' && c.path === dirPath);
      expect(removedEvent).toBeDefined();
      expect(removedEvent?.kind).toBe('file'); // fs.watch may report as file if dir doesn't exist

      stop();
    });

    it('should ignore events without filename', async () => {
      const changes: FileSystemChange[] = [];
      const callback = vi.fn((changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      });

      // Mock fs.watch to emit event without filename
      const mockWatcher = {
        close: vi.fn(),
      };
      // Create mock function with correct type to satisfy all fs.watch overloads
      const mockFsWatch: typeof fs.watch = ((...args: unknown[]) => {
        // Emit an event without filename
        const listener = args.find((arg) => typeof arg === 'function') as
          | fs.WatchListener<string>
          | undefined;
        setTimeout(() => {
          if (typeof listener === 'function') {
            listener('rename', null);
          }
        }, 10);
        return mockWatcher as unknown as ReturnType<typeof fs.watch>;
      }) as typeof fs.watch;

      const fsWatchSpy = vi.spyOn(fs, 'watch').mockImplementation(mockFsWatch);

      const stop = startFsWatch(handle, callback);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Callback should not have been called
      expect(callback).not.toHaveBeenCalled();
      expect(changes).toHaveLength(0);

      stop();
      expect(mockWatcher.close).toHaveBeenCalled();
      fsWatchSpy.mockRestore();
    });

    it('should handle stat errors gracefully', async () => {
      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = startFsWatch(handle, callback);

      // Create a file then immediately remove it to cause stat to potentially fail
      const filePath = path.join(tempDir, 'race-condition.txt');
      await fsPromises.writeFile(filePath, 'content');
      await fsPromises.unlink(filePath);

      // Wait a bit for any events
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not throw, but may or may not capture the events depending on timing
      expect(() => stop()).not.toThrow();
    });

    it('should return noop stop function when watch fails', () => {
      const invalidHandle: DirectoryHandle = {
        path: '/definitely/does/not/exist/path/12345',
        name: 'nonexistent',
        kind: 'directory',
        platform: 'electron',
      };

      const callback = vi.fn();
      const stop = startFsWatch(invalidHandle, callback);

      // Should return a function that can be called without throwing
      expect(typeof stop).toBe('function');
      expect(() => stop()).not.toThrow();
      expect(callback).not.toHaveBeenCalled();
    });

    it('should stop watching when stop function is called', async () => {
      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = startFsWatch(handle, callback);

      // Create a file before stopping
      const filePath1 = path.join(tempDir, 'before-stop.txt');
      await fsPromises.writeFile(filePath1, 'content');

      await waitForCondition(() => changes.length > 0, 2000);
      const changeCountBeforeStop = changes.length;

      // Stop watching
      stop();

      // Create another file after stopping
      const filePath2 = path.join(tempDir, 'after-stop.txt');
      await fsPromises.writeFile(filePath2, 'content');

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // No new changes should be captured
      expect(changes.length).toBe(changeCountBeforeStop);
    });

    it('should not recurse into subdirectories', async () => {
      const subDir = path.join(tempDir, 'subdir');
      await fsPromises.mkdir(subDir);

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = startFsWatch(handle, callback);

      // Create a file in the subdirectory
      const filePath = path.join(subDir, 'nested-file.txt');
      await fsPromises.writeFile(filePath, 'content');

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not capture events from subdirectory (recursive: false)
      const nestedEvent = changes.find((c) => c.path === filePath);
      expect(nestedEvent).toBeUndefined();

      stop();
    });
  });

  describe('startChokidarWatch', () => {
    it('should watch for file additions with chokidar', async () => {
      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = await startChokidarWatch(handle, callback);

      // Wait for chokidar to initialize
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Create a new file
      const filePath = path.join(tempDir, 'chokidar-file.txt');
      await fsPromises.writeFile(filePath, 'test content');

      // Wait for the change event
      await waitForCondition(() => changes.length > 0, 3000);

      expect(changes.length).toBeGreaterThan(0);
      const addedEvent = changes.find((c) => c.type === 'added' && c.path === filePath);
      expect(addedEvent).toBeDefined();
      expect(addedEvent?.kind).toBe('file');

      await stop();
    });

    it('should watch for directory additions with chokidar', async () => {
      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = await startChokidarWatch(handle, callback);

      // Wait for chokidar to initialize
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Create a new directory
      const dirPath = path.join(tempDir, 'chokidar-dir');
      await fsPromises.mkdir(dirPath);

      // Wait for the change event
      await waitForCondition(() => changes.length > 0, 3000);

      expect(changes.length).toBeGreaterThan(0);
      const addedEvent = changes.find((c) => c.type === 'added' && c.path === dirPath);
      expect(addedEvent).toBeDefined();
      expect(addedEvent?.kind).toBe('directory');

      await stop();
    });

    it('should watch for file modifications with chokidar', async () => {
      const filePath = path.join(tempDir, 'chokidar-modify.txt');
      await fsPromises.writeFile(filePath, 'initial');

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = await startChokidarWatch(handle, callback);

      // Wait for chokidar to initialize
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Modify the file
      await fsPromises.writeFile(filePath, 'modified');

      // Wait for the change event
      await waitForCondition(() => changes.length > 0, 3000);

      expect(changes.length).toBeGreaterThan(0);
      const modifiedEvent = changes.find((c) => c.type === 'modified' && c.path === filePath);
      expect(modifiedEvent).toBeDefined();
      expect(modifiedEvent?.kind).toBe('file');

      await stop();
    });

    it('should watch for file removals with chokidar', async () => {
      const filePath = path.join(tempDir, 'chokidar-remove.txt');
      await fsPromises.writeFile(filePath, 'content');

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = await startChokidarWatch(handle, callback);

      // Wait for chokidar to initialize
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Remove the file
      await fsPromises.unlink(filePath);

      // Wait for the change event
      await waitForCondition(() => changes.length > 0, 3000);

      expect(changes.length).toBeGreaterThan(0);
      const removedEvent = changes.find((c) => c.type === 'removed' && c.path === filePath);
      expect(removedEvent).toBeDefined();
      expect(removedEvent?.kind).toBe('file');

      await stop();
    });

    it('should watch for directory removals with chokidar', async () => {
      const dirPath = path.join(tempDir, 'chokidar-remove-dir');
      await fsPromises.mkdir(dirPath);

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = await startChokidarWatch(handle, callback);

      // Wait for chokidar to initialize
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Remove the directory
      await fsPromises.rmdir(dirPath);

      // Wait for the change event
      await waitForCondition(() => changes.length > 0, 3000);

      expect(changes.length).toBeGreaterThan(0);
      const removedEvent = changes.find((c) => c.type === 'removed' && c.path === dirPath);
      expect(removedEvent).toBeDefined();
      expect(removedEvent?.kind).toBe('directory');

      await stop();
    });

    it('should ignore initial files (ignoreInitial: true)', async () => {
      // Create files before starting the watcher
      await fsPromises.writeFile(path.join(tempDir, 'existing1.txt'), 'content1');
      await fsPromises.writeFile(path.join(tempDir, 'existing2.txt'), 'content2');

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = await startChokidarWatch(handle, callback);

      // Wait for chokidar to initialize
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Should not have captured existing files
      expect(changes).toHaveLength(0);

      await stop();
    });

    it('should ignore dotfiles', async () => {
      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = await startChokidarWatch(handle, callback);

      // Wait for chokidar to initialize
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Create a dotfile
      const dotFilePath = path.join(tempDir, '.hidden');
      await fsPromises.writeFile(dotFilePath, 'secret');

      // Also create a normal file to ensure watcher is working
      const normalFilePath = path.join(tempDir, 'normal.txt');
      await fsPromises.writeFile(normalFilePath, 'visible');

      // Wait for changes
      await waitForCondition(() => changes.length > 0, 3000);

      // Should have captured the normal file but not the dotfile
      const dotFileEvent = changes.find((c) => c.path === dotFilePath);
      const normalFileEvent = changes.find((c) => c.path === normalFilePath);

      expect(dotFileEvent).toBeUndefined();
      expect(normalFileEvent).toBeDefined();

      await stop();
    });

    it('should not watch subdirectories (depth: 0)', async () => {
      const subDir = path.join(tempDir, 'subdir');
      await fsPromises.mkdir(subDir);

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = await startChokidarWatch(handle, callback);

      // Wait for chokidar to initialize
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Clear any directory creation events
      changes.length = 0;

      // Create a file in subdirectory
      const filePath = path.join(subDir, 'nested.txt');
      await fsPromises.writeFile(filePath, 'content');

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Should not capture events from subdirectory
      const nestedEvent = changes.find((c) => c.path === filePath);
      expect(nestedEvent).toBeUndefined();

      await stop();
    });

    it('should handle errors gracefully', async () => {
      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = await startChokidarWatch(handle, callback);

      // Wait for initialization
      await new Promise((resolve) => setTimeout(resolve, 200));

      // The watcher should be running and can be stopped
      await expect(stop()).resolves.toBeUndefined();
    });

    it('should handle awaitWriteFinish configuration', async () => {
      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = await startChokidarWatch(handle, callback);

      // Wait for chokidar to initialize
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Write to file multiple times rapidly
      const filePath = path.join(tempDir, 'rapid-write.txt');
      await fsPromises.writeFile(filePath, 'content1');
      await fsPromises.writeFile(filePath, 'content2');
      await fsPromises.writeFile(filePath, 'content3');

      // Wait for stabilization (100ms threshold + 100ms poll interval)
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should have received the add event
      const addEvents = changes.filter(
        (c) => c.type === 'added' && c.path === filePath
      );
      expect(addEvents.length).toBeGreaterThanOrEqual(1);

      await stop();
    });
  });

  describe('handleWatcherSetupError', () => {
    it('should fall back to startFsWatch for MODULE_NOT_FOUND error', async () => {
      const error = new Error('Cannot find module') as NodeJS.ErrnoException;
      error.code = 'MODULE_NOT_FOUND';

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = handleWatcherSetupError(error, handle, callback);

      // Should have started fs.watch as fallback
      const filePath = path.join(tempDir, 'fallback-file.txt');
      await fsPromises.writeFile(filePath, 'content');

      // Wait for change event
      await waitForCondition(() => changes.length > 0, 2000);

      expect(changes.length).toBeGreaterThan(0);
      const addedEvent = changes.find((c) => c.type === 'added');
      expect(addedEvent).toBeDefined();

      stop();
    });

    it('should fall back to startFsWatch for non-MODULE_NOT_FOUND errors', async () => {
      const error = new Error('Some other error') as NodeJS.ErrnoException;
      error.code = 'EACCES';

      const changes: FileSystemChange[] = [];
      const callback = (changeList: FileSystemChange[]) => {
        changes.push(...changeList);
      };

      const stop = handleWatcherSetupError(error, handle, callback);

      // Should still fall back to fs.watch
      const filePath = path.join(tempDir, 'fallback-file2.txt');
      await fsPromises.writeFile(filePath, 'content');

      // Wait for change event
      await waitForCondition(() => changes.length > 0, 2000);

      expect(changes.length).toBeGreaterThan(0);

      stop();
    });

    it('should handle errors without code property', () => {
      const error = new Error('Plain error');

      const callback = vi.fn();
      const stop = handleWatcherSetupError(error, handle, callback);

      // Should return a stop function
      expect(typeof stop).toBe('function');
      expect(() => stop()).not.toThrow();
    });

    it('should handle non-Error objects', () => {
      const error = 'string error';

      const callback = vi.fn();
      const stop = handleWatcherSetupError(error, handle, callback);

      // Should return a stop function
      expect(typeof stop).toBe('function');
      expect(() => stop()).not.toThrow();
    });

    it('should handle null/undefined errors', () => {
      const callback = vi.fn();

      const stop1 = handleWatcherSetupError(null, handle, callback);
      expect(typeof stop1).toBe('function');
      expect(() => stop1()).not.toThrow();

      const stop2 = handleWatcherSetupError(undefined, handle, callback);
      expect(typeof stop2).toBe('function');
      expect(() => stop2()).not.toThrow();
    });
  });
});
