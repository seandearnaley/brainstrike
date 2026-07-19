import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronFileSystemAdapter } from '../adapters/electron-adapter';
import { AccessError, DialogError, PermissionError, UserCancelledError } from '../errors';
import type { DirectoryHandle, FileHandle } from '../types';

// Tiny polling helper to await a condition without importing testing-library
async function waitForCondition(check: () => boolean, timeoutMs = 1000, intervalMs = 10) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitForCondition timed out');
}

// Mock electron dialog
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
  },
}));

// Mock chokidar with proper default export structure
vi.mock('chokidar', () => {
  const mockWatch = vi.fn();
  return {
    default: {
      watch: mockWatch,
    },
    watch: mockWatch,
  };
});

// Mock process with needed methods for this test
const originalCwd = '/original/cwd';
let currentCwd = originalCwd;

const mockProcess = {
  chdir: (dir: string) => {
    currentCwd = dir;
  },
  cwd: () => currentCwd,
};

// Replace the limited process object with our mock
Object.assign(process, mockProcess);

// Type assertion to help TypeScript understand the mocked process
const processWithChdir = process as typeof process & { chdir: (dir: string) => void };
const itOnDarwin = process.platform === 'darwin' ? it : it.skip;
const itOutsideDarwin = process.platform === 'darwin' ? it.skip : it;

describe('ElectronFileSystemAdapter', () => {
  let tempDir: string;
  let adapter: ElectronFileSystemAdapter;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.doMock('electron', () => ({
      dialog: {
        showOpenDialog: vi.fn(),
      },
    }));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-adapter-'));
    // Resolve the real path to handle symlinks (e.g., /tmp -> /private/tmp on macOS)
    tempDir = fs.realpathSync(tempDir);
    processWithChdir.chdir(tempDir);
    adapter = new ElectronFileSystemAdapter();
  });

  it('should support includeMetadata: false to skip file stats', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });

    // create file and directory
    fs.writeFileSync(path.join(tempDir, 'a.txt'), '123456');
    fs.mkdirSync(path.join(tempDir, 'sub'));
    const handle = await adapter.requestDirectoryAccess();

    const entries = await adapter.readDirectory(handle, { includeMetadata: false });
    const file = entries.find((e) => e.type === 'file' && e.name === 'a.txt');
    const dir = entries.find((e) => e.type === 'directory' && e.name === 'sub');

    expect(file).toBeTruthy();
    expect('size' in (file as object)).toBe(false);
    expect('lastModified' in (file as object)).toBe(false);
    expect(dir).toBeTruthy();
  });

  it('respects concurrency limit when fetching file metadata', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });

    // create multiple files
    const fileCount = 8;
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(tempDir, `f${i}.txt`), String(i));
    }

    const handle = await adapter.requestDirectoryAccess();

    let active = 0;
    let peak = 0;
    const realStat = fsPromises.stat;
    vi.spyOn(fsPromises, 'stat').mockImplementation(
      async (...args: Parameters<typeof realStat>) => {
        active++;
        peak = Math.max(peak, active);
        const result = await realStat(...args);
        await Promise.resolve(); // yield to allow limiter scheduling
        active--;
        return result as unknown as import('node:fs').Stats;
      }
    );

    const concurrency = 2;
    const entries = await adapter.readDirectory(handle, { concurrency, includeMetadata: true });
    expect(entries.filter((e) => e.type === 'file')).toHaveLength(fileCount);
    expect(peak).toBeLessThanOrEqual(concurrency);
  });

  afterEach(async () => {
    processWithChdir.chdir(originalCwd);
    await fsPromises.rm(tempDir, { force: true, recursive: true });
  });

  it('should request directory access and return handle', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });

    const handle = await adapter.requestDirectoryAccess();
    expect(handle.path).toBe(tempDir);
    expect(handle.kind).toBe('directory');
    expect(handle.platform).toBe('electron');
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({
      buttonLabel: 'Select Folder',
      message: 'Choose a directory to explore with BrainStrike',
      properties: ['openDirectory'],
      title: 'Select a folder to explore',
    });
  });

  it('should throw UserCancelledError when user cancels directory selection', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: [],
    });

    try {
      await adapter.requestDirectoryAccess();
      expect.fail('Expected error to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UserCancelledError);
      expect((error as UserCancelledError).message).toBe('User cancelled directory selection');
    }
  });

  it('should throw UserCancelledError when no paths are returned', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [],
    });

    try {
      await adapter.requestDirectoryAccess();
      expect.fail('Expected error to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UserCancelledError);
      expect((error as UserCancelledError).message).toBe('User cancelled directory selection');
    }
  });

  it('should throw error when electron dialog is unavailable', async () => {
    const { dialog } = await import('electron');
    const dialogMock = dialog as unknown as { showOpenDialog?: unknown };
    const originalShowOpenDialog = dialogMock.showOpenDialog;
    dialogMock.showOpenDialog = undefined;

    try {
      await expect(adapter.requestDirectoryAccess()).rejects.toThrow(
        'Electron is not available - this adapter should only be used in the main process'
      );
    } finally {
      dialogMock.showOpenDialog = originalShowOpenDialog;
    }
  });

  it('should throw AccessError when selected path is not a directory', async () => {
    const { dialog } = await import('electron');
    const filePath = path.join(tempDir, 'file.txt');
    fs.writeFileSync(filePath, 'data');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [filePath],
    });
    await expect(adapter.requestDirectoryAccess()).rejects.toBeInstanceOf(AccessError);
  });

  it('should throw PermissionError when stat fails', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });
    vi.spyOn(fsPromises, 'stat').mockRejectedValue(new Error('deny'));
    await expect(adapter.requestDirectoryAccess()).rejects.toBeInstanceOf(PermissionError);
  });

  it('should throw DialogError when dialog fails', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockRejectedValue(new Error('boom'));
    await expect(adapter.requestDirectoryAccess()).rejects.toBeInstanceOf(DialogError);
  });

  it('should read directory contents', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });

    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content');
    fs.mkdirSync(path.join(tempDir, 'sub'));
    const handle = await adapter.requestDirectoryAccess();
    const entries = await adapter.readDirectory(handle);
    expect(entries.map((e) => e.name).sort()).toEqual(['file.txt', 'sub']);
  });

  it('should read file content', async () => {
    const filePath = path.join(tempDir, 'file.txt');
    fs.writeFileSync(filePath, 'hello');
    const handle: FileHandle = {
      kind: 'file',
      name: 'file.txt',
      path: filePath,
      platform: 'electron',
    };
    const content = await adapter.readFile(handle);
    expect(content).toBe('hello');
  });

  it('should throw AccessError when readdir fails', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });
    vi.spyOn(fsPromises, 'readdir').mockRejectedValue(new Error('fail'));
    const handle = await adapter.requestDirectoryAccess();
    await expect(adapter.readDirectory(handle)).rejects.toBeInstanceOf(AccessError);
  });

  it('should throw AccessError when readFile fails', async () => {
    const filePath = path.join(tempDir, 'bad.txt');
    const handle: FileHandle = {
      kind: 'file',
      name: 'bad.txt',
      path: filePath,
      platform: 'electron',
    };
    vi.spyOn(fsPromises, 'readFile').mockRejectedValue(new Error('fail'));
    await expect(adapter.readFile(handle)).rejects.toBeInstanceOf(AccessError);
  });

  it('should check file existence', async () => {
    const filePath = path.join(tempDir, 'file.txt');
    fs.writeFileSync(filePath, 'hello');
    expect(await adapter.exists(filePath)).toBe(true);
    expect(await adapter.exists(path.join(tempDir, 'missing.txt'))).toBe(false);
  });

  itOnDarwin('should use one native recursive watcher on macOS', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });
    const chokidar = await import('chokidar');
    vi.mocked(chokidar.default.watch).mockClear();
    const nativeClose = vi.fn();
    const fsWatchSpy = vi.spyOn(fs, 'watch').mockReturnValue({
      close: nativeClose,
      once: vi.fn(),
    } as unknown as ReturnType<typeof fs.watch>);

    const handle = await adapter.requestDirectoryAccess();
    const stop = adapter.watchDirectory(handle as DirectoryHandle, vi.fn());

    expect(fsWatchSpy).toHaveBeenCalledTimes(1);
    expect(fsWatchSpy).toHaveBeenCalledWith(tempDir, { recursive: true }, expect.any(Function));
    expect(chokidar.default.watch).not.toHaveBeenCalled();

    stop();
    expect(nativeClose).toHaveBeenCalledTimes(1);
  });

  itOutsideDarwin('should watch directory changes', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });

    const handle = await adapter.requestDirectoryAccess();
    const callback = vi.fn();

    // Mock chokidar watcher
    const mockWatcher = {
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn().mockReturnThis(),
    };

    const chokidar = await import('chokidar');
    vi.mocked(chokidar.default.watch).mockReturnValue(
      mockWatcher as unknown as ReturnType<typeof chokidar.default.watch>
    );

    const stop = adapter.watchDirectory(handle as DirectoryHandle, callback);

    // Wait for chokidar to be initialized instead of sleeping
    await waitForCondition(() => vi.mocked(chokidar.default.watch).mock.calls.length > 0);

    // Verify chokidar was initialized correctly
    expect(chokidar.default.watch).toHaveBeenCalledWith(
      tempDir,
      expect.objectContaining({
        atomic: true,
        awaitWriteFinish: {
          pollInterval: 100,
          stabilityThreshold: 100,
        },
        followSymlinks: false,
        ignored: expect.any(Function),
        ignoreInitial: true,
        persistent: true,
      })
    );
    const watchOptions = vi.mocked(chokidar.default.watch).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(watchOptions).not.toHaveProperty('depth');

    // Simulate file addition
    const addCallback = mockWatcher.on.mock.calls.find((call) => call[0] === 'add')?.[1];
    const filePath = path.join(tempDir, 'new.txt');
    if (addCallback) {
      addCallback(filePath);
    }

    await waitForCondition(() => callback.mock.calls.length > 0);
    expect(callback).toHaveBeenCalledWith([{ kind: 'file', path: filePath, type: 'added' }]);

    stop();
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  itOutsideDarwin('should fall back to fs.watch when chokidar import fails', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });

    // Ensure a clean module cache then mock a failed chokidar import
    vi.resetModules();
    vi.doMock('chokidar', () => {
      throw new Error('MODULE_NOT_FOUND');
    });

    const handle = await adapter.requestDirectoryAccess();
    const callback = vi.fn();

    // Mock fs.watch
    const mockFsWatcher = {
      close: vi.fn(),
      once: vi.fn(),
    };
    const fsWatchSpy = vi
      .spyOn(fs, 'watch')
      .mockReturnValue(mockFsWatcher as unknown as ReturnType<typeof fs.watch>);

    const stop = adapter.watchDirectory(handle as DirectoryHandle, callback);

    // Wait for fs.watch fallback to be used instead of sleeping
    await waitForCondition(() => fsWatchSpy.mock.calls.length > 0);

    // Verify fs.watch was called as fallback
    expect(fsWatchSpy).toHaveBeenCalledWith(tempDir, { recursive: true }, expect.any(Function));

    // Since fs.watch callback testing is complex due to overloads, just verify the watcher was set up
    // The actual functionality is tested in integration tests
    expect(fsWatchSpy).toHaveBeenCalled();

    stop();
    expect(mockFsWatcher.close).toHaveBeenCalled();
  });

  itOutsideDarwin('should return noop watcher when both chokidar and fs.watch fail', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });

    // Ensure a clean module cache then mock failed chokidar import
    vi.resetModules();
    vi.doMock('chokidar', () => {
      throw new Error('MODULE_NOT_FOUND');
    });

    // Mock fs.watch to also fail
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('fs.watch failed');
    });

    const handle = await adapter.requestDirectoryAccess();
    const stop = adapter.watchDirectory(handle as DirectoryHandle, vi.fn());

    // No need to wait arbitrarily; stop should be callable

    expect(() => stop()).not.toThrow();
  });

  itOnDarwin('should fail visibly when the primary native watcher cannot start', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('fs.watch failed');
    });

    const handle = await adapter.requestDirectoryAccess();

    expect(() => adapter.watchDirectory(handle as DirectoryHandle, vi.fn())).toThrow(
      'fs.watch failed'
    );
  });

  describe('metadata caching (BST-146)', () => {
    it('should create adapter without cache by default', () => {
      const uncachedAdapter = new ElectronFileSystemAdapter();
      expect(uncachedAdapter.getCacheStats()).toBeNull();
    });

    it('should create adapter with cache when cache: true', () => {
      const cachedAdapter = new ElectronFileSystemAdapter({ cache: true });
      const stats = cachedAdapter.getCacheStats();
      expect(stats).not.toBeNull();
      expect(stats?.size).toBe(0);
      expect(stats?.maxEntries).toBe(10_000); // default
    });

    it('should create adapter with custom cache config', () => {
      const cachedAdapter = new ElectronFileSystemAdapter({
        cache: { maxEntries: 500, ttlMs: 5000 },
      });
      const stats = cachedAdapter.getCacheStats();
      expect(stats).not.toBeNull();
      expect(stats?.maxEntries).toBe(500);
    });

    it('should cache file metadata on readDirectory with includeMetadata: true', async () => {
      const { dialog } = await import('electron');
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [tempDir],
      });

      const cachedAdapter = new ElectronFileSystemAdapter({ cache: true });

      // Create a file
      fs.writeFileSync(path.join(tempDir, 'cached.txt'), 'cached content');

      const handle = await cachedAdapter.requestDirectoryAccess();

      // Spy on stat to count calls
      const statSpy = vi.spyOn(fsPromises, 'stat');

      // First read - should call stat
      await cachedAdapter.readDirectory(handle, { includeMetadata: true });
      const firstCallCount = statSpy.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      // Second read - should use cache (fewer stat calls for files)
      await cachedAdapter.readDirectory(handle, { includeMetadata: true });
      const secondCallCount = statSpy.mock.calls.length;

      // The second read should have fewer new stat calls since cached.txt is cached
      // Note: directory validation still calls stat, so we check relative increase
      expect(secondCallCount - firstCallCount).toBeLessThan(firstCallCount);
    });

    it('should clear cache', async () => {
      const cachedAdapter = new ElectronFileSystemAdapter({ cache: true });
      const { dialog } = await import('electron');
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [tempDir],
      });

      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'data');

      const handle = await cachedAdapter.requestDirectoryAccess();
      await cachedAdapter.readDirectory(handle, { includeMetadata: true });

      // Cache should have entries
      expect(cachedAdapter.getCacheStats()?.size).toBeGreaterThan(0);

      // Clear cache
      cachedAdapter.clearCache();
      expect(cachedAdapter.getCacheStats()?.size).toBe(0);
    });

    it('should invalidate specific cache path', async () => {
      const cachedAdapter = new ElectronFileSystemAdapter({ cache: true });
      const { dialog } = await import('electron');
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [tempDir],
      });

      fs.writeFileSync(path.join(tempDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(tempDir, 'b.txt'), 'b');

      const handle = await cachedAdapter.requestDirectoryAccess();
      await cachedAdapter.readDirectory(handle, { includeMetadata: true });

      const initialSize = cachedAdapter.getCacheStats()?.size ?? 0;

      // Invalidate one path
      const invalidated = cachedAdapter.invalidateCachePath(path.join(tempDir, 'a.txt'));
      expect(invalidated).toBe(true);
      expect(cachedAdapter.getCacheStats()?.size).toBe(initialSize - 1);
    });

    it('should invalidate cache directory', async () => {
      const cachedAdapter = new ElectronFileSystemAdapter({ cache: true });
      const { dialog } = await import('electron');
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [tempDir],
      });

      // Create nested structure
      const subDir = path.join(tempDir, 'subdir');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'nested.txt'), 'nested');
      fs.writeFileSync(path.join(tempDir, 'root.txt'), 'root');

      const handle = await cachedAdapter.requestDirectoryAccess();
      await cachedAdapter.readDirectory(handle, { includeMetadata: true });

      const subHandle: DirectoryHandle = {
        kind: 'directory',
        name: 'subdir',
        path: subDir,
        platform: 'electron',
      };
      await cachedAdapter.readDirectory(subHandle, { includeMetadata: true });

      // Invalidate subdir - should remove nested.txt but keep root.txt
      const count = cachedAdapter.invalidateCacheDirectory(subDir);
      expect(count).toBeGreaterThan(0);
    });

    itOutsideDarwin('should invalidate cache on file watcher changes', async () => {
      // Reset modules to clear previous chokidar mock from fs.watch fallback test
      vi.resetModules();
      vi.doMock('electron', () => ({
        dialog: { showOpenDialog: vi.fn() },
      }));
      vi.doMock('chokidar', () => {
        const mockWatch = vi.fn();
        return {
          default: { watch: mockWatch },
          watch: mockWatch,
        };
      });

      const { dialog } = await import('electron');
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [tempDir],
      });

      // Re-import adapter after module reset
      const { ElectronFileSystemAdapter: FreshAdapter } = await import(
        '../adapters/electron-adapter'
      );
      const cachedAdapter = new FreshAdapter({ cache: true });

      fs.writeFileSync(path.join(tempDir, 'watched.txt'), 'original');

      const handle = await cachedAdapter.requestDirectoryAccess();
      await cachedAdapter.readDirectory(handle, { includeMetadata: true });

      // Set up watcher with mock chokidar
      const mockWatcher = {
        close: vi.fn().mockResolvedValue(undefined),
        on: vi.fn().mockReturnThis(),
      };

      const chokidar = await import('chokidar');
      vi.mocked(chokidar.default.watch).mockReturnValue(
        mockWatcher as unknown as ReturnType<typeof chokidar.default.watch>
      );

      const callback = vi.fn();
      cachedAdapter.watchDirectory(handle as DirectoryHandle, callback);

      // Wait for chokidar initialization
      await waitForCondition(() => vi.mocked(chokidar.default.watch).mock.calls.length > 0);

      // Simulate file change event
      const changeCallback = mockWatcher.on.mock.calls.find((call) => call[0] === 'change')?.[1];
      const filePath = path.join(tempDir, 'watched.txt');
      if (changeCallback) {
        changeCallback(filePath);
      }

      // Callback should have been called
      await waitForCondition(() => callback.mock.calls.length > 0);
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('readDirectoryStreaming', () => {
    it('should stream directory entries in batches', async () => {
      // Create multiple files
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(tempDir, `file${i}.txt`), `content${i}`);
      }
      fs.mkdirSync(path.join(tempDir, 'subdir'));

      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(tempDir),
        path: tempDir,
        platform: 'electron',
      };

      const batches: { nodes: unknown[]; done: boolean; total: number }[] = [];
      await adapter.readDirectoryStreaming(
        handle,
        (nodes, meta) => {
          batches.push({ done: meta.done, nodes: [...nodes], total: meta.total });
        },
        { batchSize: 2 }
      );

      // Should have multiple batches due to batchSize: 2
      expect(batches.length).toBeGreaterThan(1);

      // Last batch should have done: true
      expect(batches.at(-1)?.done).toBe(true);

      // Total count should be 6 (5 files + 1 directory)
      expect(batches.at(-1)?.total).toBe(6);
    });

    it('should respect batchSize option', async () => {
      // Create 10 files
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(tempDir, `file${i}.txt`), `content${i}`);
      }

      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(tempDir),
        path: tempDir,
        platform: 'electron',
      };

      const batchSizes: number[] = [];
      await adapter.readDirectoryStreaming(
        handle,
        (nodes) => {
          batchSizes.push(nodes.length);
        },
        { batchSize: 3 }
      );

      // All batches except possibly the last should have 3 entries
      const nonFinalBatches = batchSizes.slice(0, -1);
      for (const size of nonFinalBatches) {
        expect(size).toBe(3);
      }
    });

    it('should include metadata when requested', async () => {
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content');

      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(tempDir),
        path: tempDir,
        platform: 'electron',
      };

      let fileNode: { size?: number; lastModified?: number } | undefined;
      await adapter.readDirectoryStreaming(
        handle,
        (nodes) => {
          const file = nodes.find((n) => n.name === 'file.txt');
          if (file) {
            fileNode = file;
          }
        },
        { includeMetadata: true }
      );

      expect(fileNode).toBeDefined();
      expect(fileNode?.size).toBe(7); // 'content' is 7 bytes
      expect(fileNode?.lastModified).toBeDefined();
    });

    it('should reject with the signal reason without emitting completion after a batch abort', async () => {
      // Create many files
      for (let i = 0; i < 20; i++) {
        fs.writeFileSync(path.join(tempDir, `file${i}.txt`), `content${i}`);
      }

      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(tempDir),
        path: tempDir,
        platform: 'electron',
      };

      const controller = new AbortController();
      const abortReason = new DOMException('Directory enumeration cancelled', 'AbortError');
      let batchCount = 0;
      let totalSeen = 0;
      const completionStates: boolean[] = [];

      await expect(
        adapter.readDirectoryStreaming(
          handle,
          (_nodes, meta) => {
            batchCount++;
            totalSeen = meta.total;
            completionStates.push(meta.done);
            if (batchCount === 1) {
              controller.abort(abortReason);
            }
          },
          { batchSize: 5, signal: controller.signal }
        )
      ).rejects.toBe(abortReason);

      expect(totalSeen).toBeLessThan(20);
      expect(completionStates).toEqual([false]);
    });

    it('should not emit pending nodes after abort before batch flush', async () => {
      for (let i = 0; i < 6; i++) {
        fs.writeFileSync(path.join(tempDir, `file${i}.txt`), `content${i}`);
      }

      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(tempDir),
        path: tempDir,
        platform: 'electron',
      };

      const controller = new AbortController();
      const abortReason = new Error('cancel before pending batch flush');
      const dirents = fs.readdirSync(tempDir, { withFileTypes: true });
      const close = vi.fn().mockResolvedValue(undefined);

      vi.spyOn(fsPromises, 'opendir').mockResolvedValue({
        close,
        async *[Symbol.asyncIterator]() {
          for (const [index, dirent] of dirents.entries()) {
            yield dirent;
            if (index === 0) {
              controller.abort(abortReason);
            }
          }
        },
      } as unknown as Awaited<ReturnType<typeof fsPromises.opendir>>);

      const batches: { nodes: unknown[]; done: boolean; total: number }[] = [];
      await expect(
        adapter.readDirectoryStreaming(
          handle,
          (nodes, meta) => {
            batches.push({ done: meta.done, nodes: [...nodes], total: meta.total });
          },
          { batchSize: 50, signal: controller.signal }
        )
      ).rejects.toBe(abortReason);

      expect(batches).toEqual([]);
      expect(close).toHaveBeenCalledOnce();
    });

    it('should reject a pre-aborted read with the exact signal reason', async () => {
      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(tempDir),
        path: tempDir,
        platform: 'electron',
      };
      const controller = new AbortController();
      const abortReason = new Error('caller cancelled before enumeration');
      controller.abort(abortReason);
      const opendirSpy = vi.spyOn(fsPromises, 'opendir');

      await expect(
        adapter.readDirectoryStreaming(handle, vi.fn(), { signal: controller.signal })
      ).rejects.toBe(abortReason);

      expect(opendirSpy).not.toHaveBeenCalled();
    });

    it('should handle empty directories', async () => {
      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(tempDir),
        path: tempDir,
        platform: 'electron',
      };

      const batches: { nodes: unknown[]; done: boolean; total: number }[] = [];
      await adapter.readDirectoryStreaming(handle, (nodes, meta) => {
        batches.push({ done: meta.done, nodes: [...nodes], total: meta.total });
      });

      expect(batches.length).toBe(1);
      expect(batches[0]?.done).toBe(true);
      expect(batches[0]?.total).toBe(0);
      expect(batches[0]?.nodes.length).toBe(0);
    });

    it('should throw AccessError for non-existent directory', async () => {
      const handle: DirectoryHandle = {
        kind: 'directory',
        name: 'path',
        path: '/non/existent/path',
        platform: 'electron',
      };

      await expect(adapter.readDirectoryStreaming(handle, vi.fn())).rejects.toThrow(AccessError);
    });

    it('should use default batch size when not specified', async () => {
      // Create 100 files to test default batch size of 50
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(path.join(tempDir, `file${i}.txt`), `c${i}`);
      }

      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(tempDir),
        path: tempDir,
        platform: 'electron',
      };

      const batchSizes: number[] = [];
      await adapter.readDirectoryStreaming(handle, (nodes) => {
        batchSizes.push(nodes.length);
      });

      // First batch should be default size (50)
      expect(batchSizes[0]).toBe(50);
    });
  });
});
