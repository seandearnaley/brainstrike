import type { DirectoryHandle } from '@brainstrike/file-system';
import {
  AccessError,
  DialogError,
  type FileSystemAdapter,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import { act } from '@brainstrike/test-utils/react-act';
import type { RootDescriptor } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileSystem } from '../use-file-system.js';
import {
  AdaptersTestWrapper,
  createAdaptersTestWrapper,
  MockFileSystemAdapter,
} from './test-helpers.js';

// Mock the useFileExplorerStore
const mockSetCurrentFolderId = vi.fn();
const mockAddActiveRoot = vi.fn();
const mockRemoveActiveRoot = vi.fn();
const mockSetActiveRoots = vi.fn();
vi.mock('@brainstrike/file-explorer', () => ({
  useFileExplorerStore: vi.fn(() => ({
    addActiveRoot: mockAddActiveRoot,
    currentFolderId: 'test-folder-id',
    folderAccessOrder: [],
    removeActiveRoot: mockRemoveActiveRoot,
    setActiveRoots: mockSetActiveRoots,
    setCurrentFolderId: mockSetCurrentFolderId,
  })),
}));

// useFileSystem now REQUIRES the three store-sync actions (no silent no-ops).
// This helper supplies the stub mocks so each test overrides only what it asserts.
function makeFsParams(
  overrides: Partial<Parameters<typeof useFileSystem>[0]> = {}
): Parameters<typeof useFileSystem>[0] {
  return {
    addActiveRoot: mockAddActiveRoot,
    removeActiveRoot: mockRemoveActiveRoot,
    setActiveRoots: mockSetActiveRoots,
    setCurrentFolderId: mockSetCurrentFolderId,
    ...overrides,
  };
}

/** Mounts the hook and waits out the restore of the last folder it starts on mount. */
async function renderRestored() {
  const rendered = renderHook(() => useFileSystem(makeFsParams()), {
    wrapper: AdaptersTestWrapper,
  });
  await waitFor(() => expect(rendered.result.current?.isAccessLoading).toBe(false));
  return rendered;
}

describe('useFileSystem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockFileSystemAdapter.clearMockData();
  });

  describe('isFileSystemAccessSupported', () => {
    it('returns supported true when API is available and context is secure', async () => {
      const { result } = await renderRestored();
      expect(result.current).toBeDefined();
      if (!result.current) {
        throw new Error('result.current is undefined');
      }
      const { supported, reason } = result.current.isFileSystemAccessSupported();
      expect(supported).toBe(true);
      expect(reason).toBe('');
    });

    it('returns supported false when API is not available', async () => {
      // Mock the adapter to throw an error during initialization
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi
        .fn()
        .mockRejectedValue(new Error('File System Access API is not supported in this browser'));

      const { result } = await renderRestored();
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

    it('returns supported false when context is not secure', async () => {
      // With the adapter pattern, this test is less relevant since the adapter handles platform detection
      const { result } = await renderRestored();
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
    it('uses a RootId UUID (not path) as the folder id when name and path differ', async () => {
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi.fn().mockResolvedValue({
        kind: 'directory',
        name: 'shared-name',
        path: '/projects/shared-name',
        platform: 'web',
      } satisfies DirectoryHandle);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
      expect(result.current).toBeDefined();

      await act(async () => {
        await result.current?.selectRootDirectory();
      });

      // Since storage v5 the store receives a durable RootId UUID, not the path.
      expect(mockSetCurrentFolderId).toHaveBeenCalledTimes(1);
      const calledId = mockSetCurrentFolderId.mock.calls[0]?.[0] as string;
      expect(typeof calledId).toBe('string');
      expect(calledId).not.toBe('/projects/shared-name');
      // Verify it is a UUID (36-char hyphenated)
      expect(calledId).toMatch(/^[0-9a-f-]{36}$/u);

      MockFileSystemAdapter.prototype.requestDirectoryAccess = originalRequestDirectoryAccess;
    });

    it('sets root directory handle and updates folder state when selection is successful', async () => {
      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
      expect(result.current).toBeDefined();

      let handle: DirectoryHandle | null = null;
      await act(async () => {
        handle = await result.current?.selectRootDirectory();
      });

      expect(handle).toEqual({
        kind: 'directory',
        name: 'mock-root',
        path: 'mock-root',
        platform: 'web',
      });
      // The stored handle is stamped with a durable RootId (storage v5), so it
      // is a superset of the returned handle — match the known fields.
      expect(result.current?.rootDirectoryHandle).toMatchObject({
        kind: 'directory',
        name: 'mock-root',
        path: 'mock-root',
        platform: 'web',
      });
      // Since storage v5 the store receives a durable RootId UUID, not the path.
      const calledId = mockSetCurrentFolderId.mock.calls[0]?.[0] as string;
      expect(typeof calledId).toBe('string');
      expect(calledId).toMatch(/^[0-9a-f-]{36}$/u);
    });

    it('throws error when File System Access API is not supported', async () => {
      // Mock the adapter to throw an error
      const originalRequestDirectoryAccess = MockFileSystemAdapter.prototype.requestDirectoryAccess;
      MockFileSystemAdapter.prototype.requestDirectoryAccess = vi
        .fn()
        .mockRejectedValue(new Error('File System Access API is not supported in this browser'));

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
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

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
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

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
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

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
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

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
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

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
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

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
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

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
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

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });
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

  describe('clearRootDirectory', () => {
    it('clears the active handle and resets the folder id reference', async () => {
      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });

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
    it('increments the shared recent-roots revision after a successful grant', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'my-root',
        handle: { kind: 'directory', name: 'my-root', path: '/my/root', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'root-id-1',
      };
      const adapter: FileSystemAdapter = {
        addRoot: vi.fn().mockResolvedValue(descriptor),
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
      };
      const wrapper = createAdaptersTestWrapper(adapter);
      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      expect(result.current.recentRootsRevision).toBe(0);
      await act(async () => {
        await result.current.addRootDirectory();
      });
      expect(result.current.recentRootsRevision).toBe(1);
    });

    it('appends handle to rootDirectoryHandles, sets focused, calls addActiveRoot and setCurrentFolderId', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'my-root',
        handle: { kind: 'directory', name: 'my-root', path: '/my/root', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'root-id-1',
      };
      const addRootFn = vi.fn().mockResolvedValue(descriptor);
      const adapter: FileSystemAdapter = {
        addRoot: addRootFn,
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      await act(async () => {
        await result.current?.addRootDirectory();
      });

      expect(addRootFn).toHaveBeenCalledTimes(1);
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(result.current?.rootDirectoryHandles[0]).toMatchObject(descriptor.handle);
      expect(result.current?.rootDirectoryHandle).toMatchObject(descriptor.handle);
      expect(mockAddActiveRoot).toHaveBeenCalledWith({
        displayName: 'my-root',
        path: '/my/root',
        rootId: 'root-id-1',
      });
      // Storage v5: store receives the durable rootId UUID, not the path.
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('root-id-1');
    });

    it('does not add non-persisted descriptor to store (persisted:false)', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'ephemeral-root',
        handle: { kind: 'directory', name: 'ephemeral-root', path: '/ephemeral', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: false,
        rootId: 'ephemeral-id',
      };
      const adapter: FileSystemAdapter = {
        addRoot: vi.fn().mockResolvedValue(descriptor),
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      await act(async () => {
        await result.current?.addRootDirectory();
      });

      // Handle is added to local state even if not persisted
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      // addActiveRoot should NOT be called for non-persisted roots
      expect(mockAddActiveRoot).not.toHaveBeenCalled();
      // Storage v5: store receives the durable rootId UUID, not the path.
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('ephemeral-id');
    });
  });

  describe('multi-root: addRootDirectory fallback (no addRoot on adapter)', () => {
    it('falls back to requestDirectoryAccess and creates a synthetic descriptor', async () => {
      const handle: DirectoryHandle = {
        kind: 'directory',
        name: 'fallback-path',
        path: '/fallback/path',
        platform: 'web',
      };
      const adapter: FileSystemAdapter = {
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn().mockResolvedValue(handle),
        // No addRoot
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      await act(async () => {
        await result.current?.addRootDirectory();
      });

      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(result.current?.rootDirectoryHandles[0]).toMatchObject(handle);
      expect(result.current?.rootDirectoryHandle).toMatchObject(handle);
      // addActiveRoot called with synthetic descriptor (uuid rootId, handle.name as displayName)
      expect(mockAddActiveRoot).toHaveBeenCalledTimes(1);
      // We just verified it was called once above, so the first call exists.
      const calledWith = mockAddActiveRoot.mock.calls[0]![0] as {
        displayName: string;
        path: string;
        rootId: string;
      };
      expect(calledWith.displayName).toBe('fallback-path');
      expect(calledWith.path).toBe('/fallback/path');
      expect(typeof calledWith.rootId).toBe('string');
      expect(calledWith.rootId.length).toBeGreaterThan(0);
      // Storage v5: fallback path generates a synthetic uuid as rootId.
      const fallbackCalledId = mockSetCurrentFolderId.mock.calls[0]?.[0] as string;
      expect(typeof fallbackCalledId).toBe('string');
      expect(fallbackCalledId).toMatch(/^[0-9a-f-]{36}$/u);
    });
  });

  describe('multi-root: dedupe by path', () => {
    it('re-adding an existing root path focuses it without duplicating', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'shared-root',
        handle: { kind: 'directory', name: 'shared-root', path: '/shared/root', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'root-shared',
      };
      const adapter: FileSystemAdapter = {
        addRoot: vi.fn().mockResolvedValue(descriptor),
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

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
      expect(result.current?.rootDirectoryHandle).toMatchObject(descriptor.handle);
      // Storage v5: store receives the durable rootId UUID, not the path.
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('root-shared');
    });
  });

  describe('multi-root: setFocusedRoot', () => {
    it('switches focused root and calls setCurrentFolderId', async () => {
      const desc1: RootDescriptor = {
        displayName: 'root-a',
        handle: { kind: 'directory', name: 'root-a', path: '/root/a', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'id-a',
      };
      const desc2: RootDescriptor = {
        displayName: 'root-b',
        handle: { kind: 'directory', name: 'root-b', path: '/root/b', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'id-b',
      };
      let callCount = 0;
      const adapter: FileSystemAdapter = {
        addRoot: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(callCount === 1 ? desc1 : desc2);
        }),
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn(),
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      // Add both roots
      await act(async () => {
        await result.current?.addRootDirectory();
      });
      await act(async () => {
        await result.current?.addRootDirectory();
      });

      expect(result.current?.rootDirectoryHandles).toHaveLength(2);
      // Focused is the second one
      expect(result.current?.rootDirectoryHandle).toMatchObject(desc2.handle);

      // Switch focus back to first — callers pass the durable RootId, not the path.
      vi.clearAllMocks();
      await act(async () => {
        result.current?.setFocusedRoot('id-a');
      });

      expect(result.current?.rootDirectoryHandle).toMatchObject(desc1.handle);
      // Storage v5: setFocusedRoot resolves the focused root by its RootId.
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('id-a');
    });

    it('is a no-op for unknown path', async () => {
      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });

      // No roots added yet
      await act(async () => {
        result.current?.setFocusedRoot('/unknown/path');
      });

      expect(result.current?.rootDirectoryHandle).toBeNull();
      expect(mockSetCurrentFolderId).not.toHaveBeenCalled();
    });
  });

  describe('multi-root: restoreRoots boot', () => {
    it('publishes a recent-roots refresh after restore backfills granted roots', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'restored-root',
        handle: {
          kind: 'directory',
          name: 'restored-root',
          path: '/restored/root',
          platform: 'web',
        },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'restored-root-id',
      };
      const adapter: FileSystemAdapter = {
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn(),
        restoreRoots: vi.fn().mockResolvedValue([descriptor]),
      };
      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      await waitFor(() => expect(result.current.rootDirectoryHandles).toHaveLength(1));
      expect(result.current.recentRootsRevision).toBe(1);
    });

    it('populates rootDirectoryHandles, calls setActiveRoots, focuses by folderAccessOrder', async () => {
      const desc1: RootDescriptor = {
        displayName: 'folder-a',
        handle: { kind: 'directory', name: 'folder-a', path: '/folder/a', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'rid-a',
      };
      const desc2: RootDescriptor = {
        displayName: 'folder-b',
        handle: { kind: 'directory', name: 'folder-b', path: '/folder/b', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'rid-b',
      };
      const adapter: FileSystemAdapter = {
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn(),
        restoreRoots: vi.fn().mockResolvedValue([desc1, desc2]),
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      // folderAccessOrder is oldest first: /folder/b was focused last → /folder/b is focused
      // getFolderAccessOrder is passed directly as a param (no module mock manipulation needed)
      const { result } = renderHook(
        () =>
          useFileSystem(makeFsParams({ getFolderAccessOrder: () => ['/folder/a', '/folder/b'] })),
        { wrapper }
      );

      await waitFor(() => expect(result.current?.rootDirectoryHandles).toHaveLength(2));

      expect(result.current?.rootDirectoryHandles).toEqual(
        expect.arrayContaining([expect.objectContaining(desc1.handle)])
      );
      expect(result.current?.rootDirectoryHandles).toEqual(
        expect.arrayContaining([expect.objectContaining(desc2.handle)])
      );
      // Focused: newest in folderAccessOrder = /folder/b = desc2
      expect(result.current?.rootDirectoryHandle).toMatchObject(desc2.handle);
      expect(mockSetActiveRoots).toHaveBeenCalledWith([
        { displayName: 'folder-a', path: '/folder/a', rootId: 'rid-a' },
        { displayName: 'folder-b', path: '/folder/b', rootId: 'rid-b' },
      ]);
    });

    it('skips non-granted roots from restoreRoots', async () => {
      const grantedDesc: RootDescriptor = {
        displayName: 'granted-folder',
        handle: { kind: 'directory', name: 'granted-folder', path: '/granted', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'rid-granted',
      };
      const promptDesc: RootDescriptor = {
        displayName: 'prompt-folder',
        handle: { kind: 'directory', name: 'prompt-folder', path: '/prompt', platform: 'web' },
        kind: 'fsa',
        permissionState: 'prompt',
        persisted: true,
        rootId: 'rid-prompt',
      };
      const adapter: FileSystemAdapter = {
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn(),
        restoreRoots: vi.fn().mockResolvedValue([grantedDesc, promptDesc]),
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      await waitFor(() => expect(result.current?.rootDirectoryHandles).toHaveLength(1));

      // Only the granted root is populated
      expect(result.current?.rootDirectoryHandles[0]).toMatchObject(grantedDesc.handle);
      // setActiveRoots only called with granted root
      expect(mockSetActiveRoots).toHaveBeenCalledWith([
        { displayName: 'granted-folder', path: '/granted', rootId: 'rid-granted' },
      ]);
    });
  });

  describe('setRootDirectoryHandle (storage v5)', () => {
    it('writes the registered RootId (not the path) to the store', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'reg-root',
        handle: { kind: 'directory', name: 'reg-root', path: '/reg/root', platform: 'web' },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'rid-registered',
      };
      const adapter: FileSystemAdapter = {
        addRoot: vi.fn().mockResolvedValue(descriptor),
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      // Register the root (populates rootIdByPath with rid-registered).
      await act(async () => {
        await result.current?.addRootDirectory();
      });

      vi.clearAllMocks();
      // The restore caller stamps the durable RootId onto the handle before
      // handing it to setRootDirectoryHandle (identity is rootId-only).
      await act(async () => {
        result.current?.setRootDirectoryHandle({ ...descriptor.handle, rootId: descriptor.rootId });
      });

      // Storage v5: the durable RootId is written, never the path.
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('rid-registered');
      expect(mockSetCurrentFolderId).not.toHaveBeenCalledWith('/reg/root');
    });

    it('throws on an unstamped root handle instead of silently falling back to the path', async () => {
      const { result } = await renderRestored();

      const unstamped: DirectoryHandle = {
        kind: 'directory',
        name: 'never-registered',
        path: '/never/registered',
        platform: 'web',
      };

      // The legacy path fallback is gone: every root source must stamp a rootId.
      // An unstamped handle reaching the reducer fails loud in dev (no silent path
      // fallback that would collide same-named roots).
      expect(() => result.current?.setRootDirectoryHandle(unstamped)).toThrow(
        /unstamped root handle/u
      );
      expect(mockSetCurrentFolderId).not.toHaveBeenCalled();
    });
  });

  describe('multi-root: selectRootDirectory delegates to addRootDirectory', () => {
    it('calling selectRootDirectory uses addRoot when available', async () => {
      const descriptor: RootDescriptor = {
        displayName: 'selected-root',
        handle: {
          kind: 'directory',
          name: 'selected-root',
          path: '/selected/root',
          platform: 'web',
        },
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'root-sel-id',
      };
      const addRootFn = vi.fn().mockResolvedValue(descriptor);
      const adapter: FileSystemAdapter = {
        addRoot: addRootFn,
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      await act(async () => {
        await result.current?.selectRootDirectory();
      });

      expect(addRootFn).toHaveBeenCalledTimes(1);
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(result.current?.rootDirectoryHandle).toMatchObject(descriptor.handle);
    });
  });

  describe('multi-root: registerRestoredHandles (restore banner)', () => {
    const handleA: DirectoryHandle = {
      kind: 'directory',
      name: 'Root A',
      path: 'Root A',
      platform: 'web',
    };
    const handleB: DirectoryHandle = {
      kind: 'directory',
      name: 'Root B',
      path: 'Root B',
      platform: 'web',
    };

    it('registers BOTH restored handles, derives rootIds from adapter descriptors, focuses handles[0]', async () => {
      // restoreRoots returns permissionState 'prompt' (boot restore skips them —
      // exactly the banner scenario), but the descriptors still carry rootId+path.
      const restoreRootsFn = vi.fn().mockResolvedValue([
        {
          displayName: 'Root A',
          handle: handleA,
          kind: 'fsa',
          permissionState: 'prompt',
          persisted: true,
          rootId: 'root-a',
        },
        {
          displayName: 'Root B',
          handle: handleB,
          kind: 'fsa',
          permissionState: 'prompt',
          persisted: true,
          rootId: 'root-b',
        },
      ] satisfies RootDescriptor[]);
      const adapter: FileSystemAdapter = {
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn(),
        restoreRoots: restoreRootsFn,
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      // Simulate beginRestore resolving TWO handles → register them all.
      await act(async () => {
        await result.current?.registerRestoredHandles([handleA, handleB]);
      });

      // Both handles registered (addOrFocusHandle x2)
      expect(result.current?.rootDirectoryHandles).toHaveLength(2);
      expect(result.current?.rootDirectoryHandles).toMatchObject([handleA, handleB]);
      // handles[0] focused
      expect(result.current?.rootDirectoryHandle).toMatchObject(handleA);
      // Storage v5: store receives the durable rootId from the adapter descriptor.
      expect(mockSetCurrentFolderId).toHaveBeenLastCalledWith('root-a');
      // addActiveRoot x2 with descriptor-derived rootIds
      expect(mockAddActiveRoot).toHaveBeenCalledTimes(2);
      expect(mockAddActiveRoot).toHaveBeenCalledWith({
        displayName: 'Root A',
        path: 'Root A',
        rootId: 'root-a',
      });
      expect(mockAddActiveRoot).toHaveBeenCalledWith({
        displayName: 'Root B',
        path: 'Root B',
        rootId: 'root-b',
      });
    });

    it('publishes a recent-roots refresh after restore-access backfills a granted root', async () => {
      const grantedDescriptor: RootDescriptor = {
        displayName: 'Root A',
        handle: handleA,
        kind: 'fsa',
        permissionState: 'granted',
        persisted: true,
        rootId: 'root-a',
      };
      const adapter: FileSystemAdapter = {
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn(),
        restoreRoots: vi.fn().mockResolvedValue([grantedDescriptor]),
      };
      const wrapper = createAdaptersTestWrapper(adapter);
      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });
      await waitFor(() => expect(result.current.recentRootsRevision).toBe(1));

      await act(async () => {
        await result.current.registerRestoredHandles([handleA]);
      });

      expect(result.current.recentRootsRevision).toBe(2);
    });

    it('falls back to synthetic rootIds when the adapter has no restoreRoots', async () => {
      const adapter: FileSystemAdapter = {
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn(),
        // No restoreRoots
      };

      const wrapper = createAdaptersTestWrapper(adapter);

      const { result } = renderHook(() => useFileSystem(makeFsParams()), { wrapper });

      await act(async () => {
        await result.current?.registerRestoredHandles([handleA, handleB]);
      });

      expect(result.current?.rootDirectoryHandles).toHaveLength(2);
      expect(result.current?.rootDirectoryHandle).toMatchObject(handleA);
      expect(mockAddActiveRoot).toHaveBeenCalledTimes(2);
      for (const call of mockAddActiveRoot.mock.calls) {
        const arg = call[0] as { rootId: string };
        expect(typeof arg.rootId).toBe('string');
        expect(arg.rootId.length).toBeGreaterThan(0);
      }
    });
  });

  describe('multi-root: removeRootDirectory (disconnect)', () => {
    const descriptorA: RootDescriptor = {
      displayName: 'root-a',
      handle: { kind: 'directory', name: 'root-a', path: '/roots/a', platform: 'web' },
      kind: 'fsa',
      permissionState: 'granted',
      persisted: true,
      rootId: 'root-id-a',
    };
    const descriptorB: RootDescriptor = {
      displayName: 'root-b',
      handle: { kind: 'directory', name: 'root-b', path: '/roots/b', platform: 'web' },
      kind: 'fsa',
      permissionState: 'granted',
      persisted: true,
      rootId: 'root-id-b',
    };

    function createMultiRootAdapter(options: { withRemoveRoot?: boolean } = {}): {
      adapter: FileSystemAdapter;
      addRootFn: ReturnType<typeof vi.fn>;
      removeRootFn: ReturnType<typeof vi.fn>;
    } {
      const { withRemoveRoot = true } = options;
      const addRootFn = vi
        .fn()
        .mockResolvedValueOnce(descriptorA)
        .mockResolvedValueOnce(descriptorB);
      const removeRootFn = vi.fn().mockResolvedValue(undefined);
      const adapter: FileSystemAdapter = {
        addRoot: addRootFn,
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptorA.handle),
        ...(withRemoveRoot ? { removeRoot: removeRootFn } : {}),
      };
      return { adapter, addRootFn, removeRootFn };
    }

    function renderMultiRootHook(adapter: FileSystemAdapter) {
      const wrapper = createAdaptersTestWrapper(adapter);
      return renderHook(
        () =>
          useFileSystem({
            addActiveRoot: mockAddActiveRoot,
            removeActiveRoot: mockRemoveActiveRoot,
            setActiveRoots: mockSetActiveRoots,
            setCurrentFolderId: mockSetCurrentFolderId,
          }),
        { wrapper }
      );
    }

    it('calls adapter.removeRoot, removes the handle + rootId mapping, and purges the store', async () => {
      const { adapter, removeRootFn } = createMultiRootAdapter();
      const { result } = renderMultiRootHook(adapter);

      await act(async () => {
        await result.current?.addRootDirectory();
        await result.current?.addRootDirectory();
      });
      expect(result.current?.rootDirectoryHandles).toHaveLength(2);

      await act(async () => {
        await result.current?.removeRootDirectory('root-id-b');
      });

      expect(removeRootFn).toHaveBeenCalledExactlyOnceWith('root-id-b');
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(result.current?.rootDirectoryHandles[0]).toMatchObject(descriptorA.handle);
      expect(result.current?.rootIdByPath.has('/roots/b')).toBe(false);
      expect(mockRemoveActiveRoot).toHaveBeenCalledExactlyOnceWith('root-id-b');
    });

    it('shifts focus to the first remaining root when the focused root is removed', async () => {
      const { adapter } = createMultiRootAdapter();
      const { result } = renderMultiRootHook(adapter);

      await act(async () => {
        await result.current?.addRootDirectory();
        await result.current?.addRootDirectory();
      });
      // The second addRoot leaves B focused.
      expect(result.current?.rootDirectoryHandle).toMatchObject(descriptorB.handle);
      mockSetCurrentFolderId.mockClear();

      await act(async () => {
        await result.current?.removeRootDirectory('root-id-b');
      });

      expect(result.current?.rootDirectoryHandle).toMatchObject(descriptorA.handle);
      // Focus shift writes the REMAINING root's id via the established action.
      expect(mockSetCurrentFolderId).toHaveBeenCalledExactlyOnceWith('root-id-a');
      // Ordering: focus shift must land BEFORE the store purge so the purge
      // removes the snapshot setCurrentFolderId writes back for the outgoing root.
      const focusOrder = mockSetCurrentFolderId.mock.invocationCallOrder[0] ?? 0;
      const purgeOrder = mockRemoveActiveRoot.mock.invocationCallOrder[0] ?? 0;
      expect(focusOrder).toBeLessThan(purgeOrder);
    });

    it('does not change focus when a non-focused root is removed', async () => {
      const { adapter } = createMultiRootAdapter();
      const { result } = renderMultiRootHook(adapter);

      await act(async () => {
        await result.current?.addRootDirectory();
        await result.current?.addRootDirectory();
      });
      mockSetCurrentFolderId.mockClear();

      await act(async () => {
        // B is focused; remove A.
        await result.current?.removeRootDirectory('root-id-a');
      });

      expect(result.current?.rootDirectoryHandle).toMatchObject(descriptorB.handle);
      expect(mockSetCurrentFolderId).not.toHaveBeenCalled();
      expect(mockRemoveActiveRoot).toHaveBeenCalledExactlyOnceWith('root-id-a');
    });

    it('clears currentFolderId (null) when the last root is removed', async () => {
      const { adapter } = createMultiRootAdapter();
      const { result } = renderMultiRootHook(adapter);

      await act(async () => {
        await result.current?.addRootDirectory();
      });
      mockSetCurrentFolderId.mockClear();

      await act(async () => {
        await result.current?.removeRootDirectory('root-id-a');
      });

      expect(result.current?.rootDirectoryHandle).toBeNull();
      expect(result.current?.rootDirectoryHandles).toHaveLength(0);
      expect(mockSetCurrentFolderId).toHaveBeenCalledExactlyOnceWith(null);
    });

    it('keeps renderer state intact when the authoritative adapter removal rejects', async () => {
      const { adapter, removeRootFn } = createMultiRootAdapter();
      removeRootFn.mockRejectedValue(new Error('storage unavailable'));
      const { result } = renderMultiRootHook(adapter);

      await act(async () => {
        await result.current?.addRootDirectory();
        await result.current?.addRootDirectory();
      });

      await expect(
        act(async () => result.current?.removeRootDirectory('root-id-b'))
      ).rejects.toThrow('storage unavailable');

      expect(removeRootFn).toHaveBeenCalledWith('root-id-b');
      expect(result.current?.rootDirectoryHandles).toHaveLength(2);
      expect(mockRemoveActiveRoot).not.toHaveBeenCalled();
    });

    it('proceeds with UI removal when the adapter has no removeRoot method', async () => {
      const { adapter } = createMultiRootAdapter({ withRemoveRoot: false });
      const { result } = renderMultiRootHook(adapter);

      await act(async () => {
        await result.current?.addRootDirectory();
        await result.current?.addRootDirectory();
      });

      await act(async () => {
        await result.current?.removeRootDirectory('root-id-a');
      });

      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(mockRemoveActiveRoot).toHaveBeenCalledExactlyOnceWith('root-id-a');
    });
  });

  describe('multi-root: same-named roots stay distinct (web path collision)', () => {
    // On web, DirectoryHandle.path is just the directory name (the FSA API
    // hides the absolute path), so two folders both named "project" share a
    // path. Their durable RootIds differ — identity must follow the RootId, not
    // the path, or add/focus/remove all target the wrong root.
    const NAME = 'project';
    const descA: RootDescriptor = {
      displayName: NAME,
      handle: { kind: 'directory', name: NAME, path: NAME, platform: 'web' },
      kind: 'fsa',
      permissionState: 'granted',
      persisted: true,
      rootId: 'rid-same-a',
    };
    const descB: RootDescriptor = {
      displayName: NAME,
      handle: { kind: 'directory', name: NAME, path: NAME, platform: 'web' },
      kind: 'fsa',
      permissionState: 'granted',
      persisted: true,
      rootId: 'rid-same-b',
    };

    function renderWithBothRoots() {
      const addRootFn = vi.fn().mockResolvedValueOnce(descA).mockResolvedValueOnce(descB);
      const adapter: FileSystemAdapter = {
        addRoot: addRootFn,
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        removeRoot: vi.fn().mockResolvedValue(undefined),
        requestDirectoryAccess: vi.fn().mockResolvedValue(descA.handle),
      };
      const wrapper = createAdaptersTestWrapper(adapter);
      const hook = renderHook(
        () =>
          useFileSystem({
            addActiveRoot: mockAddActiveRoot,
            removeActiveRoot: mockRemoveActiveRoot,
            setActiveRoots: mockSetActiveRoots,
            setCurrentFolderId: mockSetCurrentFolderId,
          }),
        { wrapper }
      );
      return hook;
    }

    it('adds BOTH same-named roots instead of collapsing into one', async () => {
      const { result } = renderWithBothRoots();

      await act(async () => {
        await result.current?.addRootDirectory();
        await result.current?.addRootDirectory();
      });

      // The path collides, but the distinct RootIds keep them separate.
      expect(result.current?.rootDirectoryHandles).toHaveLength(2);
      const ids = result.current?.rootDirectoryHandles.map((h) => h.rootId);
      expect(ids).toEqual(['rid-same-a', 'rid-same-b']);
    });

    it('stamps each stored handle with its own RootId (self-identifying)', async () => {
      const { result } = renderWithBothRoots();

      await act(async () => {
        await result.current?.addRootDirectory();
        await result.current?.addRootDirectory();
      });

      const [a, b] = result.current?.rootDirectoryHandles ?? [];
      expect(a?.rootId).toBe('rid-same-a');
      expect(b?.rootId).toBe('rid-same-b');
      // The currently-focused handle is the second-added root.
      expect(result.current?.rootDirectoryHandle?.rootId).toBe('rid-same-b');
    });

    it('removes the correct same-named root by RootId, not path', async () => {
      const { result } = renderWithBothRoots();

      await act(async () => {
        await result.current?.addRootDirectory();
        await result.current?.addRootDirectory();
      });
      expect(result.current?.rootDirectoryHandles).toHaveLength(2);

      await act(async () => {
        // Remove the FIRST same-named root; the second must survive.
        await result.current?.removeRootDirectory('rid-same-a');
      });

      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(result.current?.rootDirectoryHandles[0]?.rootId).toBe('rid-same-b');
      expect(mockRemoveActiveRoot).toHaveBeenCalledExactlyOnceWith('rid-same-a');
    });

    it('focuses the correct same-named root by RootId via setFocusedRoot', async () => {
      const { result } = renderWithBothRoots();

      await act(async () => {
        await result.current?.addRootDirectory();
        await result.current?.addRootDirectory();
      });
      // B is focused after the second add; switch focus to A by its RootId.
      mockSetCurrentFolderId.mockClear();

      act(() => {
        result.current?.setFocusedRoot('rid-same-a');
      });

      expect(result.current?.rootDirectoryHandle?.rootId).toBe('rid-same-a');
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('rid-same-a');
    });

    it('setRootDirectoryHandle with the stamped restore handle re-focuses the root (no duplicate)', async () => {
      // The restore modal now stamps the durable RootId (from pendingRestore) onto
      // the handle before routing it through setRoot. Identity is rootId-only, so
      // the stamped handle matches the already-stored root by rootKey and re-focuses
      // it instead of appending a duplicate.
      const { result } = renderWithBothRoots();

      await act(async () => {
        await result.current?.addRootDirectory();
      });
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);

      act(() => {
        result.current?.setRootDirectoryHandle({
          kind: 'directory',
          name: NAME,
          path: NAME,
          platform: 'web',
          rootId: 'rid-same-a',
        });
      });

      // No duplicate, and the stored handle keeps its stamped identity.
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(result.current?.rootDirectoryHandle?.rootId).toBe('rid-same-a');
    });

    it('reconciles an injected fixture handle with its later restore of the same rootId (no duplicate root)', async () => {
      // The inline fixture now stamps a stable rootId at its source, so the SAME
      // stamped handle object flows through both the inject (event → setRoot) and
      // the auto-restore (registerRestoredHandles). Identity is rootId-only, so the
      // two reconcile to ONE root by rootKey — otherwise the same logical root
      // becomes two entries and the file tree renders twice (the Web E2E
      // "2 treegrids" regression). registerRestoredHandles reuses handle.rootId.
      const rootId = crypto.randomUUID();
      const handle: DirectoryHandle = {
        kind: 'directory',
        name: 'fixture-root',
        path: '/fixture-root',
        platform: 'web',
        rootId,
      };
      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: AdaptersTestWrapper,
      });

      // 1) Inject the stamped fixture handle (mirrors the fixture event → setRoot).
      act(() => {
        result.current?.setRootDirectoryHandle(handle);
      });
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);

      // 2) Auto-restore of the SAME stamped handle (mirrors the adapter restore).
      await act(async () => {
        await result.current?.registerRestoredHandles([handle]);
      });

      // Reconciled to ONE root keyed by the fixture's stable rootId, not two.
      expect(result.current?.rootDirectoryHandles).toHaveLength(1);
      expect(result.current?.rootDirectoryHandles[0]?.rootId).toBe(rootId);
    });
  });
  describe('multi-root: addRootDirectoryByPath / listRecentRoots (desktop capability)', () => {
    const descriptor: RootDescriptor = {
      displayName: 'alpha',
      handle: { kind: 'directory', name: 'alpha', path: '/ws/alpha', platform: 'electron' },
      kind: 'path',
      permissionState: 'granted',
      persisted: true,
      rootId: 'root-alpha',
    };

    function createAdapterStub(): FileSystemAdapter {
      return {
        exists: vi.fn().mockResolvedValue(true),
        readDirectory: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        requestDirectoryAccess: vi.fn().mockResolvedValue(descriptor.handle),
      };
    }

    function wrapperFor(adapter: FileSystemAdapter) {
      // Delegates to the shared factory in test-helpers.tsx (see its doc
      // comment) rather than inlining another AdaptersProvider wrapper here —
      // one place owns the "optional children, matches AdaptersTestWrapper"
      // shape for every per-test adapter.
      return createAdaptersTestWrapper(adapter);
    }

    it('registers the root on a successful picker-less add', async () => {
      const addRootByPath = vi.fn().mockResolvedValue(descriptor);
      const listRecentRoots = vi
        .fn()
        .mockResolvedValue([{ displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' }]);
      const adapter: FileSystemAdapter = { ...createAdapterStub(), addRootByPath, listRecentRoots };

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: wrapperFor(adapter),
      });

      expect(result.current?.addRootDirectoryByPath).toBeDefined();
      await act(async () => {
        await result.current?.addRootDirectoryByPath?.('/ws/alpha');
      });

      expect(addRootByPath).toHaveBeenCalledWith('/ws/alpha');
      expect(result.current?.rootDirectoryHandles[0]).toMatchObject(descriptor.handle);
      expect(mockAddActiveRoot).toHaveBeenCalledWith({
        displayName: 'alpha',
        path: '/ws/alpha',
        rootId: 'root-alpha',
      });
      expect(mockSetCurrentFolderId).toHaveBeenCalledWith('root-alpha');
      expect(await result.current?.listRecentRoots?.()).toEqual([
        { displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' },
      ]);
    });

    it('surfaces a rejected path instead of resolving to null', async () => {
      const adapter: FileSystemAdapter = {
        ...createAdapterStub(),
        addRootByPath: vi
          .fn()
          .mockRejectedValue(
            new Error('Folder was never granted in this app; use Add Folder to grant it.')
          ),
        listRecentRoots: vi.fn().mockResolvedValue([]),
      };

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: wrapperFor(adapter),
      });

      await act(async () => {
        await expect(result.current?.addRootDirectoryByPath?.('/ws/never')).rejects.toThrow(
          'Folder was never granted in this app; use Add Folder to grant it.'
        );
      });
      expect(mockAddActiveRoot).not.toHaveBeenCalled();
    });

    it('routes a listRecentRoots rejection through mapFileSystemError', async () => {
      const adapter: FileSystemAdapter = {
        ...createAdapterStub(),
        addRootByPath: vi.fn().mockResolvedValue(descriptor),
        listRecentRoots: vi
          .fn()
          .mockRejectedValue(new AccessError('raw ledger read failure', '/ws/alpha', 'read')),
      };

      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: wrapperFor(adapter),
      });

      await expect(result.current?.listRecentRoots?.()).rejects.toThrow(
        'Unable to access the selected directory. Please check permissions and try again.'
      );
    });

    it('omits both on an adapter without the capability (web)', () => {
      const { result } = renderHook(() => useFileSystem(makeFsParams()), {
        wrapper: wrapperFor(createAdapterStub()),
      });

      expect(result.current?.addRootDirectoryByPath).toBeUndefined();
      expect(result.current?.listRecentRoots).toBeUndefined();
    });
  });
});

describe('useFileSystem: openRootDirectory (ADR-0034)', () => {
  const descriptor = (name: string, worktree = false): RootDescriptor => ({
    displayName: name,
    handle: {
      kind: 'directory',
      name,
      path: `/roots/${name}`,
      platform: 'electron',
      ...(worktree ? { worktree: true as const } : {}),
    },
    kind: 'fsa',
    permissionState: 'granted',
    persisted: true,
    rootId: `root-id-${name}`,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderWith(adapter: FileSystemAdapter) {
    return renderHook(() => useFileSystem(makeFsParams()), {
      wrapper: createAdaptersTestWrapper(adapter),
    });
  }

  it('replaces the open folders with the opened one and keeps each thread worktree', async () => {
    const openRoot = vi.fn().mockResolvedValue(descriptor('gamma'));
    const adapter: FileSystemAdapter = {
      addRoot: vi
        .fn()
        .mockResolvedValueOnce(descriptor('alpha'))
        .mockResolvedValueOnce(descriptor('beta'))
        .mockResolvedValueOnce(descriptor('swift-badger', true)),
      exists: vi.fn().mockResolvedValue(true),
      openRoot,
      readDirectory: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(''),
      requestDirectoryAccess: vi.fn(),
    };
    const { result } = renderWith(adapter);
    await act(async () => {
      await result.current?.addRootDirectory();
      await result.current?.addRootDirectory();
      await result.current?.addRootDirectory();
    });
    vi.clearAllMocks();

    await act(async () => {
      await result.current?.openRootDirectory?.('/roots/gamma');
    });

    expect(openRoot).toHaveBeenCalledExactlyOnceWith('/roots/gamma');
    expect(result.current?.rootDirectoryHandles.map((handle) => handle.rootId)).toEqual([
      'root-id-gamma',
      'root-id-swift-badger',
    ]);
    expect(result.current?.rootDirectoryHandle?.rootId).toBe('root-id-gamma');
    expect(mockSetCurrentFolderId).toHaveBeenCalledWith('root-id-gamma');
    expect(mockRemoveActiveRoot.mock.calls.map(([rootId]) => rootId)).toEqual([
      'root-id-alpha',
      'root-id-beta',
    ]);
    expect(mockAddActiveRoot).toHaveBeenCalledExactlyOnceWith({
      displayName: 'gamma',
      path: '/roots/gamma',
      rootId: 'root-id-gamma',
    });
  });

  it('changes nothing when the person cancels the picker', async () => {
    const adapter: FileSystemAdapter = {
      addRoot: vi.fn().mockResolvedValueOnce(descriptor('alpha')),
      exists: vi.fn().mockResolvedValue(true),
      openRoot: vi.fn().mockRejectedValue(new UserCancelledError()),
      readDirectory: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(''),
      requestDirectoryAccess: vi.fn(),
    };
    const { result } = renderWith(adapter);
    await act(async () => {
      await result.current?.addRootDirectory();
    });
    vi.clearAllMocks();

    let opened: DirectoryHandle | null | undefined;
    await act(async () => {
      opened = await result.current?.openRootDirectory?.();
    });

    expect(opened).toBeNull();
    expect(result.current?.rootDirectoryHandles.map((handle) => handle.rootId)).toEqual([
      'root-id-alpha',
    ]);
    expect(mockRemoveActiveRoot).not.toHaveBeenCalled();
  });

  it('is absent where the adapter cannot replace the open folders (web)', () => {
    const { result } = renderWith({
      exists: vi.fn().mockResolvedValue(true),
      readDirectory: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(''),
      requestDirectoryAccess: vi.fn(),
    });
    expect(result.current?.openRootDirectory).toBeUndefined();
  });
});
