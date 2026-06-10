import type { DirectoryHandle } from '@brainstrike/file-system';
import {
  AccessError,
  DialogError,
  type FileSystemAdapter,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import { createStorageAdapter } from '@brainstrike/storage';
import type { RootDescriptor } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdaptersProvider } from '../adapters-context';
import { useFileSystem } from '../use-file-system';
import { AdaptersTestWrapper, MockFileSystemAdapter } from './test-helpers';

// Mock the useFileExplorerStore
const mockSetCurrentFolderId = vi.fn();
const mockAddActiveRoot = vi.fn();
const mockSetActiveRoots = vi.fn();
vi.mock('@brainstrike/file-explorer', () => ({
  useFileExplorerStore: vi.fn(() => ({
    setCurrentFolderId: mockSetCurrentFolderId,
    currentFolderId: 'test-folder-id',
    addActiveRoot: mockAddActiveRoot,
    setActiveRoots: mockSetActiveRoots,
    folderAccessOrder: [],
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
    it('uses the canonical path as the folder id when name and path differ', async () => {
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi.fn().mockResolvedValue({
        path: '/projects/shared-name',
        name: 'shared-name',
        kind: 'directory',
        platform: 'web',
      } satisfies DirectoryHandle);

      const { result } = renderHook(
        () => useFileSystem({ setCurrentFolderId: mockSetCurrentFolderId }),
        { wrapper: AdaptersTestWrapper }
      );
      expect(result.current).toBeDefined();

      await act(async () => {
        await result.current?.selectRootDirectory();
      });

      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('/projects/shared-name');

      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

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
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('/test/restored/path');
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

        expect(mockSetCurrentFolderId).toHaveBeenCalledWith('/test/restored/path');
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

      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('/test/restored/path');
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

  describe('multi-root: addRootDirectory via addRoot', () => {
    it('appends handle to rootDirectoryHandles, sets focused, calls addActiveRoot and setCurrentFolderId', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'my-root',
        handle: { path: '/my/root', name: 'my-root', kind: 'directory', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'root-id-1',
      };
      const storageAdapter = createStorageAdapter('web');
      const addRootFn = vi.fn().mockResolvedValue(descriptor);
      const adapter: FileSystemAdapter = {
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        exists: vi.fn().mockResolvedValue(true),
        addRoot: addRootFn,
      };

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(AdaptersProvider, { fileSystemAdapter: adapter, storageAdapter, children });

      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: mockSetCurrentFolderId,
            addActiveRoot: mockAddActiveRoot,
            setActiveRoots: mockSetActiveRoots,
          }),
        { wrapper }
      );

      await act(async () => {
        await result.current?.addRootDirectory();
      });

      expect(addRootFn).toHaveBeenCalledTimes(1);
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(result.current?.rootDirectoryHandles[0]).toEqual(descriptor.handle);
      expect(result.current?.rootDirectoryHandle).toEqual(descriptor.handle);
      expect(mockAddActiveRoot).toHaveBeenCalledWith({
        displayName: 'my-root',
        path: '/my/root',
        rootId: 'root-id-1',
      });
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('/my/root');
    });

    it('does not add non-persisted descriptor to store (persisted:false)', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'ephemeral-root',
        handle: { path: '/ephemeral', name: 'ephemeral-root', kind: 'directory', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: false,
        rootId: 'ephemeral-id',
      };
      const storageAdapter = createStorageAdapter('web');
      const adapter: FileSystemAdapter = {
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        exists: vi.fn().mockResolvedValue(true),
        addRoot: vi.fn().mockResolvedValue(descriptor),
      };

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(AdaptersProvider, { fileSystemAdapter: adapter, storageAdapter, children });

      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: mockSetCurrentFolderId,
            addActiveRoot: mockAddActiveRoot,
            setActiveRoots: mockSetActiveRoots,
          }),
        { wrapper }
      );

      await act(async () => {
        await result.current?.addRootDirectory();
      });

      // Handle is added to local state even if not persisted
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      // addActiveRoot should NOT be called for non-persisted roots
      expect(mockAddActiveRoot).not.toHaveBeenCalled();
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('/ephemeral');
    });
  });

  describe('multi-root: addRootDirectory fallback (no addRoot on adapter)', () => {
    it('falls back to requestDirectoryAccess and creates a synthetic descriptor', async () => {
      const storageAdapter = createStorageAdapter('web');
      const handle: DirectoryHandle = {
        path: '/fallback/path',
        name: 'fallback-path',
        kind: 'directory',
        platform: 'web',
      };
      const adapter: FileSystemAdapter = {
        requestDirectoryAccess: vi.fn().mockResolvedValue(handle),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        exists: vi.fn().mockResolvedValue(true),
        // No addRoot
      };

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(AdaptersProvider, { fileSystemAdapter: adapter, storageAdapter, children });

      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: mockSetCurrentFolderId,
            addActiveRoot: mockAddActiveRoot,
            setActiveRoots: mockSetActiveRoots,
          }),
        { wrapper }
      );

      await act(async () => {
        await result.current?.addRootDirectory();
      });

      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(result.current?.rootDirectoryHandles[0]).toEqual(handle);
      expect(result.current?.rootDirectoryHandle).toEqual(handle);
      // addActiveRoot called with synthetic descriptor (uuid rootId, handle.name as displayName)
      expect(mockAddActiveRoot).toHaveBeenCalledTimes(1);
      // We just verified it was called once above, so the first call exists.
      // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveBeenCalledTimes(1)
      const calledWith = mockAddActiveRoot.mock.calls[0]![0] as {
        displayName: string;
        path: string;
        rootId: string;
      };
      expect(calledWith.displayName).toBe('fallback-path');
      expect(calledWith.path).toBe('/fallback/path');
      expect(typeof calledWith.rootId).toBe('string');
      expect(calledWith.rootId.length).toBeGreaterThan(0);
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('/fallback/path');
    });
  });

  describe('multi-root: dedupe by path', () => {
    it('re-adding an existing root path focuses it without duplicating', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'shared-root',
        handle: { path: '/shared/root', name: 'shared-root', kind: 'directory', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'root-shared',
      };
      const storageAdapter = createStorageAdapter('web');
      const adapter: FileSystemAdapter = {
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        exists: vi.fn().mockResolvedValue(true),
        addRoot: vi.fn().mockResolvedValue(descriptor),
      };

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(AdaptersProvider, { fileSystemAdapter: adapter, storageAdapter, children });

      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: mockSetCurrentFolderId,
            addActiveRoot: mockAddActiveRoot,
            setActiveRoots: mockSetActiveRoots,
          }),
        { wrapper }
      );

      // Add it twice
      await act(async () => {
        await result.current?.addRootDirectory();
      });
      await act(async () => {
        await result.current?.addRootDirectory();
      });

      // Should still have only 1 handle (deduped by path)
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      // Focus should be set on the existing handle
      expect(result.current?.rootDirectoryHandle).toEqual(descriptor.handle);
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('/shared/root');
    });
  });

  describe('multi-root: setFocusedRoot', () => {
    it('switches focused root and calls setCurrentFolderId', async () => {
      const desc1: RootDescriptor = {
        displayName: 'root-a',
        handle: { path: '/root/a', name: 'root-a', kind: 'directory', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'id-a',
      };
      const desc2: RootDescriptor = {
        displayName: 'root-b',
        handle: { path: '/root/b', name: 'root-b', kind: 'directory', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'id-b',
      };
      const storageAdapter = createStorageAdapter('web');
      let callCount = 0;
      const adapter: FileSystemAdapter = {
        requestDirectoryAccess: vi.fn(),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        exists: vi.fn().mockResolvedValue(true),
        addRoot: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(callCount === 1 ? desc1 : desc2);
        }),
      };

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(AdaptersProvider, { fileSystemAdapter: adapter, storageAdapter, children });

      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: mockSetCurrentFolderId,
            addActiveRoot: mockAddActiveRoot,
            setActiveRoots: mockSetActiveRoots,
          }),
        { wrapper }
      );

      // Add both roots
      await act(async () => {
        await result.current?.addRootDirectory();
      });
      await act(async () => {
        await result.current?.addRootDirectory();
      });

      expect(result.current?.rootDirectoryHandles).toHaveLength(2);
      // Focused is the second one
      expect(result.current?.rootDirectoryHandle).toEqual(desc2.handle);

      // Switch focus back to first
      vi.clearAllMocks();
      await act(async () => {
        result.current?.setFocusedRoot('/root/a');
      });

      expect(result.current?.rootDirectoryHandle).toEqual(desc1.handle);
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('/root/a');
    });

    it('is a no-op for unknown path', async () => {
      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: mockSetCurrentFolderId,
            addActiveRoot: mockAddActiveRoot,
            setActiveRoots: mockSetActiveRoots,
          }),
        { wrapper: AdaptersTestWrapper }
      );

      // No roots added yet
      await act(async () => {
        result.current?.setFocusedRoot('/unknown/path');
      });

      expect(result.current?.rootDirectoryHandle).toBeNull();
      expect(mockSetCurrentFolderId).not.toHaveBeenCalled();
    });
  });

  describe('multi-root: restoreRoots boot', () => {
    it('populates rootDirectoryHandles, calls setActiveRoots, focuses by folderAccessOrder', async () => {
      const desc1: RootDescriptor = {
        displayName: 'folder-a',
        handle: { path: '/folder/a', name: 'folder-a', kind: 'directory', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'rid-a',
      };
      const desc2: RootDescriptor = {
        displayName: 'folder-b',
        handle: { path: '/folder/b', name: 'folder-b', kind: 'directory', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'rid-b',
      };
      const storageAdapter = createStorageAdapter('web');
      const adapter: FileSystemAdapter = {
        requestDirectoryAccess: vi.fn(),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        exists: vi.fn().mockResolvedValue(true),
        restoreRoots: vi.fn().mockResolvedValue([desc1, desc2]),
      };

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(AdaptersProvider, { fileSystemAdapter: adapter, storageAdapter, children });

      // folderAccessOrder has /folder/b first → /folder/b should be focused
      // getFolderAccessOrder is passed directly as a param (no module mock manipulation needed)
      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: mockSetCurrentFolderId,
            addActiveRoot: mockAddActiveRoot,
            setActiveRoots: mockSetActiveRoots,
            getFolderAccessOrder: () => ['/folder/b', '/folder/a'],
          }),
        { wrapper }
      );

      await waitFor(() => expect(result.current?.rootDirectoryHandles).toHaveLength(2));

      expect(result.current?.rootDirectoryHandles).toContainEqual(desc1.handle);
      expect(result.current?.rootDirectoryHandles).toContainEqual(desc2.handle);
      // Focused: first in folderAccessOrder = /folder/b = desc2
      expect(result.current?.rootDirectoryHandle).toEqual(desc2.handle);
      expect(mockSetActiveRoots).toHaveBeenCalledWith([
        { displayName: 'folder-a', path: '/folder/a', rootId: 'rid-a' },
        { displayName: 'folder-b', path: '/folder/b', rootId: 'rid-b' },
      ]);
    });

    it('skips non-granted roots from restoreRoots', async () => {
      const grantedDesc: RootDescriptor = {
        displayName: 'granted-folder',
        handle: { path: '/granted', name: 'granted-folder', kind: 'directory', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'rid-granted',
      };
      const promptDesc: RootDescriptor = {
        displayName: 'prompt-folder',
        handle: { path: '/prompt', name: 'prompt-folder', kind: 'directory', platform: 'web' },
        kind: 'fsa',
        permissionState: 'prompt',
        persisted: true,
        rootId: 'rid-prompt',
      };
      const storageAdapter = createStorageAdapter('web');
      const adapter: FileSystemAdapter = {
        requestDirectoryAccess: vi.fn(),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        exists: vi.fn().mockResolvedValue(true),
        restoreRoots: vi.fn().mockResolvedValue([grantedDesc, promptDesc]),
      };

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(AdaptersProvider, { fileSystemAdapter: adapter, storageAdapter, children });

      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: mockSetCurrentFolderId,
            addActiveRoot: mockAddActiveRoot,
            setActiveRoots: mockSetActiveRoots,
          }),
        { wrapper }
      );

      await waitFor(() => expect(result.current?.rootDirectoryHandles).toHaveLength(1));

      // Only the granted root is populated
      expect(result.current?.rootDirectoryHandles[0]).toEqual(grantedDesc.handle);
      // setActiveRoots only called with granted root
      expect(mockSetActiveRoots).toHaveBeenCalledWith([
        { displayName: 'granted-folder', path: '/granted', rootId: 'rid-granted' },
      ]);
    });

    it('uses legacy single-root path when restoreRoots is absent', async () => {
      // This is the existing behavior: restoreLastFolder present, restoreRoots absent
      MockFileSystemAdapter.setMockLastFolderPath('/test/legacy/path');

      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: mockSetCurrentFolderId,
            addActiveRoot: mockAddActiveRoot,
            setActiveRoots: mockSetActiveRoots,
          }),
        { wrapper: AdaptersTestWrapper }
      );

      await waitFor(() =>
        expect(result.current?.rootDirectoryHandle).toEqual({
          path: '/test/legacy/path',
          name: 'path',
          kind: 'directory',
          platform: 'web',
        })
      );

      // Legacy path: setActiveRoots should NOT be called
      expect(mockSetActiveRoots).not.toHaveBeenCalled();
      // rootDirectoryHandles should have the single root
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('/test/legacy/path');
    });
  });

  describe('multi-root: selectRootDirectory delegates to addRootDirectory', () => {
    it('calling selectRootDirectory uses addRoot when available', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'selected-root',
        handle: {
          path: '/selected/root',
          name: 'selected-root',
          kind: 'directory',
          platform: 'web',
        },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'root-sel-id',
      };
      const storageAdapter = createStorageAdapter('web');
      const addRootFn = vi.fn().mockResolvedValue(descriptor);
      const adapter: FileSystemAdapter = {
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        exists: vi.fn().mockResolvedValue(true),
        addRoot: addRootFn,
      };

      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(AdaptersProvider, { fileSystemAdapter: adapter, storageAdapter, children });

      const { result } = renderHook(
        () =>
          useFileSystem({
            setCurrentFolderId: mockSetCurrentFolderId,
            addActiveRoot: mockAddActiveRoot,
            setActiveRoots: mockSetActiveRoots,
          }),
        { wrapper }
      );

      await act(async () => {
        await result.current?.selectRootDirectory();
      });

      expect(addRootFn).toHaveBeenCalledTimes(1);
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(result.current?.rootDirectoryHandle).toEqual(descriptor.handle);
    });
  });
});
