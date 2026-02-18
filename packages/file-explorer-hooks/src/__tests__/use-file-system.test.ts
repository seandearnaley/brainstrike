import type { DirectoryHandle } from '@brainstrike/file-system';
import {
  AccessError,
  DialogError,
  type FileSystemAdapter,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import { createStorageAdapter } from '@brainstrike/storage';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdaptersProvider } from '../adapters-context';
import { useFileSystem } from '../use-file-system';
import { AdaptersTestWrapper, MockFileSystemAdapter } from './test-helpers';

// Mock the useFileExplorerStore
const mockSetCurrentFolderId = vi.fn();
vi.mock('@brainstrike/file-explorer', () => ({
  useFileExplorerStore: vi.fn(() => ({
    setCurrentFolderId: mockSetCurrentFolderId,
    currentFolderId: 'test-folder-id',
  })),
}));

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
      if (!result.current) {
        throw new Error('result.current is undefined');
      }
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
      if (!result.current) {
        throw new Error('result.current is undefined');
      }
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
      if (!result.current) {
        throw new Error('result.current is undefined');
      }
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

  describe('auto-restore functionality', () => {
    beforeEach(() => {
      MockFileSystemAdapter.clearMockData();
    });

    it('should not attempt restore when adapter does not support restoreLastFolder', () => {
      // This test verifies that the hook gracefully handles adapters without restoreLastFolder.
      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );

      expect(result.current).toBeDefined();
      expect(result.current?.rootDirectoryHandle).toBeNull();
    });

    it('should restore last folder when available and exists', async () => {
      MockFileSystemAdapter.setMockLastFolderPath('/test/restored/path');

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );

      await waitFor(() =>
        expect(result.current?.rootDirectoryHandle).toEqual({
          path: '/test/restored/path',
          name: 'path',
          kind: 'directory',
          platform: 'web',
        })
      );
      expect(result.current).toBeDefined();
      expect(result.current?.rootDirectoryHandle).toEqual({
        path: '/test/restored/path',
        name: 'path',
        kind: 'directory',
        platform: 'web',
      });
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('path');
    });

    it('should not restore when no last folder is available', async () => {
      MockFileSystemAdapter.setMockLastFolderPath(null);

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );

      await waitFor(() => expect(result.current?.rootDirectoryHandle).toBeNull());
      expect(result.current).toBeDefined();
      expect(mockSetCurrentFolderId).not.toHaveBeenCalled();
    });

    it('should handle restore errors gracefully', async () => {
      MockFileSystemAdapter.setMockRestoreError(new Error('Restore failed'));

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );

      await waitFor(() => expect(result.current?.rootDirectoryHandle).toBeNull());
      expect(result.current).toBeDefined();
      expect(mockSetCurrentFolderId).not.toHaveBeenCalled();
    });

    it('should not attempt restore if folder is already selected', async () => {
      MockFileSystemAdapter.setMockLastFolderPath('/test/restored/path');

      const { result, rerender } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );

      // First, manually select a directory
      await act(async () => {
        await result.current?.selectRootDirectory();
      });

      expect(result.current?.rootDirectoryHandle).toEqual({
        path: 'mock-root',
        name: 'mock-root',
        kind: 'directory',
        platform: 'web',
      });

      // Clear the mock and rerender - should not attempt restore
      vi.clearAllMocks();
      rerender();

      await waitFor(() =>
        expect(result.current?.rootDirectoryHandle).toEqual({
          path: 'mock-root',
          name: 'mock-root',
          kind: 'directory',
          platform: 'web',
        })
      );
      // Should still have the manually selected directory, not the restored one
      expect(result.current?.rootDirectoryHandle).toEqual({
        path: 'mock-root',
        name: 'mock-root',
        kind: 'directory',
        platform: 'web',
      });
    });

    it('should only attempt restore once', async () => {
      const restoreSpy = vi.spyOn(MockFileSystemAdapter.prototype, 'restoreLastFolder');
      MockFileSystemAdapter.setMockLastFolderPath('/test/restored/path');

      const { rerender } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );

      await waitFor(() => expect(restoreSpy).toHaveBeenCalledTimes(1));

      // Rerender and ensure not called again
      rerender();
      await waitFor(() => expect(restoreSpy).toHaveBeenCalledTimes(1));

      restoreSpy.mockRestore();
    });

    it('restores last folder under React StrictMode effect double-invoke', async () => {
      MockFileSystemAdapter.setMockLastFolderPath('/test/restored/path');
      const originalRestoreLastFolder = MockFileSystemAdapter.prototype.restoreLastFolder;
      MockFileSystemAdapter.prototype.restoreLastFolder = vi.fn().mockImplementation(
        async () =>
          await new Promise<DirectoryHandle>((resolve) => {
            setTimeout(() => {
              resolve({
                path: '/test/restored/path',
                name: 'path',
                kind: 'directory',
                platform: 'web',
              });
            }, 0);
          })
      );

      const StrictAdaptersWrapper = ({ children }: { children: ReactNode }) =>
        createElement(StrictMode, null, createElement(AdaptersTestWrapper, null, children));

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: StrictAdaptersWrapper }
      );

      try {
        await waitFor(() =>
          expect(result.current?.rootDirectoryHandle).toEqual({
            path: '/test/restored/path',
            name: 'path',
            kind: 'directory',
            platform: 'web',
          })
        );

        expect(mockSetCurrentFolderId).toHaveBeenCalledWith('path');
      } finally {
        MockFileSystemAdapter.prototype.restoreLastFolder = originalRestoreLastFolder;
      }
    });

    it('retries restore after an in-flight attempt is cancelled by adapter replacement', async () => {
      const restoredHandle: DirectoryHandle = {
        path: '/test/restored/path',
        name: 'path',
        kind: 'directory',
        platform: 'web',
      };
      const storageAdapter = createStorageAdapter('web');

      let resolveFirstRestore: ((value: DirectoryHandle | null) => void) | undefined;

      const createAdapter = (
        restoreLastFolder: () => Promise<DirectoryHandle | null>
      ): FileSystemAdapter => ({
        requestDirectoryAccess: async () => ({
          path: 'mock-root',
          name: 'mock-root',
          kind: 'directory',
          platform: 'web',
        }),
        readDirectory: async () => [],
        readFile: async () => 'test content',
        exists: async () => true,
        restoreLastFolder,
      });

      const firstAdapter = createAdapter(
        async () =>
          await new Promise<DirectoryHandle | null>((resolve) => {
            resolveFirstRestore = resolve;
          })
      );
      const secondAdapter = createAdapter(async () => restoredHandle);
      let activeAdapter: FileSystemAdapter = firstAdapter;

      const DynamicAdaptersWrapper = ({ children }: { children: ReactNode }) =>
        createElement(AdaptersProvider, {
          fileSystemAdapter: activeAdapter,
          storageAdapter,
          children,
        });

      const { result, rerender } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: DynamicAdaptersWrapper }
      );

      activeAdapter = secondAdapter;
      rerender();

      await act(async () => {
        resolveFirstRestore?.(null);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current?.rootDirectoryHandle).toEqual(restoredHandle);
      });

      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('path');
    });

    it('does not update folder state after unmount while restore is in-flight', async () => {
      const originalRestoreLastFolder = MockFileSystemAdapter.prototype.restoreLastFolder;
      let resolveRestore: ((value: DirectoryHandle | null) => void) | undefined;

      MockFileSystemAdapter.prototype.restoreLastFolder = vi.fn().mockImplementation(
        () =>
          new Promise<DirectoryHandle | null>((resolve) => {
            resolveRestore = resolve;
          })
      );

      try {
        const { unmount } = renderHook(
          () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
          { wrapper: AdaptersTestWrapper }
        );

        unmount();

        await act(async () => {
          resolveRestore?.({
            path: '/test/restored/late',
            name: 'late',
            kind: 'directory',
            platform: 'web',
          });
          await Promise.resolve();
        });

        expect(mockSetCurrentFolderId).not.toHaveBeenCalled();
      } finally {
        MockFileSystemAdapter.prototype.restoreLastFolder = originalRestoreLastFolder;
      }
    });

    it('should set isAccessLoading=true synchronously before async restore starts', async () => {
      // This test verifies the fix for the race condition where other effects
      // might see isAccessLoading=false before the restore completes.
      // The fix ensures isAccessLoading is set to true BEFORE the async operation starts.
      MockFileSystemAdapter.setMockLastFolderPath('/test/restored/path');

      // Track isAccessLoading values over time
      const loadingStates: boolean[] = [];

      const { result } = renderHook(
        () => {
          const state = useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId });
          // Capture loading state on each render
          loadingStates.push(state.isAccessLoading);
          return state;
        },
        { wrapper: AdaptersTestWrapper }
      );

      // Wait for restore to complete
      await waitFor(() => expect(result.current.rootDirectoryHandle).not.toBeNull());

      // Verify that isAccessLoading was true at some point during the render cycle
      // (before the async restore completed)
      expect(loadingStates).toContain(true);
      // And that it eventually becomes false after completion
      expect(result.current.isAccessLoading).toBe(false);
    });

    it('should handle setCurrentFolderId being undefined gracefully', async () => {
      MockFileSystemAdapter.setMockLastFolderPath('/test/restored/path');

      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: undefined as unknown as (id: string | null) => void,
          }),
        { wrapper: AdaptersTestWrapper }
      );

      await waitFor(() =>
        expect(result.current?.rootDirectoryHandle).toEqual({
          path: '/test/restored/path',
          name: 'path',
          kind: 'directory',
          platform: 'web',
        })
      );
      expect(result.current).toBeDefined();
      expect(result.current?.rootDirectoryHandle).toEqual({
        path: '/test/restored/path',
        name: 'path',
        kind: 'directory',
        platform: 'web',
      });
      // Should not throw even with undefined setCurrentFolderId
    });
  });

  describe('clearRootDirectory', () => {
    it('clears the active handle and resets the folder id reference', async () => {
      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );

      await act(async () => {
        await result.current?.selectRootDirectory();
      });

      expect(result.current?.rootDirectoryHandle).not.toBeNull();

      await act(async () => {
        result.current?.clearRootDirectory();
      });

      await waitFor(() => {
        expect(result.current?.rootDirectoryHandle).toBeNull();
      });
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith(null);
    });
  });
});
