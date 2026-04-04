import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { addLogListener, LogLevel, resetLogger, setLogLevel } from '@brainstrike/utils';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTree } from '../use-file-tree-context';
import { __resetInFlightRootLoads } from '../use-lazy-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

const mockWorkerPort = {
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
};

// Mock the file-tree-worker to avoid Worker instantiation in tests
vi.mock('@brainstrike/file-tree-worker', () => ({
  resolveFileTreeWorkerUrl: vi.fn(() => new URL('data:text/javascript,')),
  createFileTreeWorkerPort: vi.fn(() => mockWorkerPort),
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
    vi.clearAllMocks();
    __resetInFlightRootLoads();
    resetLogger();
    setLogLevel(LogLevel.DEBUG);
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
    it('coalesces root-load startup logging and I/O under StrictMode remounts', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);
      mockAdapter.setStreamingDelay(20);

      const handle = await mockAdapter.requestDirectoryAccess();
      const readDirectoryStreamingSpy = vi.spyOn(mockAdapter, 'readDirectoryStreaming');
      const lazyFileTreeMessages: string[] = [];
      const unsubscribe = addLogListener((record) => {
        if (record.scope !== 'LazyFileTree' || typeof record.message !== 'string') {
          return;
        }

        lazyFileTreeMessages.push(record.message);
      });

      const StrictWrapper = ({ children }: { children: ReactNode }) =>
        createElement(
          StrictMode,
          null,
          createElement(FileExplorerTestWrapper, {
            children,
            mockFileSystemAdapter: mockAdapter,
          })
        );

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: StrictWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      unsubscribe();

      expect(readDirectoryStreamingSpy).toHaveBeenCalledTimes(1);
      expect(
        lazyFileTreeMessages.filter(
          (message) => message === 'loadRoot running - will reinitialize worker'
        )
      ).toHaveLength(1);
      expect(
        lazyFileTreeMessages.filter(
          (message) => message === 'loadRoot completed - handle map built'
        )
      ).toHaveLength(1);
      expect(mockWorkerPort.init).toHaveBeenCalledTimes(1);
    });

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

    it('should not block future loads when refreshTree runs without a handle', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      interface HookProps {
        handle: Parameters<typeof useFileTree>[0];
      }

      const initialProps: HookProps = { handle: null };

      const { result, rerender } = renderHook(({ handle }: HookProps) => useFileTree(handle), {
        wrapper: TestWrapper,
        initialProps,
      });

      await act(async () => {
        await result.current.refreshTree();
      });

      const handle = await mockAdapter.requestDirectoryAccess();

      act(() => {
        rerender({ handle });
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const names = result.current.fileTree.map((node) => node.name);
      expect(names).toEqual(['src', 'package.json', 'README.md']);
    });

    it('does not reload the tree when the handle object changes for the same root path', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const initialHandle = await mockAdapter.requestDirectoryAccess();
      const samePathHandle = { ...initialHandle };
      const readDirectoryStreamingSpy = vi.spyOn(mockAdapter, 'readDirectoryStreaming');

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result, rerender } = renderHook(({ handle }) => useFileTree(handle), {
        wrapper: TestWrapper,
        initialProps: { handle: initialHandle },
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(readDirectoryStreamingSpy).toHaveBeenCalledTimes(1);

      act(() => {
        rerender({ handle: samePathHandle });
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(readDirectoryStreamingSpy).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent root loads for the same path across hook instances', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      let releaseRootLoad: (() => void) | null = null;
      const rootLoadGate = new Promise<void>((resolve) => {
        releaseRootLoad = resolve;
      });

      const originalReadDirectoryStreaming = mockAdapter.readDirectoryStreaming.bind(mockAdapter);
      const readDirectoryStreamingSpy = vi
        .spyOn(mockAdapter, 'readDirectoryStreaming')
        .mockImplementation(async (...args) => {
          await rootLoadGate;
          return originalReadDirectoryStreaming(...args);
        });

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const firstHook = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });
      const secondHook = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await act(async () => {
        releaseRootLoad?.();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(firstHook.result.current.isLoading).toBe(false);
        expect(secondHook.result.current.isLoading).toBe(false);
      });

      expect(readDirectoryStreamingSpy).toHaveBeenCalledTimes(1);
      expect(firstHook.result.current.fileTree.length).toBeGreaterThan(0);
      expect(secondHook.result.current.fileTree.length).toBeGreaterThan(0);
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

    it('loads specific paths directly into the tree for restoration', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const parentDir = result.current.fileTree.find(
        (node) => node.type === 'directory' && node.name === 'parent'
      );
      expect(parentDir?.type).toBe('directory');

      await act(async () => {
        await result.current.loadSpecificPaths([parentDir?.path ?? 'parent']);
      });

      const reloadedParent = result.current.fileTree.find(
        (node) => node.type === 'directory' && node.path === parentDir?.path
      );
      expect(reloadedParent?.type).toBe('directory');
      expect(reloadedParent?.loadState).toBe('loaded');
      expect(reloadedParent?.children?.some((child) => child.name === 'child')).toBe(true);
    });

    it('deduplicates concurrent child loads between direct expansion and restoration replay', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);
      mockAdapter.setStreamingDelay(25);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const parentDir = result.current.fileTree.find(
        (node) => node.type === 'directory' && node.name === 'parent'
      );
      expect(parentDir?.type).toBe('directory');

      const originalReadDirectoryStreaming = mockAdapter.readDirectoryStreaming.bind(mockAdapter);
      const readDirectoryStreamingSpy = vi
        .spyOn(mockAdapter, 'readDirectoryStreaming')
        .mockImplementation(async (...args) => originalReadDirectoryStreaming(...args));

      await act(async () => {
        await Promise.all([
          result.current.loadChildren(parentDir?.path ?? 'parent'),
          result.current.loadSpecificPaths([parentDir?.path ?? 'parent']),
        ]);
      });

      expect(readDirectoryStreamingSpy).toHaveBeenCalledTimes(1);
    });

    it('resets a directory back to unloaded when child loading is cancelled', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const parentDir = result.current.fileTree.find(
        (node) => node.type === 'directory' && node.name === 'parent'
      );
      expect(parentDir?.type).toBe('directory');

      let releaseChildLoad: (() => void) | undefined;
      const childLoadGate = new Promise<void>((resolve) => {
        releaseChildLoad = resolve;
      });
      const originalReadDirectoryStreaming = mockAdapter.readDirectoryStreaming.bind(mockAdapter);
      vi.spyOn(mockAdapter, 'readDirectoryStreaming').mockImplementation(async (...args) => {
        const [handleArg] = args;
        if (handleArg.path === (parentDir?.path ?? 'parent')) {
          await childLoadGate;
        }
        return originalReadDirectoryStreaming(...args);
      });

      let loadPromise: Promise<void> | undefined;
      await act(async () => {
        loadPromise = result.current.loadChildren(parentDir?.path ?? 'parent');
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(result.current.loadingPaths.has(parentDir?.path ?? 'parent')).toBe(true)
      );

      act(() => {
        result.current.cancelChildLoading(parentDir?.path ?? 'parent');
      });

      if (releaseChildLoad) {
        releaseChildLoad();
      }

      await waitFor(() =>
        expect(result.current.loadingPaths.has(parentDir?.path ?? 'parent')).toBe(false)
      );

      const cancelledParent = result.current.fileTree.find(
        (node) => node.type === 'directory' && node.path === parentDir?.path
      );
      expect(cancelledParent?.type).toBe('directory');
      expect(cancelledParent?.loadState).toBe('unloaded');

      await loadPromise;
    });

    it('skips reloading already-loaded restoration paths while still reporting progress', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const parentDir = result.current.fileTree.find(
        (node) => node.type === 'directory' && node.name === 'parent'
      );
      expect(parentDir?.type).toBe('directory');

      await act(async () => {
        await result.current.loadChildren(parentDir?.path ?? 'parent');
      });

      const readDirectoryStreamingSpy = vi.spyOn(mockAdapter, 'readDirectoryStreaming');
      const progress = vi.fn();

      await act(async () => {
        await result.current.loadSpecificPaths([parentDir?.path ?? 'parent'], progress);
      });

      expect(readDirectoryStreamingSpy).not.toHaveBeenCalled();
      expect(progress).toHaveBeenNthCalledWith(1, 0, 1, parentDir?.path ?? 'parent');
      expect(progress).toHaveBeenNthCalledWith(2, 1, 1, parentDir?.path ?? 'parent');
    });
  });
});
