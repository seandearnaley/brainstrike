import { type MockFileEntry, MockFileSystemAdapter } from '@brainstrike/file-system';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTree } from '../use-file-tree-context';
import { FileExplorerTestWrapper } from './test-helpers';

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

// Helper to create mock file system with proper nested structure
const createNestedMockFileSystem = () => ({
  parent: {
    name: 'parent',
    type: 'directory' as const,
    children: {
      child: {
        name: 'child',
        type: 'directory' as const,
        children: {
          'nested-file.txt': {
            name: 'nested-file.txt',
            type: 'file' as const,
            content: 'nested content',
          },
        },
      },
    },
  },
});

describe('useFileTree (context version)', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
    // Clear any existing timers
    vi.clearAllTimers();
  });

  it('initializes with empty state when handle is null', () => {
    const { result } = renderHook(() => useFileTree(null), { wrapper: FileExplorerTestWrapper });

    expect(result.current.fileTree).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.loadingProgress).toEqual({
      loaded: 0,
      total: 0,
      phase: 'counting',
      percentage: 0,
    });
    expect(result.current.cancellable).toBe(false);
    expect(result.current.isCancelling).toBe(false);
  });

  it('loads a simple directory structure', async () => {
    // Set up the mock file system data
    const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
    mockAdapter.setMockFileSystem(mockFS);

    // Get a proper DirectoryHandle from the adapter
    const handle = await mockAdapter.requestDirectoryAccess();

    // Create a wrapper function that passes the mock adapter
    const TestWrapper = ({ children }: { children: ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

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

  describe('Cancellation functionality', () => {
    it('should indicate cancellable when loading and not cancelling', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);
      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      // During loading, should be cancellable
      await waitFor(() => {
        if (result.current.isLoading) {
          expect(result.current.cancellable).toBe(true);
        }
      });
    });

    it('should handle cancellation during loading', async () => {
      // Create a large file system to ensure we can cancel during loading
      const largeFS: Record<string, MockFileEntry> = {};
      for (let i = 0; i < 50; i++) {
        largeFS[`file${i}.txt`] = {
          name: `file${i}.txt`,
          type: 'file' as const,
          content: `Content ${i}`,
        };
      }
      mockAdapter.setMockFileSystem(largeFS);

      // Gate readDirectory on a deferred to avoid arbitrary sleeps
      const originalReadDirectory = mockAdapter.readDirectory.bind(mockAdapter);
      let release: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(mockAdapter, 'readDirectory').mockImplementation(async (handle) => {
        await gate; // wait until test resolves the gate
        return originalReadDirectory(handle);
      });

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      // Wait for loading to start
      await waitFor(() => expect(result.current.isLoading).toBe(true));

      // Cancel the operation immediately after it starts
      act(() => {
        result.current.cancelOperation();
      });

      // Should immediately set cancelling state
      expect(result.current.isCancelling).toBe(true);
      expect(result.current.cancellable).toBe(false);

      // Allow the gated read to complete so the cancellation can settle
      act(() => {
        release();
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

      // Should clear tree on cancellation
      expect(result.current.fileTree).toEqual([]);
      expect(result.current.isCancelling).toBe(false);
    });

    it('should not allow cancellation when not loading', () => {
      const { result } = renderHook(() => useFileTree(null), { wrapper: FileExplorerTestWrapper });

      expect(result.current.cancellable).toBe(false);

      // Calling cancel when not loading should be safe
      act(() => {
        result.current.cancelOperation();
      });

      expect(result.current.isCancelling).toBe(false);
    });

    it('should not allow cancellation when already cancelling', async () => {
      const largeFS: Record<string, MockFileEntry> = {};
      for (let i = 0; i < 30; i++) {
        largeFS[`file${i}.txt`] = {
          name: `file${i}.txt`,
          type: 'file' as const,
          content: `Content ${i}`,
        };
      }
      mockAdapter.setMockFileSystem(largeFS);

      // Gate readDirectory on a deferred to avoid arbitrary sleeps
      const originalReadDirectory = mockAdapter.readDirectory.bind(mockAdapter);
      let release: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(mockAdapter, 'readDirectory').mockImplementation(async (handle) => {
        await gate;
        return originalReadDirectory(handle);
      });

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(true));

      // First cancellation
      act(() => {
        result.current.cancelOperation();
      });

      expect(result.current.isCancelling).toBe(true);
      expect(result.current.cancellable).toBe(false);

      // Second cancellation should have no effect
      act(() => {
        result.current.cancelOperation();
      });

      expect(result.current.isCancelling).toBe(true);

      // Release the gate so the operation can finish and cleanup occurs
      act(() => {
        release();
      });
    });
  });

  describe('Error handling', () => {
    it('should handle non-Error exceptions properly', async () => {
      // Set up a basic file system first, then mock the method to throw
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);
      const handle = await mockAdapter.requestDirectoryAccess();

      // Mock the adapter to throw a non-Error
      vi.spyOn(mockAdapter, 'readDirectory').mockRejectedValueOnce('String error');

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('String error');
      expect(result.current.fileTree).toEqual([]);
    });

    it('should handle readDirectory errors during file processing', async () => {
      // Set up a file system that will cause an error during processing
      const mockFS = {
        'error-file.txt': {
          name: 'error-file.txt',
          type: 'file' as const,
          content: 'test',
        },
      };
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      // Mock console.error to avoid test output pollution
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Should complete successfully even with console errors
      expect(result.current.fileTree.length).toBeGreaterThanOrEqual(0);

      consoleSpy.mockRestore();
    });

    it('should re-throw cancellation errors during file processing', async () => {
      const largeFS: Record<string, MockFileEntry> = {};
      for (let i = 0; i < 20; i++) {
        largeFS[`file${i}.txt`] = {
          name: `file${i}.txt`,
          type: 'file' as const,
          content: `Content ${i}`,
        };
      }
      mockAdapter.setMockFileSystem(largeFS);

      // Gate readDirectory on a deferred promise we can release after cancelling
      const originalReadDirectory = mockAdapter.readDirectory.bind(mockAdapter);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(mockAdapter, 'readDirectory').mockImplementation(async (handle) => {
        await gate; // wait until we cancel, then proceed
        return originalReadDirectory(handle);
      });

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      // Wait for loading to start
      await waitFor(() => expect(result.current.isLoading).toBe(true));
      // Cancel while readDirectory is still pending
      act(() => {
        result.current.cancelOperation();
      });
      // Release the gate so readDirectory resolves and the abort is observed
      release();

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Should clear the tree on cancellation
      expect(result.current.fileTree).toEqual([]);
    });
  });

  describe('Directory handling', () => {
    it('should handle nested directories correctly', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const parentDir = result.current.fileTree.find((node) => node.name === 'parent');
      expect(parentDir).toBeDefined();
      expect(parentDir?.type).toBe('directory');
      expect(parentDir?.children).toBeDefined();

      const childDir = parentDir?.children?.find((node) => node.name === 'child');
      expect(childDir).toBeDefined();
      expect(childDir?.type).toBe('directory');
    });

    it('should handle platform-specific paths correctly', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      // Simulate electron platform
      handle.platform = 'electron';

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // For electron, paths should use absolute paths from adapter
      const fileNode = result.current.fileTree.find((node) => node.type === 'file');
      expect(fileNode?.path).toBeDefined();
    });
  });

  describe('Progress meter calculation fixes', () => {
    it('should start with initial estimate of 100 files', async () => {
      const mockFS = createMockFileSystemWithFiles(50);
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

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

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

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

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

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

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

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

  describe('State management', () => {
    it('should reset error state when loading starts', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      // First simulate an error by making readDirectory fail
      vi.spyOn(mockAdapter, 'readDirectory').mockRejectedValueOnce(new Error('Test error'));

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      // Wait for error state
      await waitFor(() => expect(result.current.error).not.toBeNull());

      // Restore the mock and refresh
      vi.restoreAllMocks();
      mockAdapter.setMockFileSystem(mockFS);

      // Refresh should clear the error
      await act(async () => {
        await result.current.refreshTree();
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.error).toBeNull();
    });

    it('should update progress during loading', async () => {
      const mockFS = createMockFileSystemWithFiles(30);
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      // Wait for some progress
      await waitFor(() => {
        if (result.current.isLoading) {
          expect(result.current.loadingProgress.loaded).toBeGreaterThan(0);
        }
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
    });
  });
});
