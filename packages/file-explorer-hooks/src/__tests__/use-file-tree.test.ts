import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { PartialRefreshError } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFileTree } from '../use-file-tree';
import { AdaptersTestWrapper, MockFileSystemAdapter } from './test-helpers';

describe('useFileTree', () => {
  let mockDirectoryHandle: DirectoryHandle;

  beforeEach(() => {
    // Clear any previous mock data
    MockFileSystemAdapter.clearMockData();

    mockDirectoryHandle = {
      kind: 'directory',
      name: 'root',
      path: 'root',
      platform: 'web',
    };
  });

  it('should initialize with empty state', () => {
    const { result } = renderHook(() => useFileTree(null), { wrapper: AdaptersTestWrapper });

    expect(result.current.fileTree).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  describe('Partial Refresh Scenarios', () => {
    it('should throw PartialRefreshError when some subdirectories fail to load', async () => {
      // Create a structure with files and subdirectories
      const mockSuccessFile: IFileNode = {
        name: 'success.txt',
        path: 'root/success.txt',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        size: 100,
      };

      const mockSuccessDir: IFileNode = {
        name: 'success-dir',
        path: 'root/success-dir',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      const mockFailDir: IFileNode = {
        name: 'fail-dir',
        path: 'root/fail-dir',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      // Setup root directory with mixed content
      MockFileSystemAdapter.setMockDirectoryData('root', [
        mockSuccessFile,
        mockSuccessDir,
        mockFailDir,
      ]);

      // Success directory has some files (hook will call with just the directory name)
      MockFileSystemAdapter.setMockDirectoryData('success-dir', [
        {
          name: 'nested.txt',
          path: 'root/success-dir/nested.txt',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 2,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ]);

      // Fail directory will throw an error when accessed (hook will call with just the directory name)
      MockFileSystemAdapter.setMockDirectoryError('fail-dir', new Error('Access denied'));

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      // Wait for initial load to complete
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      // Attempt refresh and expect it to throw
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(PartialRefreshError);
      if (error instanceof PartialRefreshError) {
        expect(error.successCount).toBeGreaterThan(0);
        expect(error.failCount).toBeGreaterThan(0);
      }
    });

    it('should throw regular Error when all subdirectories fail to load', async () => {
      // Create directories that will all fail
      const mockFailDir1: IFileNode = {
        name: 'fail-dir1',
        path: 'root/fail-dir1',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      const mockFailDir2: IFileNode = {
        name: 'fail-dir2',
        path: 'root/fail-dir2',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      MockFileSystemAdapter.setMockDirectoryData('root', [mockFailDir1, mockFailDir2]);

      // Make both directories fail (hook will call with just directory names)
      MockFileSystemAdapter.setMockDirectoryError('fail-dir1', new Error('Access denied'));
      MockFileSystemAdapter.setMockDirectoryError('fail-dir2', new Error('Access denied'));

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      // Wait for initial load to complete
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      // Attempt refresh and expect it to throw
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PartialRefreshError);
      if (error instanceof Error) {
        expect(error.message).toMatch(/Failed to refresh file tree/);
      }
    });

    it('should handle nested directory partial failures', async () => {
      // Create a complex nested structure
      const mockRootFile: IFileNode = {
        name: 'root.txt',
        path: 'root/root.txt',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      };

      const mockParentDir: IFileNode = {
        name: 'parent',
        path: 'root/parent',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      const mockSuccessNestedDir: IFileNode = {
        name: 'success-nested',
        path: 'root/parent/success-nested',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 2,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      const mockFailNestedDir: IFileNode = {
        name: 'fail-nested',
        path: 'root/parent/fail-nested',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 2,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      // Setup directory structure (hook will call with full paths for nested dirs)
      MockFileSystemAdapter.setMockDirectoryData('root', [mockRootFile, mockParentDir]);
      MockFileSystemAdapter.setMockDirectoryData('parent', [
        mockSuccessNestedDir,
        mockFailNestedDir,
      ]);
      MockFileSystemAdapter.setMockDirectoryData('parent/success-nested', [
        {
          name: 'deep.txt',
          path: 'root/parent/success-nested/deep.txt',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 3,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ]);

      // Make one nested directory fail (hook will call with full path for nested dirs)
      MockFileSystemAdapter.setMockDirectoryError('parent/fail-nested', new Error('Access denied'));

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      // Wait for initial load to complete
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      // Attempt refresh and expect it to throw
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(PartialRefreshError);
      if (error instanceof PartialRefreshError) {
        expect(error.successCount).toBeGreaterThan(0);
        expect(error.failCount).toBeGreaterThan(0);
      }
    });

    it('should maintain file tree state after partial refresh', async () => {
      // Setup initial successful structure
      const mockSuccessFile: IFileNode = {
        name: 'success.txt',
        path: 'root/success.txt',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      };

      const mockSuccessDir: IFileNode = {
        name: 'success-dir',
        path: 'root/success-dir',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      MockFileSystemAdapter.setMockDirectoryData('root', [mockSuccessFile, mockSuccessDir]);
      MockFileSystemAdapter.setMockDirectoryData('success-dir', []);

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      // Wait for initial load to complete
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      // Add a failing directory for refresh
      const mockFailDir: IFileNode = {
        name: 'fail-dir',
        path: 'root/fail-dir',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      MockFileSystemAdapter.setMockDirectoryData('root', [
        mockSuccessFile,
        mockSuccessDir,
        mockFailDir,
      ]);
      MockFileSystemAdapter.setMockDirectoryError('fail-dir', new Error('Access denied'));

      // Attempt refresh
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(PartialRefreshError);
      // Verify tree still contains successful files/directories
      expect(result.current.fileTree.length).toBeGreaterThan(0);
      const fileNames = result.current.fileTree.map((node) => node.name);
      expect(fileNames).toContain('success.txt');
    });
  });

  describe('Basic functionality', () => {
    it('should load a simple file tree successfully', async () => {
      const mockFile: IFileNode = {
        name: 'test.txt',
        path: 'root/test.txt',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      };

      MockFileSystemAdapter.setMockDirectoryData('root', [mockFile]);

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      // Wait for load to complete
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      expect(result.current.fileTree).toHaveLength(1);
      expect(result.current.fileTree[0]?.name).toBe('test.txt');
      expect(result.current.error).toBeNull();
    });

    it('accepts batchSize option without errors', async () => {
      MockFileSystemAdapter.setMockDirectoryData('root', []);
      vi.useFakeTimers();
      const { result } = renderHook(() => useFileTree(mockDirectoryHandle, { batchSize: 2 }), {
        wrapper: AdaptersTestWrapper,
      });
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
      });
      expect(result.current.fileTree).toEqual([]);
      vi.useRealTimers();
    });
  });
});
