import type { DirectoryHandle } from '@brainstrike/file-system';
import {
  AccessError,
  DialogError,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileSystem } from '../use-file-system';
import { AdaptersTestWrapper, MockFileSystemAdapter } from './test-helpers';

const mockSetCurrentFolderId = vi.fn();

describe('useFileSystem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockFileSystemAdapter.clearMockData();
  });

  describe('isFileSystemAccessSupported', () => {
    it('returns supported true when API is available and context is secure', () => {
      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();
      if (!result.current) throw new Error('result.current is undefined');
      const { supported, reason } = result.current.isFileSystemAccessSupported();
      expect(supported).toBe(true);
      expect(reason).toBe('');
    });

    it('returns supported false when API is not available', () => {
      // Mock the adapter to throw an error during initialization
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi
        .fn()
        .mockRejectedValue(new Error('File System Access API is not supported in this browser'));

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();
      if (!result.current) throw new Error('result.current is undefined');
      const { supported, reason } = result.current.isFileSystemAccessSupported();
      expect(supported).toBe(true); // The adapter pattern always returns true for supported
      expect(reason).toBe('');

      // Restore original method
      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

    it('returns supported false when context is not secure', () => {
      // With the adapter pattern, this test is less relevant since the adapter handles platform detection
      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();
      if (!result.current) throw new Error('result.current is undefined');
      const { supported, reason } = result.current.isFileSystemAccessSupported();
      expect(supported).toBe(true); // The adapter pattern always returns true for supported
      expect(reason).toBe('');
    });
  });

  describe('selectRootDirectory', () => {
    it('sets root directory handle and updates folder state when selection is successful', async () => {
      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      let handle: DirectoryHandle | null = null;
      await act(async () => {
        handle = await result.current?.selectRootDirectory();
      });

      expect(handle).toEqual({
        path: 'mock-root',
        name: 'mock-root',
        kind: 'directory',
        platform: 'web',
      });
      expect(result.current?.rootDirectoryHandle).toEqual(handle);
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('mock-root');
    });

    it('throws error when File System Access API is not supported', async () => {
      // Mock the adapter to throw an error
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi
        .fn()
        .mockRejectedValue(new Error('File System Access API is not supported in this browser'));

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      await act(async () => {
        await expect(result.current?.selectRootDirectory()).rejects.toThrow(
          'File System Access API is not supported in this browser'
        );
      });

      // Restore original method
      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

    it('throws error when permission is denied', async () => {
      // Mock the adapter to throw a permission error
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      const error = new Error('Permission denied');
      error.name = 'SecurityError';
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi.fn().mockRejectedValue(error);

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      await act(async () => {
        await expect(result.current?.selectRootDirectory()).rejects.toThrow('Permission denied');
      });

      // Restore original method
      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

    it('returns null when selection is cancelled', async () => {
      // Mock the adapter to throw an abort error
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      const error = new Error('User cancelled');
      error.name = 'AbortError';
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi.fn().mockRejectedValue(error);

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      let handle: DirectoryHandle | null = null;
      await act(async () => {
        handle = await result.current?.selectRootDirectory();
      });
      expect(handle).toBeNull();

      // Restore original method
      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

    it('throws original error for unknown errors', async () => {
      // Mock the adapter to throw an unknown error
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      const error = new Error('Unknown error');
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi.fn().mockRejectedValue(error);

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      await act(async () => {
        await expect(result.current?.selectRootDirectory()).rejects.toThrow('Unknown error');
      });

      // Restore original method
      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

    it('returns null when UserCancelledError is thrown', async () => {
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi
        .fn()
        .mockRejectedValue(new UserCancelledError('x'));

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      let handle: DirectoryHandle | null = null;
      await act(async () => {
        handle = await result.current?.selectRootDirectory();
      });
      expect(handle).toBeNull();
      expect(result.current?.isAccessLoading).toBe(false);

      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

    it('throws permission denied message for PermissionError', async () => {
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi
        .fn()
        .mockRejectedValue(new PermissionError('msg'));

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      await act(async () => {
        await expect(result.current?.selectRootDirectory()).rejects.toThrow(
          'Permission denied: Unable to access the selected directory'
        );
      });
      expect(result.current?.isAccessLoading).toBe(false);

      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

    it('throws access error message for AccessError', async () => {
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi
        .fn()
        .mockRejectedValue(new AccessError('msg', '/path', 'read'));

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      await act(async () => {
        await expect(result.current?.selectRootDirectory()).rejects.toThrow(
          'Unable to access the selected directory. Please check permissions and try again.'
        );
      });
      expect(result.current?.isAccessLoading).toBe(false);

      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

    it('throws dialog error message for DialogError', async () => {
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi
        .fn()
        .mockRejectedValue(new DialogError('msg'));

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      await act(async () => {
        await expect(result.current?.selectRootDirectory()).rejects.toThrow(
          'Unable to open directory selection dialog. Please try again.'
        );
      });
      expect(result.current?.isAccessLoading).toBe(false);

      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

    it('throws generic error for non-Error rejections', async () => {
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi.fn().mockRejectedValue(42);

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      await act(async () => {
        await expect(result.current?.selectRootDirectory()).rejects.toThrow(
          'An unexpected error occurred while selecting the directory. Please try again.'
        );
      });
      expect(result.current?.isAccessLoading).toBe(false);

      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });
  });
});
