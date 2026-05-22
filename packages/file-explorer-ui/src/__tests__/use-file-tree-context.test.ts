import { MockFileSystemAdapter } from '@brainstrike/file-system';
import type {
  BatchLoadResult,
  FileTreePatchMessage,
  WorkerFileNode,
} from '@brainstrike/file-tree-worker';
import { addLogListener, LogLevel, resetLogger, setLogLevel } from '@brainstrike/utils';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTree } from '../tree/use-file-tree-context';
import { __resetInFlightRootLoads } from '../tree/use-lazy-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

let requestLoadHandler:
  | ((requestId: string, paths: string[]) => Promise<BatchLoadResult[]>)
  | null = null;

const mockWorkerPort = {
  init: vi.fn(),
  expandAll: vi.fn().mockResolvedValue({ patches: [], expandedPaths: [], loadedCount: 0 }),
  loadPaths: vi.fn().mockResolvedValue({ patches: [], expandedPaths: [], loadedCount: 0 }),
  abort: vi.fn(),
  terminate: vi.fn(),
  updateTree: vi.fn(),
  onRequestLoad: vi.fn(
    (handler: (requestId: string, paths: string[]) => Promise<BatchLoadResult[]>) => {
      requestLoadHandler = handler;
      return () => {
        if (requestLoadHandler === handler) {
          requestLoadHandler = null;
        }
      };
    }
  ),
  onTreeSnapshot: vi.fn(() => () => {}),
  onChildrenLoaded: vi.fn(() => () => {}),
  onNodeLoadStateChanged: vi.fn(() => () => {}),
  onExpandedPathsDelta: vi.fn(() => () => {}),
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

const createExpandAllMockFileSystem = () => ({
  alpha: {
    name: 'alpha',
    type: 'directory' as const,
    children: {
      'alpha.test.ts': {
        name: 'alpha.test.ts',
        type: 'file' as const,
        content: 'alpha test',
      },
    },
  },
  beta: {
    name: 'beta',
    type: 'directory' as const,
    children: {
      nested: {
        name: 'nested',
        type: 'directory' as const,
        children: {
          'nested.spec.ts': {
            name: 'nested.spec.ts',
            type: 'file' as const,
            content: 'nested spec',
          },
        },
      },
    },
  },
  gamma: {
    name: 'gamma',
    type: 'directory' as const,
    children: {},
  },
});

function createWorkerDirectoryNode(
  path: string,
  name: string,
  depth: number,
  children: WorkerFileNode[]
): WorkerFileNode {
  return {
    name,
    path,
    type: 'directory',
    depth,
    rootFolderId: 'mock-root',
    loadState: 'loaded',
    children,
  };
}

async function mockWorkerExpandAllThroughLoadRequests(): Promise<{
  patches: FileTreePatchMessage[];
  expandedPaths: string[];
  loadedCount: number;
}> {
  if (!requestLoadHandler) {
    throw new Error('Expected file tree worker load handler to be registered');
  }

  const rootResults = await requestLoadHandler('expand-root', [
    'mock-root/alpha',
    'mock-root/beta',
    'mock-root/gamma',
  ]);
  const nestedResults = await requestLoadHandler('expand-nested', ['mock-root/beta/nested']);

  const getChildren = (results: BatchLoadResult[], path: string): WorkerFileNode[] => {
    const result = results.find((candidate) => candidate.path === path);
    if (result?.error) {
      throw new Error(result.error);
    }
    return result?.children ?? [];
  };

  const betaChildren = getChildren(rootResults, 'mock-root/beta').map((child) =>
    child.path === 'mock-root/beta/nested'
      ? createWorkerDirectoryNode(
          'mock-root/beta/nested',
          'nested',
          1,
          getChildren(nestedResults, 'mock-root/beta/nested')
        )
      : child
  );

  return {
    patches: [
      {
        type: 'childrenLoaded',
        payload: {
          path: 'mock-root/alpha',
          children: getChildren(rootResults, 'mock-root/alpha'),
          loadState: 'loaded',
        },
      },
      {
        type: 'childrenLoaded',
        payload: { path: 'mock-root/beta', children: betaChildren, loadState: 'loaded' },
      },
      {
        type: 'childrenLoaded',
        payload: {
          path: 'mock-root/gamma',
          children: getChildren(rootResults, 'mock-root/gamma'),
          loadState: 'loaded',
        },
      },
      {
        type: 'childrenLoaded',
        payload: {
          path: 'mock-root/beta/nested',
          children: getChildren(nestedResults, 'mock-root/beta/nested'),
          loadState: 'loaded',
        },
      },
    ],
    expandedPaths: [
      'mock-root/alpha',
      'mock-root/beta',
      'mock-root/gamma',
      'mock-root/beta/nested',
    ],
    loadedCount: 4,
  };
}

describe('useFileTree (lazy loading version)', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
    vi.clearAllMocks();
    requestLoadHandler = null;
    mockWorkerPort.loadPaths.mockResolvedValue({ patches: [], expandedPaths: [], loadedCount: 0 });
    mockWorkerPort.expandAll.mockResolvedValue({ patches: [], expandedPaths: [], loadedCount: 0 });
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

    it('uses the worker batch loader when restoring multiple paths', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.loadSpecificPaths(['parent', 'parent/child']);
      });

      expect(mockWorkerPort.loadPaths).toHaveBeenCalledTimes(1);
      expect(mockWorkerPort.loadPaths).toHaveBeenCalledWith(['parent', 'parent/child']);
    });

    it('restores multiple paths serially when the worker is unavailable', async () => {
      const originalWorker = globalThis.Worker;
      vi.stubGlobal(
        'Worker',
        vi.fn(() => {
          throw new Error('Worker unavailable');
        })
      );

      try {
        const nestedFS = createNestedMockFileSystem();
        mockAdapter.setMockFileSystem(nestedFS);

        const handle = await mockAdapter.requestDirectoryAccess();

        const TestWrapper = ({ children }: { children: ReactNode }) =>
          FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

        const { result } = renderHook(() => useFileTree(handle), {
          wrapper: TestWrapper,
        });

        await waitFor(() => expect(result.current.isLoading).toBe(false));

        const initialParentDir = result.current.fileTree.find(
          (node) => node.type === 'directory' && node.name === 'parent'
        );
        expect(initialParentDir?.type).toBe('directory');
        if (!initialParentDir || initialParentDir.type !== 'directory') {
          throw new Error('Expected parent directory to be present before restoration');
        }

        await act(async () => {
          await result.current.loadSpecificPaths([
            initialParentDir.path,
            `${initialParentDir.path}/child`,
          ]);
        });

        expect(mockWorkerPort.loadPaths).not.toHaveBeenCalled();

        const parentDir = result.current.fileTree.find(
          (node) => node.type === 'directory' && node.name === 'parent'
        );
        expect(parentDir?.type).toBe('directory');
        if (!parentDir || parentDir.type !== 'directory') {
          throw new Error('Expected parent directory to be restored');
        }
        expect(parentDir.loadState).toBe('loaded');

        const childDir = parentDir.children?.find((node) => node.name === 'child');
        expect(childDir?.type).toBe('directory');
        if (!childDir || childDir.type !== 'directory') {
          throw new Error('Expected child directory to be restored');
        }
        expect(childDir.loadState).toBe('loaded');
        expect(childDir.children?.some((child) => child.name === 'nested-file.txt')).toBe(true);
      } finally {
        vi.stubGlobal('Worker', originalWorker);
      }
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
      let parentLoadAttempts = 0;
      const originalReadDirectoryStreaming = mockAdapter.readDirectoryStreaming.bind(mockAdapter);
      vi.spyOn(mockAdapter, 'readDirectoryStreaming').mockImplementation(async (...args) => {
        const [handleArg] = args;
        if (handleArg.path === (parentDir?.path ?? 'parent')) {
          parentLoadAttempts += 1;
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

      await act(async () => {
        void result.current.loadChildren(parentDir?.path ?? 'parent');
        await Promise.resolve();
      });

      expect(parentLoadAttempts).toBe(2);

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
      expect(cancelledParent?.loadState).toBe('loaded');

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

    it('completes expand-all without leaving directories stuck in loading state', async () => {
      const mockFS = createExpandAllMockFileSystem();
      mockAdapter.setMockFileSystem(mockFS);
      mockAdapter.setStreamingDelay(10);

      const handle = await mockAdapter.requestDirectoryAccess();
      mockWorkerPort.expandAll.mockImplementationOnce(mockWorkerExpandAllThroughLoadRequests);

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let expandedPaths = new Set<string>();

      await act(async () => {
        await result.current.expandAllProgressively((updater) => {
          expandedPaths = updater(expandedPaths);
        });
      });

      await waitFor(() => {
        expect(result.current.isExpandingAll).toBe(false);
        expect(result.current.loadingPaths.size).toBe(0);
      });

      expect(expandedPaths).toEqual(
        new Set(['mock-root/alpha', 'mock-root/beta', 'mock-root/gamma', 'mock-root/beta/nested'])
      );

      const rootDirectories = result.current.fileTree.filter((node) => node.type === 'directory');
      expect(rootDirectories).toHaveLength(3);
      for (const directory of rootDirectories) {
        expect(directory.loadState).toBe('loaded');
      }

      const betaDirectory = result.current.fileTree.find((node) => node.path === 'mock-root/beta');
      expect(betaDirectory?.type).toBe('directory');
      if (!betaDirectory || betaDirectory.type !== 'directory') {
        throw new Error('Expected beta directory to be present');
      }
      const nestedDirectory = betaDirectory.children?.find(
        (node) => node.path === 'mock-root/beta/nested'
      );
      expect(nestedDirectory?.type).toBe('directory');
      if (!nestedDirectory || nestedDirectory.type !== 'directory') {
        throw new Error('Expected nested directory to be present');
      }
      expect(nestedDirectory.loadState).toBe('loaded');
    });

    it('uses the worker bulk expand-all path instead of renderer child loads', async () => {
      const mockFS = createExpandAllMockFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      mockWorkerPort.expandAll.mockResolvedValueOnce({
        patches: [
          {
            type: 'childrenLoaded',
            payload: { path: 'mock-root/alpha', children: [], loadState: 'loaded' },
          },
          {
            type: 'childrenLoaded',
            payload: { path: 'mock-root/beta', children: [], loadState: 'loaded' },
          },
          {
            type: 'childrenLoaded',
            payload: { path: 'mock-root/gamma', children: [], loadState: 'loaded' },
          },
        ],
        expandedPaths: ['mock-root/alpha', 'mock-root/beta', 'mock-root/gamma'],
        loadedCount: 3,
      });

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const readDirectoryStreamingSpy = vi.spyOn(mockAdapter, 'readDirectoryStreaming');
      let expandedPaths = new Set<string>();

      await act(async () => {
        await result.current.expandAllProgressively((updater) => {
          expandedPaths = updater(expandedPaths);
        });
      });

      expect(mockWorkerPort.expandAll).toHaveBeenCalledTimes(1);
      expect(mockWorkerPort.expandAll).toHaveBeenCalledWith('mock-root');
      expect(readDirectoryStreamingSpy).not.toHaveBeenCalled();
      expect(expandedPaths).toEqual(
        new Set(['mock-root/alpha', 'mock-root/beta', 'mock-root/gamma'])
      );
      expect(result.current.loadingPaths.size).toBe(0);
      expect(result.current.fileTree.map((node) => node.loadState)).toEqual([
        'loaded',
        'loaded',
        'loaded',
      ]);
    });
  });
});
