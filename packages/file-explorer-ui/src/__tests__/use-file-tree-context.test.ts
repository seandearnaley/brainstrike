import { MockFileSystemAdapter } from '@brainstrike/file-system';
import type {
  AccumulatedFileTreePatchMessage,
  BatchLoadResult,
  WorkerFileNode,
} from '@brainstrike/file-tree-worker';
import { addLogListener, LogLevel, resetLogger, setLogLevel } from '@brainstrike/utils';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTree } from '../tree/use-file-tree-context';
import { __resetInFlightRootLoads } from '../tree/use-lazy-file-tree';
import * as normalizedFileTree from '../utils/normalized-file-tree';
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

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function mockWorkerExpandAllThroughLoadRequests(): Promise<{
  patches: AccumulatedFileTreePatchMessage[];
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

    it('reports an error when streaming root loading never emits a final batch', async () => {
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);
      const handle = await mockAdapter.requestDirectoryAccess();

      vi.spyOn(mockAdapter, 'readDirectoryStreaming').mockImplementationOnce(
        async (_directoryHandle, onBatch) => {
          onBatch([], { done: false, total: 0 });
        }
      );

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() =>
        expect(result.current.error?.message).toBe(
          `Root load completed without a final batch for ${handle.path}`
        )
      );
      expect(result.current.isLoading).toBe(false);
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

    it('ignores empty restoration requests before selecting a worker or serial loader', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      const progress = vi.fn();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.loadSpecificPaths([], progress);
      });

      expect(mockWorkerPort.loadPaths).not.toHaveBeenCalled();
      expect(progress).not.toHaveBeenCalled();
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

    it('skips blank entries during serial restoration progress', async () => {
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
        const progress = vi.fn();

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
        if (!parentDir || parentDir.type !== 'directory') {
          throw new Error('Expected parent directory to be restored');
        }

        await act(async () => {
          await result.current.loadSpecificPaths(['', parentDir.path], progress);
        });

        expect(progress).toHaveBeenNthCalledWith(1, 1, 2, parentDir.path);
        expect(progress).toHaveBeenNthCalledWith(2, 2, 2, parentDir.path);
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

    it('applies worker restoration patches on top of concurrent direct child loads', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      const loadPathsDeferred = createDeferred<{
        expandedPaths: string[];
        loadedCount: number;
        patches: AccumulatedFileTreePatchMessage[];
      }>();
      mockWorkerPort.loadPaths.mockReturnValueOnce(loadPathsDeferred.promise);

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
      if (!parentDir || parentDir.type !== 'directory') {
        throw new Error('Expected parent directory to be present before restoration');
      }

      const childPath = `${parentDir.path}/child`;
      const restorationPromise = result.current.loadSpecificPaths([parentDir.path, childPath]);
      await waitFor(() =>
        expect(mockWorkerPort.loadPaths).toHaveBeenCalledWith([parentDir.path, childPath])
      );

      await act(async () => {
        await result.current.loadChildren(parentDir.path);
      });

      const parentAfterDirectLoad = result.current.fileTree.find(
        (node) => node.path === parentDir.path
      );
      expect(parentAfterDirectLoad?.type).toBe('directory');
      if (!parentAfterDirectLoad || parentAfterDirectLoad.type !== 'directory') {
        throw new Error('Expected parent directory after direct load');
      }
      expect(parentAfterDirectLoad.children?.some((child) => child.path === childPath)).toBe(true);

      await act(async () => {
        loadPathsDeferred.resolve({
          expandedPaths: [parentDir.path, childPath],
          loadedCount: 1,
          patches: [
            {
              type: 'childrenLoaded',
              payload: {
                children: [],
                loadState: 'loaded',
                path: childPath,
              },
            },
          ],
        });
        await restorationPromise;
      });

      const parentAfterRestoration = result.current.fileTree.find(
        (node) => node.path === parentDir.path
      );
      expect(parentAfterRestoration?.type).toBe('directory');
      if (!parentAfterRestoration || parentAfterRestoration.type !== 'directory') {
        throw new Error('Expected parent directory after restoration');
      }
      const childAfterRestoration = parentAfterRestoration.children?.find(
        (node) => node.path === childPath
      );
      expect(childAfterRestoration?.type).toBe('directory');
      expect(childAfterRestoration?.loadState).toBe('loaded');
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

    it('marks a directory error when child loading fails', async () => {
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
      if (!parentDir || parentDir.type !== 'directory') {
        throw new Error('Expected parent directory before loading children');
      }

      vi.spyOn(mockAdapter, 'readDirectoryStreaming').mockRejectedValueOnce(
        new Error('Permission denied')
      );

      await act(async () => {
        await result.current.loadChildren(parentDir.path);
      });

      const erroredParent = result.current.fileTree.find((node) => node.path === parentDir.path);
      expect(erroredParent?.type).toBe('directory');
      expect(erroredParent?.loadState).toBe('error');
      expect(erroredParent?.loadError).toBe('Permission denied');
      expect(result.current.loadingPaths.has(parentDir.path)).toBe(false);
    });

    it('refreshes a loaded directory with the latest adapter children', async () => {
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
      if (!parentDir || parentDir.type !== 'directory') {
        throw new Error('Expected parent directory before refreshing children');
      }

      await act(async () => {
        await result.current.loadChildren(parentDir.path);
      });

      mockAdapter.setMockFileSystem({
        parent: {
          name: 'parent',
          type: 'directory' as const,
          children: {
            child: {
              name: 'child',
              type: 'directory' as const,
              children: {},
            },
            'fresh-file.md': {
              name: 'fresh-file.md',
              type: 'file' as const,
              content: 'new content',
            },
          },
        },
      });

      await act(async () => {
        await result.current.refreshDirectory(parentDir.path);
      });

      const refreshedParent = result.current.fileTree.find((node) => node.path === parentDir.path);
      expect(refreshedParent?.type).toBe('directory');
      if (!refreshedParent || refreshedParent.type !== 'directory') {
        throw new Error('Expected parent directory after refresh');
      }
      expect(refreshedParent.loadState).toBe('loaded');
      expect(refreshedParent.children?.map((child) => child.name)).toEqual([
        'child',
        'fresh-file.md',
      ]);
    });

    it('reports worker restoration progress and indexes rehydrated patch nodes', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      const onNodesIndexed = vi.fn();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle, { onNodesIndexed }), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const parentDir = result.current.fileTree.find(
        (node) => node.type === 'directory' && node.name === 'parent'
      );
      expect(parentDir?.type).toBe('directory');
      if (!parentDir || parentDir.type !== 'directory') {
        throw new Error('Expected parent directory before restoration');
      }

      await act(async () => {
        await result.current.loadChildren(parentDir.path);
      });

      const loadedParent = result.current.fileTree.find((node) => node.path === parentDir.path);
      expect(loadedParent?.type).toBe('directory');
      if (!loadedParent || loadedParent.type !== 'directory') {
        throw new Error('Expected loaded parent directory before worker patch');
      }
      const childDir = loadedParent.children?.find((node) => node.name === 'child');
      expect(childDir?.type).toBe('directory');
      if (!childDir || childDir.type !== 'directory') {
        throw new Error('Expected child directory handle before worker patch');
      }

      const progress = vi.fn();
      mockWorkerPort.loadPaths.mockResolvedValueOnce({
        expandedPaths: [parentDir.path],
        loadedCount: 1,
        patches: [
          {
            type: 'childrenLoaded',
            payload: {
              children: [
                {
                  depth: childDir.depth,
                  loadState: 'loaded',
                  name: childDir.name,
                  path: childDir.path,
                  rootFolderId: childDir.rootFolderId,
                  type: 'directory',
                },
              ],
              loadState: 'loaded',
              path: parentDir.path,
            },
          },
        ],
      });

      await act(async () => {
        await result.current.loadSpecificPaths([parentDir.path, childDir.path], progress);
      });

      expect(progress).toHaveBeenNthCalledWith(1, 0, 2, parentDir.path);
      expect(progress).toHaveBeenNthCalledWith(2, 2, 2, childDir.path);
      expect(onNodesIndexed).toHaveBeenCalledWith(
        [expect.objectContaining({ path: childDir.path })],
        null
      );
    });

    it('logs and ignores worker restoration patches whose handles cannot be rehydrated', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      mockWorkerPort.loadPaths.mockResolvedValueOnce({
        expandedPaths: ['missing-dir'],
        loadedCount: 1,
        patches: [
          {
            type: 'childrenLoaded',
            payload: {
              children: [
                {
                  depth: 1,
                  loadState: 'loaded',
                  name: 'missing-dir',
                  path: 'missing-dir',
                  rootFolderId: 'mock-root',
                  type: 'directory',
                },
              ],
              loadState: 'loaded',
              path: 'mock-root/parent',
            },
          },
        ],
      });

      const loggedErrors: string[] = [];
      const unsubscribe = addLogListener((record) => {
        if (record.scope === 'LazyFileTree' && typeof record.message === 'string') {
          loggedErrors.push(record.message);
        }
      });

      try {
        const TestWrapper = ({ children }: { children: ReactNode }) =>
          FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

        const { result } = renderHook(() => useFileTree(handle), {
          wrapper: TestWrapper,
        });

        await waitFor(() => expect(result.current.isLoading).toBe(false));

        await act(async () => {
          await result.current.loadSpecificPaths(['mock-root/parent', 'missing-dir']);
        });

        expect(loggedErrors).toContain('loadSpecificPaths failed');
        expect(result.current.loadingPaths.size).toBe(0);
      } finally {
        unsubscribe();
      }
    });

    it('serves descendant counts and file paths from the normalized tree cache', async () => {
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
      if (!parentDir || parentDir.type !== 'directory') {
        throw new Error('Expected parent directory before cache assertions');
      }

      await act(async () => {
        await result.current.loadSpecificPaths([parentDir.path]);
      });

      const loadedParent = result.current.fileTree.find((node) => node.path === parentDir.path);
      expect(loadedParent?.type).toBe('directory');
      if (!loadedParent || loadedParent.type !== 'directory') {
        throw new Error('Expected loaded parent directory before loading child');
      }
      const childDir = loadedParent.children?.find((node) => node.name === 'child');
      expect(childDir?.type).toBe('directory');
      if (!childDir || childDir.type !== 'directory') {
        throw new Error('Expected child directory before cache assertions');
      }

      await act(async () => {
        await result.current.loadSpecificPaths([childDir.path]);
      });

      expect(result.current.__internalGetDescendantFileCount?.(parentDir.path)).toBe(1);
      expect(result.current.__internalGetDescendantFilePaths?.(parentDir.path)).toEqual([
        `${childDir.path}/nested-file.txt`,
      ]);
      expect(result.current.__internalGetDescendantFilePaths?.(parentDir.path, 0)).toEqual([]);
      expect(result.current.__internalMaterializeSubtree?.(parentDir.path)).toEqual(
        expect.objectContaining({
          children: [expect.objectContaining({ path: childDir.path })],
          path: parentDir.path,
        })
      );
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

    it('bulk-applies worker expand-all children patches in one normalized update', async () => {
      const mockFS = createExpandAllMockFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      mockWorkerPort.expandAll.mockResolvedValueOnce({
        patches: [
          {
            type: 'childrenLoaded',
            payload: {
              path: 'mock-root/alpha',
              children: [],
              loadState: 'loaded',
            },
          },
          {
            type: 'childrenLoaded',
            payload: {
              path: 'mock-root/beta',
              children: [],
              loadState: 'loaded',
            },
          },
          {
            type: 'childrenLoaded',
            payload: { path: 'mock-root/gamma', children: [], loadState: 'loaded' },
          },
        ],
        expandedPaths: ['mock-root/alpha', 'mock-root/beta', 'mock-root/gamma'],
        loadedCount: 3,
      });
      const applyBulkSpy = vi.spyOn(normalizedFileTree, 'applyNormalizedDirectoryChildrenUpdates');

      try {
        const TestWrapper = ({ children }: { children: ReactNode }) =>
          FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

        const { result } = renderHook(() => useFileTree(handle), {
          wrapper: TestWrapper,
        });

        await waitFor(() => expect(result.current.isLoading).toBe(false));

        await act(async () => {
          await result.current.expandAllProgressively(() => new Set());
        });

        expect(applyBulkSpy).toHaveBeenCalledTimes(1);
        expect(applyBulkSpy.mock.calls[0]?.[1]).toHaveLength(3);

        expect(result.current.fileTree.map((node) => node.loadState)).toEqual([
          'loaded',
          'loaded',
          'loaded',
        ]);
      } finally {
        applyBulkSpy.mockRestore();
      }
    });

    it('applies worker load-state patches from bulk expand-all results', async () => {
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
            type: 'nodeLoadStateChanged',
            payload: {
              path: 'mock-root/beta',
              loadState: 'error',
              loadError: 'Permission denied',
            },
          },
        ],
        expandedPaths: ['mock-root/alpha'],
        loadedCount: 1,
      });

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.expandAllProgressively(() => new Set(['mock-root/alpha']));
      });

      const alphaDirectory = result.current.fileTree.find(
        (node) => node.path === 'mock-root/alpha'
      );
      expect(alphaDirectory?.type).toBe('directory');
      expect(alphaDirectory?.loadState).toBe('loaded');

      const betaDirectory = result.current.fileTree.find((node) => node.path === 'mock-root/beta');
      expect(betaDirectory?.type).toBe('directory');
      expect(betaDirectory?.loadState).toBe('error');
      expect(betaDirectory?.loadError).toBe('Permission denied');
    });
  });
});
