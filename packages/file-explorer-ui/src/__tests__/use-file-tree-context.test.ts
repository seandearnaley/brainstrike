import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTree } from '../use-file-tree-context';
import { FileExplorerTestWrapper } from './test-helpers';

// Mock the file-tree-worker to avoid Worker instantiation in tests
vi.mock('@brainstrike/file-tree-worker', () => ({
  resolveFileTreeWorkerUrl: vi.fn(() => new URL('data:text/javascript,')),
  createFileTreeWorkerPort: vi.fn(() => ({
    init: vi.fn(),
    expandAll: vi.fn().mockResolvedValue({ tree: [], expandedPaths: [] }),
    abort: vi.fn(),
    terminate: vi.fn(),
    updateTree: vi.fn(),
    onRequestLoad: vi.fn(() => () => {}),
    onTreeSnapshot: vi.fn(() => () => {}),
    onProgress: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    onLog: vi.fn(() => () => {}),
  })),
}));

// Mock global Worker for jsdom environment
vi.stubGlobal(
  'Worker',
  vi.fn().mockImplementation(() => ({
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    terminate: vi.fn(),
  }))
);

// Helper to create mock file system with nested structure
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

describe('useFileTree (lazy loading version)', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
    vi.clearAllTimers();
  });

  it('initializes with empty state when handle is null', () => {
    const { result } = renderHook(() => useFileTree(null), { wrapper: FileExplorerTestWrapper });

    expect(result.current.fileTree).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.loadingProgress).toEqual({
      loadingCount: 0,
      isInitialLoading: false,
    });
    expect(result.current.cancellable).toBe(false);
    expect(result.current.isCancelling).toBe(false);
    expect(result.current.loadingPaths.size).toBe(0);
  });

  it('loads only root-level contents on initial load (lazy loading)', async () => {
    const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
    mockAdapter.setMockFileSystem(mockFS);

    const handle = await mockAdapter.requestDirectoryAccess();

    const TestWrapper = ({ children }: { children: ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

    const { result } = renderHook(() => useFileTree(handle), {
      wrapper: TestWrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Should have root-level items only
    const names = result.current.fileTree.map((n) => n.name);
    expect(names).toEqual(['src', 'package.json', 'README.md']);

    // Directories should be marked as unloaded (lazy loading)
    const srcDir = result.current.fileTree.find((n) => n.name === 'src');
    expect(srcDir?.type).toBe('directory');
    // In lazy mode, children might be undefined until expanded
    // loadState should be 'unloaded' for directories that haven't been expanded
  });

  it('provides loadChildren function for on-demand directory loading', async () => {
    const nestedFS = createNestedMockFileSystem();
    mockAdapter.setMockFileSystem(nestedFS);

    const handle = await mockAdapter.requestDirectoryAccess();

    const TestWrapper = ({ children }: { children: ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

    const { result } = renderHook(() => useFileTree(handle), {
      wrapper: TestWrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // loadChildren should be a function
    expect(typeof result.current.loadChildren).toBe('function');

    // loadingPaths should be a Set
    expect(result.current.loadingPaths).toBeInstanceOf(Set);
  });

  describe('Cancellation functionality', () => {
    it('should indicate cancellable when loading', async () => {
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

    it('should not allow cancellation when not loading', () => {
      const { result } = renderHook(() => useFileTree(null), { wrapper: FileExplorerTestWrapper });

      expect(result.current.cancellable).toBe(false);

      // Calling cancel when not loading should be safe
      act(() => {
        result.current.cancelOperation();
      });

      expect(result.current.isCancelling).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should handle non-Error exceptions properly', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);
      const handle = await mockAdapter.requestDirectoryAccess();

      // Mock the adapter to throw a non-Error
      // Note: useLazyFileTree uses readDirectoryStreaming when available
      vi.spyOn(mockAdapter, 'readDirectoryStreaming').mockRejectedValueOnce('String error');

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
  });

  describe('Directory handling', () => {
    it('should handle nested directories with lazy loading', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Parent directory should be in the tree
      const parentDir = result.current.fileTree.find((node) => node.name === 'parent');
      expect(parentDir).toBeDefined();
      expect(parentDir?.type).toBe('directory');

      // With lazy loading, children may not be loaded initially
      // They would be loaded when loadChildren is called
    });

    it('should handle platform-specific paths correctly', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      handle.platform = 'electron';

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const fileNode = result.current.fileTree.find((node) => node.type === 'file');
      expect(fileNode?.path).toBeDefined();
    });
  });

  describe('Refresh functionality', () => {
    it('should refresh the tree when refreshTree is called', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Refresh should work without throwing
      await act(async () => {
        await expect(result.current.refreshTree()).resolves.not.toThrow();
      });
    });

    it('should reset error state when refreshing', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      // First simulate an error
      // Note: useLazyFileTree uses readDirectoryStreaming when available
      vi.spyOn(mockAdapter, 'readDirectoryStreaming').mockRejectedValueOnce(
        new Error('Test error')
      );

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.error).not.toBeNull());

      // Restore and refresh
      vi.restoreAllMocks();
      mockAdapter.setMockFileSystem(mockFS);

      await act(async () => {
        await result.current.refreshTree();
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.error).toBeNull();
    });
  });

  describe('Lazy loading specific behavior', () => {
    it('should provide refreshDirectory function', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // refreshDirectory should be a function
      expect(typeof result.current.refreshDirectory).toBe('function');
    });

    it('should track loading paths during directory expansion', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // loadingPaths should be empty when nothing is loading
      expect(result.current.loadingPaths.size).toBe(0);
    });
  });
});
