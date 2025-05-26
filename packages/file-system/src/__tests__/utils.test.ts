import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryHandle } from '../types';
import {
  extractNativeDirectoryHandle,
  extractNativeDirectoryHandleAsNull,
  extractNativeDirectoryHandleAsUndefined,
  isValidDirectoryHandle,
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
});
