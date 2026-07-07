import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryHandle } from '../types';
import {
  createLimiter,
  extractNativeDirectoryHandle,
  extractNativeDirectoryHandleAsNull,
  extractNativeDirectoryHandleAsUndefined,
  isFileSystemDirectoryHandle,
  isFileSystemFileHandle,
  isValidDirectoryHandle,
  normalizeDirectoryReadOptions,
  validateDirectoryPath,
} from '../utils';

describe('utils', () => {
  const nativeHandle = {} as FileSystemDirectoryHandle;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractNativeDirectoryHandle', () => {
    it('returns internal handle for web platform', () => {
      const handle: DirectoryHandle = {
        _internal: nativeHandle,
        kind: 'directory',
        name: 'root',
        path: '/',
        platform: 'web',
      };

      const result = extractNativeDirectoryHandle(handle);
      expect(result).toBe(nativeHandle);
    });

    it('returns internal handle and warns when platform is undefined', () => {
      const handle = {
        _internal: nativeHandle,
        kind: 'directory' as const,
        name: 'root',
        path: '/',
        platform: undefined,
      } as unknown as DirectoryHandle;

      const result = extractNativeDirectoryHandle(handle);
      expect(result).toBe(nativeHandle);
    });

    it('returns null and warns for electron platform', () => {
      const handle: DirectoryHandle = {
        _internal: nativeHandle,
        kind: 'directory',
        name: 'root',
        path: '/',
        platform: 'electron',
      };

      const result = extractNativeDirectoryHandle(handle);
      expect(result).toBeNull();
    });

    it('returns same value for null or undefined', () => {
      expect(extractNativeDirectoryHandle(null)).toBeNull();
      expect(extractNativeDirectoryHandle(undefined)).toBeUndefined();
    });
  });

  describe('extractNativeDirectoryHandleAsUndefined', () => {
    it('returns undefined for electron platform', () => {
      const handle: DirectoryHandle = {
        _internal: nativeHandle,
        kind: 'directory',
        name: 'root',
        path: '/',
        platform: 'electron',
      };

      const result = extractNativeDirectoryHandleAsUndefined(handle);
      expect(result).toBeUndefined();
    });
  });

  describe('extractNativeDirectoryHandleAsNull', () => {
    it('returns null for electron platform', () => {
      const handle: DirectoryHandle = {
        _internal: nativeHandle,
        kind: 'directory',
        name: 'root',
        path: '/',
        platform: 'electron',
      };

      const result = extractNativeDirectoryHandleAsNull(handle);
      expect(result).toBeNull();
    });
  });

  describe('isValidDirectoryHandle', () => {
    it('checks handle validity', () => {
      const dirHandle: DirectoryHandle = {
        kind: 'directory',
        name: 'root',
        path: '/',
        platform: 'web',
      };

      const fileHandle = {
        kind: 'file' as const,
        name: 'file',
        path: '/file',
        platform: 'web' as const,
      } as unknown as DirectoryHandle;

      expect(isValidDirectoryHandle(dirHandle)).toBe(true);
      expect(isValidDirectoryHandle(fileHandle)).toBe(false);
      expect(isValidDirectoryHandle(null)).toBe(false);
      expect(isValidDirectoryHandle(undefined)).toBe(false);
    });
  });

  describe('isFileSystemDirectoryHandle', () => {
    it('returns true for objects with directory shape', () => {
      const handle = {
        entries: vi.fn(),
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;

      expect(isFileSystemDirectoryHandle(handle)).toBe(true);
    });

    it('returns false when required properties are missing or invalid', () => {
      const noEntries = { kind: 'directory', name: 'root' } as unknown as FileSystemDirectoryHandle;
      const wrongKind = {
        entries: vi.fn(),
        kind: 'file',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const missingName = {
        entries: vi.fn(),
        kind: 'directory',
      } as unknown as FileSystemDirectoryHandle;

      expect(isFileSystemDirectoryHandle(null)).toBe(false);
      expect(isFileSystemDirectoryHandle(undefined)).toBe(false);
      expect(isFileSystemDirectoryHandle('directory')).toBe(false);
      expect(isFileSystemDirectoryHandle(noEntries)).toBe(false);
      expect(isFileSystemDirectoryHandle(wrongKind)).toBe(false);
      expect(isFileSystemDirectoryHandle(missingName)).toBe(false);
    });
  });

  describe('isFileSystemFileHandle', () => {
    it('returns true for objects with file handle shape', () => {
      const handle = {
        getFile: vi.fn(),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;

      expect(isFileSystemFileHandle(handle)).toBe(true);
    });

    it('returns false when shape checks fail', () => {
      const wrongKind = {
        getFile: vi.fn(),
        kind: 'directory',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      const missingName = { getFile: vi.fn(), kind: 'file' } as unknown as FileSystemFileHandle;
      const missingGetFile = { kind: 'file', name: 'file.txt' } as unknown as FileSystemFileHandle;

      expect(isFileSystemFileHandle(null)).toBe(false);
      expect(isFileSystemFileHandle(42)).toBe(false);
      expect(isFileSystemFileHandle(wrongKind)).toBe(false);
      expect(isFileSystemFileHandle(missingName)).toBe(false);
      expect(isFileSystemFileHandle(missingGetFile)).toBe(false);
    });
  });

  describe('normalizeDirectoryReadOptions', () => {
    it('applies defaults when options are undefined', () => {
      const result = normalizeDirectoryReadOptions();
      expect(result.includeMetadata).toBe(true);
      expect(result.concurrency).toBe(64);
      expect(typeof result.limiter).toBe('function');
    });

    it('floors finite concurrency and bypasses limiter for non-positive values', async () => {
      const result = normalizeDirectoryReadOptions({ concurrency: 2.8, includeMetadata: false });
      expect(result.includeMetadata).toBe(false);
      expect(result.concurrency).toBe(2);

      const unlimited = normalizeDirectoryReadOptions({ concurrency: 0 }).limiter;

      const task = vi.fn().mockResolvedValue('done');
      expect(await unlimited(task)).toBe('done');
      expect(task).toHaveBeenCalledTimes(1);
    });
  });

  describe('createLimiter', () => {
    it('enforces concurrency limits and drains queued tasks', async () => {
      const limiter = createLimiter(1);
      const executionOrder: number[] = [];
      let active = 0;
      let peak = 0;

      const makeTask = (id: number, delay = 0) =>
        limiter(async () => {
          active++;
          peak = Math.max(peak, active);
          executionOrder.push(id);
          await new Promise((resolve) => setTimeout(resolve, delay));
          active--;
          return id;
        });

      const results = await Promise.all([makeTask(1, 10), makeTask(2), makeTask(3)]);

      expect(results).toEqual([1, 2, 3]);
      expect(executionOrder).toEqual([1, 2, 3]);
      expect(peak).toBe(1);
    });
  });

  describe('validateDirectoryPath', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-util-'));
    });

    afterEach(async () => {
      await fsPromises.rm(tempDir, { force: true, recursive: true });
    });

    it('resolves for a valid directory', async () => {
      await expect(validateDirectoryPath(tempDir)).resolves.not.toThrow();
    });

    it('throws AccessError for a file path', async () => {
      const file = path.join(tempDir, 'file.txt');
      fs.writeFileSync(file, 'data');
      await expect(validateDirectoryPath(file)).rejects.toMatchObject({
        message: 'Selected path is not a directory',
        path: file,
      });
    });

    it('throws PermissionError when stat fails', async () => {
      vi.spyOn(fsPromises, 'stat').mockRejectedValueOnce(new Error('deny'));
      await expect(validateDirectoryPath(tempDir)).rejects.toMatchObject({
        message: 'Cannot access selected directory: deny',
        path: tempDir,
      });
    });
  });
});
