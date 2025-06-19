import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronFileSystemAdapter } from '../adapters/electron-adapter';
import { AccessError, DialogError, PermissionError, UserCancelledError } from '../errors';
import type { DirectoryHandle, FileHandle } from '../types';

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

const originalCwd = process.cwd();

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
    process.chdir(tempDir);
    adapter = new ElectronFileSystemAdapter();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
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
    // biome-ignore lint/suspicious/noExplicitAny: mock type
    vi.mocked(chokidar.default.watch).mockReturnValue(mockWatcher as any);

    const stop = adapter.watchDirectory(handle as DirectoryHandle, callback);

    // Give the dynamic import time to resolve
    await new Promise((res) => setTimeout(res, 100));

    // Verify chokidar was initialized correctly
    expect(chokidar.default.watch).toHaveBeenCalledWith(tempDir, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100,
      },
      ignored: /(^|[\/\\])\../,
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

    // Mock a failed chokidar import
    vi.doMock('chokidar', () => {
      throw new Error('MODULE_NOT_FOUND');
    });

    const handle = await adapter.requestDirectoryAccess();
    const callback = vi.fn();

    // Mock fs.watch
    const mockFsWatcher = {
      close: vi.fn(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: mock type
    const fsWatchSpy = vi.spyOn(fs, 'watch').mockReturnValue(mockFsWatcher as any);

    const stop = adapter.watchDirectory(handle as DirectoryHandle, callback);

    // Give the dynamic import time to fail and fallback to activate
    await new Promise((res) => setTimeout(res, 100));

    // Verify fs.watch was called as fallback
    expect(fsWatchSpy).toHaveBeenCalledWith(tempDir, { recursive: false }, expect.any(Function));

    // Test the fs.watch callback
    const fsWatchCallback = fsWatchSpy.mock.calls[0]?.[2];
    if (fsWatchCallback) {
      // Simulate file creation
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'content');
      fsWatchCallback('rename', 'test.txt');
    }

    expect(callback).toHaveBeenCalledWith([
      { type: 'added', path: path.join(tempDir, 'test.txt'), kind: 'file' },
    ]);

    stop();
    expect(mockFsWatcher.close).toHaveBeenCalled();
  });

  it('should return noop watcher when both chokidar and fs.watch fail', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [tempDir],
    });

    // Mock failed chokidar import
    vi.doMock('chokidar', () => {
      throw new Error('MODULE_NOT_FOUND');
    });

    // Mock fs.watch to also fail
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('fs.watch failed');
    });

    const handle = await adapter.requestDirectoryAccess();
    const stop = adapter.watchDirectory(handle as DirectoryHandle, vi.fn());

    // Give the dynamic import time to resolve
    await new Promise((res) => setTimeout(res, 100));

    expect(() => stop()).not.toThrow();
  });
});
