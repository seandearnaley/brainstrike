import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessError, PermissionError } from '../errors';
import type { DirectoryHandle } from '../types';
import {
  extractNativeDirectoryHandle,
  extractNativeDirectoryHandleAsNull,
  extractNativeDirectoryHandleAsUndefined,
  isValidDirectoryHandle,
  validateDirectoryPath,
} from '../utils';

describe('utils', () => {
  const nativeHandle = {} as FileSystemDirectoryHandle;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractNativeDirectoryHandle', () => {
    it('returns internal handle for web platform', () => {
      const handle: DirectoryHandle = {
        path: '/',
        name: 'root',
        kind: 'directory',
        platform: 'web',
        _internal: nativeHandle,
      };

      const result = extractNativeDirectoryHandle(handle);
      expect(result).toBe(nativeHandle);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('returns internal handle and warns when platform is undefined', () => {
      const handle = {
        path: '/',
        name: 'root',
        kind: 'directory' as const,
        platform: undefined,
        _internal: nativeHandle,
      } as unknown as DirectoryHandle;

      const result = extractNativeDirectoryHandle(handle);
      expect(result).toBe(nativeHandle);
      expect(console.warn).toHaveBeenCalledWith(
        'DirectoryHandle platform is undefined, assuming web platform'
      );
    });

    it('returns null and warns for electron platform', () => {
      const handle: DirectoryHandle = {
        path: '/',
        name: 'root',
        kind: 'directory',
        platform: 'electron',
        _internal: nativeHandle,
      };

      const result = extractNativeDirectoryHandle(handle);
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        'extractNativeDirectoryHandle called for electron platform, returning null. Consider using platform-agnostic file system operations instead.'
      );
    });

    it('returns same value for null or undefined', () => {
      expect(extractNativeDirectoryHandle(null)).toBeNull();
      expect(extractNativeDirectoryHandle(undefined)).toBeUndefined();
    });
  });

  describe('extractNativeDirectoryHandleAsUndefined', () => {
    it('returns undefined for electron platform', () => {
      const handle: DirectoryHandle = {
        path: '/',
        name: 'root',
        kind: 'directory',
        platform: 'electron',
        _internal: nativeHandle,
      };

      const result = extractNativeDirectoryHandleAsUndefined(handle);
      expect(result).toBeUndefined();
    });
  });

  describe('extractNativeDirectoryHandleAsNull', () => {
    it('returns null for electron platform', () => {
      const handle: DirectoryHandle = {
        path: '/',
        name: 'root',
        kind: 'directory',
        platform: 'electron',
        _internal: nativeHandle,
      };

      const result = extractNativeDirectoryHandleAsNull(handle);
      expect(result).toBeNull();
    });
  });

  describe('isValidDirectoryHandle', () => {
    it('checks handle validity', () => {
      const dirHandle: DirectoryHandle = {
        path: '/',
        name: 'root',
        kind: 'directory',
        platform: 'web',
      };

      const fileHandle = {
        path: '/file',
        name: 'file',
        kind: 'file' as const,
        platform: 'web' as const,
      } as unknown as DirectoryHandle;

      expect(isValidDirectoryHandle(dirHandle)).toBe(true);
      expect(isValidDirectoryHandle(fileHandle)).toBe(false);
      expect(isValidDirectoryHandle(null)).toBe(false);
      expect(isValidDirectoryHandle(undefined)).toBe(false);
    });
  });

  describe('validateDirectoryPath', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-util-'));
    });

    afterEach(async () => {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    });

    it('resolves for a valid directory', async () => {
      await expect(validateDirectoryPath(tempDir)).resolves.not.toThrow();
    });

    it('throws AccessError for a file path', async () => {
      const file = path.join(tempDir, 'file.txt');
      fs.writeFileSync(file, 'data');
      await expect(validateDirectoryPath(file)).rejects.toBeInstanceOf(AccessError);
    });

    it('throws PermissionError when stat fails', async () => {
      vi.spyOn(fsPromises, 'stat').mockRejectedValueOnce(new Error('deny'));
      await expect(validateDirectoryPath(tempDir)).rejects.toBeInstanceOf(PermissionError);
    });
  });
});
