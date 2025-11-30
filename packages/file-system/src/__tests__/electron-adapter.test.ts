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
  cwd: () => currentCwd,
  chdir: (dir: string) => {
    currentCwd = dir;
  },
};

// Replace the limited process object with our mock
Object.assign(process, mockProcess);

// Type assertion to help TypeScript understand the mocked process
const processWithChdir = process as typeof process & { chdir: (dir: string) => void };

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
    const entries = await adapter.readDirectory(handle, { includeMetadata: true, concurrency });
    expect(entries.filter((e) => e.type === 'file')).toHaveLength(fileCount);
    expect(peak).toBeLessThanOrEqual(concurrency);
  });

  afterEach(async () => {
    processWithChdir.chdir(originalCwd);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
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
      properties: ['openDirectory'],
      title: 'Select a folder to explore',
      buttonLabel: 'Select Folder',
      message: 'Choose a directory to explore with BrainStrike',
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

  it('should throw error when electron import fails', async () => {
    vi.doMock('electron', () => {
      throw new Error('fail');
    });
    // re-import adapter to pick up failing import
    const { ElectronFileSystemAdapter: FailingAdapter } = await import(
      '../adapters/electron-adapter'
    );
    const failing = new FailingAdapter();
    await expect(failing.requestDirectoryAccess()).rejects.toThrow(
      'Electron is not available - this adapter should only be used in the main process'
    );
    vi.doMock('electron', () => ({
      dialog: { showOpenDialog: vi.fn() },
    }));
    vi.resetModules();
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
      path: filePath,
      name: 'file.txt',
      kind: 'file',
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
      path: filePath,
      name: 'bad.txt',
      kind: 'file',
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

  it('should watch directory changes', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });

    const handle = await adapter.requestDirectoryAccess();
    const callback = vi.fn();

    // Mock chokidar watcher
    const mockWatcher = {
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const chokidar = await import('chokidar');
    vi.mocked(chokidar.default.watch).mockReturnValue(
      mockWatcher as unknown as ReturnType<typeof chokidar.default.watch>
    );

    const stop = adapter.watchDirectory(handle as DirectoryHandle, callback);

    // Wait for chokidar to be initialized instead of sleeping
    await waitForCondition(() => vi.mocked(chokidar.default.watch).mock.calls.length > 0);

    // Verify chokidar was initialized correctly
    expect(chokidar.default.watch).toHaveBeenCalledWith(tempDir, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100,
      },
      ignored: /(^|[/\\])\../,
      depth: 0,
    });

    // Simulate file addition
    const addCallback = mockWatcher.on.mock.calls.find((call) => call[0] === 'add')?.[1];
    const filePath = path.join(tempDir, 'new.txt');
    if (addCallback) {
      addCallback(filePath);
    }

    expect(callback).toHaveBeenCalledWith([{ type: 'added', path: filePath, kind: 'file' }]);

    stop();
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('should fall back to fs.watch when chokidar import fails', async () => {
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
    };
    const fsWatchSpy = vi
      .spyOn(fs, 'watch')
      .mockReturnValue(mockFsWatcher as unknown as ReturnType<typeof fs.watch>);

    const stop = adapter.watchDirectory(handle as DirectoryHandle, callback);

    // Wait for fs.watch fallback to be used instead of sleeping
    await waitForCondition(() => fsWatchSpy.mock.calls.length > 0);

    // Verify fs.watch was called as fallback
    expect(fsWatchSpy).toHaveBeenCalledWith(tempDir, { recursive: false }, expect.any(Function));

    // Since fs.watch callback testing is complex due to overloads, just verify the watcher was set up
    // The actual functionality is tested in integration tests
    expect(fsWatchSpy).toHaveBeenCalled();

    stop();
    expect(mockFsWatcher.close).toHaveBeenCalled();
  });

  it('should return noop watcher when both chokidar and fs.watch fail', async () => {
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
});
