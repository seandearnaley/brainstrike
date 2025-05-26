import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFileTree } from '../use-file-tree-context';
import { FileExplorerTestWrapper } from './test-helpers';

describe('useFileTree (context version)', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
  });

  it('initializes with empty state when handle is null', () => {
    const { result } = renderHook(() => useFileTree(null), { wrapper: FileExplorerTestWrapper });

    expect(result.current.fileTree).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.loadingProgress).toEqual({ loaded: 0, total: 0, phase: 'counting' });
  });

  it('loads a simple directory structure', async () => {
    // Set up the mock file system data
    const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
    mockAdapter.setMockFileSystem(mockFS);

    // Get a proper DirectoryHandle from the adapter
    const handle = await mockAdapter.requestDirectoryAccess();

    // Create a wrapper function that passes the mock adapter
    const TestWrapper = ({ children }: { children: ReactNode }) => {
      return FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
    };

    const { result } = renderHook(() => useFileTree(handle), {
      wrapper: TestWrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const names = result.current.fileTree.map((n) => n.name);
    expect(names).toEqual(['src', 'package.json', 'README.md']);
    expect(result.current.loadingProgress.loaded).toBeGreaterThan(0);
    expect(result.current.loadingProgress.phase).toBe('loading');

    await act(async () => {
      await expect(result.current.refreshTree()).resolves.not.toThrow();
    });
  });

  describe('Progress meter calculation fixes', () => {
    // Helper function to create a mock file system with many files
    const createMockFileSystemWithFiles = (count: number) => {
      const mockFS: Record<string, { name: string; type: 'file'; content: string }> = {};
      for (let i = 0; i < count; i++) {
        mockFS[`file${i}.txt`] = {
          name: `file${i}.txt`,
          type: 'file',
          content: `Content of file ${i}`,
        };
      }
      return mockFS;
    };

    it('should start with initial estimate of 100 files', async () => {
      const mockFS = createMockFileSystemWithFiles(50);
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) => {
        return FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      };

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      // Wait for loading to start
      await waitFor(() => expect(result.current.loadingProgress.total).toBe(100));
    });

    it('should dynamically adjust total when files exceed initial estimate', async () => {
      // Create more files than the initial estimate of 100
      const mockFS = createMockFileSystemWithFiles(150);
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) => {
        return FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      };

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      // Wait for processing to complete
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Total should have been adjusted upward from the initial 100
      expect(result.current.loadingProgress.total).toBeGreaterThan(100);
      expect(result.current.loadingProgress.loaded).toBeGreaterThan(100);
    });

    it('should handle very large file counts without wrong percentages', async () => {
      // Simulate the user's scenario: 3168 files (use a smaller number for testing)
      const mockFS = createMockFileSystemWithFiles(200);
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) => {
        return FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      };

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      // Wait for processing to complete
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Total should have been adjusted to accommodate all files
      expect(result.current.loadingProgress.total).toBeGreaterThanOrEqual(
        result.current.loadingProgress.loaded
      );

      // Calculate percentage manually to verify it's reasonable
      const percentage =
        (result.current.loadingProgress.loaded / result.current.loadingProgress.total) * 100;
      expect(percentage).toBeLessThanOrEqual(100);
      expect(percentage).toBeGreaterThan(0);
    });

    it('should prevent percentage over 100% by adjusting total dynamically', async () => {
      // Create exactly 101 files to exceed the initial estimate by 1
      const mockFS = createMockFileSystemWithFiles(101);
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) => {
        return FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      };

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      // Wait for processing to complete
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Calculate percentage and ensure it's never over 100%
      const percentage =
        (result.current.loadingProgress.loaded / result.current.loadingProgress.total) * 100;
      expect(percentage).toBeLessThanOrEqual(100);
      expect(result.current.loadingProgress.total).toBeGreaterThanOrEqual(
        result.current.loadingProgress.loaded
      );
    });
  });
});
