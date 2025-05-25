import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronFileSystemAdapter } from '../adapters/electron-adapter';
import type { DirectoryHandle, FileHandle } from '../types';

const originalCwd = process.cwd();

describe('ElectronFileSystemAdapter', () => {
  let tempDir: string;
  let adapter: ElectronFileSystemAdapter;

  beforeEach(() => {
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
    const handle = await adapter.requestDirectoryAccess();
    expect(handle.path).toBe(tempDir);
    expect(handle.kind).toBe('directory');
    expect(handle.platform).toBe('electron');
  });

  it('should read directory contents', async () => {
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

  it('should check file existence', async () => {
    const filePath = path.join(tempDir, 'file.txt');
    fs.writeFileSync(filePath, 'hello');
    expect(await adapter.exists(filePath)).toBe(true);
    expect(await adapter.exists(path.join(tempDir, 'missing.txt'))).toBe(false);
  });

  it('should watch directory changes', async () => {
    const handle = await adapter.requestDirectoryAccess();
    const callback = vi.fn();
    const stop = adapter.watchDirectory(handle as DirectoryHandle, callback);
    await fsPromises.writeFile(path.join(tempDir, 'new.txt'), 'data');
    await new Promise((res) => setTimeout(res, 100));
    stop();
    expect(callback).toHaveBeenCalled();
  });
});
