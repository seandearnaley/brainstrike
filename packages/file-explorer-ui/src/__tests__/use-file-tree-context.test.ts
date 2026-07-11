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
import { type FileTreeRefreshResult, useFileTree } from '../tree/use-file-tree-context';
import { __resetInFlightRootLoads } from '../tree/use-lazy-file-tree';
import * as normalizedFileTree from '../utils/normalized-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

let requestLoadHandler:
  | ((requestId: string, paths: string[]) => Promise<BatchLoadResult[]>)
  | null = null;

const mockWorkerPort = {
  abort: vi.fn(),
  expandAll: vi.fn().mockResolvedValue({ expandedPaths: [], loadedCount: 0, patches: [] }),
  init: vi.fn(),
  loadPaths: vi.fn().mockResolvedValue({ expandedPaths: [], loadedCount: 0, patches: [] }),
  onChildrenLoaded: vi.fn(() => () => {}),
  onError: vi.fn(() => () => {}),
  onExpandedPathsDelta: vi.fn(() => () => {}),
  onLog: vi.fn(() => () => {}),
  onNodeLoadStateChanged: vi.fn(() => () => {}),
  onProgress: vi.fn(() => () => {}),
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
  terminate: vi.fn(),
  updateTree: vi.fn(),
};

// Mock the file-tree-worker to avoid Worker instantiation in tests
vi.mock('@brainstrike/file-tree-worker', () => ({
  createFileTreeWorkerPort: vi.fn(() => mockWorkerPort),
  resolveFileTreeWorkerUrl: vi.fn(() => new URL('data:text/javascript,')),
}));

// Mock global Worker for jsdom environment
vi.stubGlobal(
  'Worker',
  vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn(),
    postMessage: vi.fn(),
    removeEventListener: vi.fn(),
    terminate: vi.fn(),
  }))
);

// Helper to create mock file system with nested structure
const createNestedMockFileSystem = () => ({
  parent: {
    children: {
      child: {
        children: {
          'nested-file.txt': {
            content: 'nested content',
            name: 'nested-file.txt',
            type: 'file' as const,
          },
        },
        name: 'child',
        type: 'directory' as const,
      },
    },
    name: 'parent',
    type: 'directory' as const,
  },
});

const createExpandAllMockFileSystem = () => ({
  alpha: {
    children: {
      'alpha.test.ts': {
        content: 'alpha test',
        name: 'alpha.test.ts',
        type: 'file' as const,
      },
    },
    name: 'alpha',
    type: 'directory' as const,
  },
  beta: {
    children: {
      nested: {
        children: {
          'nested.spec.ts': {
            content: 'nested spec',
            name: 'nested.spec.ts',
            type: 'file' as const,
          },
        },
        name: 'nested',
        type: 'directory' as const,
      },
    },
    name: 'beta',
    type: 'directory' as const,
  },
  gamma: {
    children: {},
    name: 'gamma',
    type: 'directory' as const,
  },
});

function createWorkerDirectoryNode(
  path: string,
  name: string,
  depth: number,
  children: WorkerFileNode[]
): WorkerFileNode {
  return {
    children,
    depth,
    loadState: 'loaded',
    name,
    path,
    rootFolderId: 'mock-root',
    type: 'directory',
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
    expandedPaths: [
      'mock-root/alpha',
      'mock-root/beta',
      'mock-root/gamma',
      'mock-root/beta/nested',
    ],
    loadedCount: 4,
    patches: [
      {
        payload: {
          children: getChildren(rootResults, 'mock-root/alpha'),
          loadState: 'loaded',
          path: 'mock-root/alpha',
        },
        type: 'childrenLoaded',
      },
      {
        payload: { children: betaChildren, loadState: 'loaded', path: 'mock-root/beta' },
        type: 'childrenLoaded',
      },
      {
        payload: {
          children: getChildren(rootResults, 'mock-root/gamma'),
          loadState: 'loaded',
          path: 'mock-root/gamma',
        },
        type: 'childrenLoaded',
      },
      {
        payload: {
          children: getChildren(nestedResults, 'mock-root/beta/nested'),
          loadState: 'loaded',
          path: 'mock-root/beta/nested',
        },
        type: 'childrenLoaded',
      },
    ],
  };
}

describe('useFileTree (lazy loading version)', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
    vi.clearAllMocks();
    requestLoadHandler = null;
    mockWorkerPort.loadPaths.mockResolvedValue({ expandedPaths: [], loadedCount: 0, patches: [] });
    mockWorkerPort.expandAll.mockResolvedValue({ expandedPaths: [], loadedCount: 0, patches: [] });
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
      isInitialLoading: false,
      loadingCount: 0,
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

    it('passes a signal to root streaming and ignores a terminal batch after cancellation', async () => {
      mockAdapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
      const handle = await mockAdapter.requestDirectoryAccess();
      const terminalNodes = await mockAdapter.readDirectory(handle);
      let releaseRootLoad: (() => void) | null = null;
      let rootSignal: AbortSignal | undefined;

      const readDirectoryStreamingSpy = vi
        .spyOn(mockAdapter, 'readDirectoryStreaming')
        .mockImplementation(async (_handle, onBatch, options) => {
          rootSignal = options?.signal;
          await new Promise<void>((resolve) => {
            releaseRootLoad = () => {
              onBatch(terminalNodes, { done: true, total: terminalNodes.length });
              resolve();
            };
          });
        });

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const { result } = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });

      await waitFor(() => {
        expect(readDirectoryStreamingSpy).toHaveBeenCalledOnce();
        expect(result.current.isLoading).toBe(true);
      });

      act(() => {
        result.current.cancelOperation();
      });
      const wasLoadingAfterCancel = result.current.isLoading;

      await act(async () => {
        releaseRootLoad?.();
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(rootSignal).toBeInstanceOf(AbortSignal);
      expect(rootSignal?.aborted).toBe(true);
      expect(wasLoadingAfterCancel).toBe(false);
      expect(result.current.fileTree).toEqual([]);
      expect(mockWorkerPort.init).not.toHaveBeenCalled();
    });

    it('preserves the committed root snapshot when a same-root refresh is cancelled', async () => {
      mockAdapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
      const handle = await mockAdapter.requestDirectoryAccess();
      const rootId = 'committed-root-id';

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const { result } = renderHook(() => useFileTree(handle, { rootId }), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      const committedTree = result.current.fileTree;
      const committedRootPaths = result.current.__internalNormalizedTreeRef?.current.rootPaths;
      const committedDirectoryPath = committedTree.find((node) => node.type === 'directory')?.path;
      const committedWorkerInitCount = mockWorkerPort.init.mock.calls.length;
      expect(committedDirectoryPath).toBeDefined();

      let releaseRefresh: (() => void) | null = null;
      let refreshSignal: AbortSignal | undefined;
      const readDirectoryStreamingSpy = vi
        .spyOn(mockAdapter, 'readDirectoryStreaming')
        .mockImplementation(async (_handle, onBatch, options) => {
          refreshSignal = options?.signal;
          await new Promise<void>((resolve) => {
            releaseRefresh = () => {
              onBatch(committedTree, { done: true, total: committedTree.length });
              resolve();
            };
          });
        });

      let refreshPromise: Promise<FileTreeRefreshResult> = Promise.resolve({
        status: 'completed',
      });
      act(() => {
        refreshPromise = result.current.refreshTree();
      });
      await waitFor(() => {
        expect(readDirectoryStreamingSpy).toHaveBeenCalledOnce();
        expect(result.current.isLoading).toBe(true);
      });
      act(() => {
        result.current.cancelOperation();
      });
      const refreshIoPromise = readDirectoryStreamingSpy.mock.results[0]?.value;
      let refreshOutcome: FileTreeRefreshResult = { status: 'completed' };
      await act(async () => {
        releaseRefresh?.();
        refreshOutcome = await refreshPromise;
        await refreshIoPromise;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(refreshSignal?.aborted).toBe(true);
      expect(refreshOutcome).toEqual({ status: 'cancelled' });
      expect(result.current.fileTree).toEqual(committedTree);
      expect(result.current.__internalNormalizedTreeRef?.current.rootPaths).toEqual(
        committedRootPaths
      );
      expect(
        result.current.__internalMaterializeSubtree?.(committedDirectoryPath ?? '')
      ).toBeDefined();
      expect(mockWorkerPort.init).toHaveBeenCalledTimes(committedWorkerInitCount);
      expect(mockWorkerPort.init).toHaveBeenLastCalledWith(expect.any(Array), rootId);

      if (!(requestLoadHandler && committedDirectoryPath)) {
        throw new Error('Expected worker request handler and committed root directory path');
      }
      await expect(requestLoadHandler('committed-root', [committedDirectoryPath])).resolves.toEqual(
        [expect.objectContaining({ children: expect.any(Array), path: committedDirectoryPath })]
      );
    });

    it('keeps a pending same-root refresh authoritative when active expand-all is cancelled', async () => {
      mockAdapter.setMockFileSystem(createExpandAllMockFileSystem());
      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const { result } = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      const sourceDirectory = result.current.fileTree.find((node) => node.type === 'directory');
      if (!sourceDirectory) {
        throw new Error('Expected a committed directory before overlapping operations');
      }

      const refreshedDirectoryPath = `${handle.path}/refresh-only`;
      const refreshedTree = [
        {
          ...sourceDirectory,
          name: 'refresh-only',
          path: refreshedDirectoryPath,
        },
      ];
      const expandAllDeferred = createDeferred<{
        expandedPaths: string[];
        loadedCount: number;
        patches: AccumulatedFileTreePatchMessage[];
      }>();
      mockWorkerPort.expandAll.mockReturnValueOnce(expandAllDeferred.promise);

      let releaseRefresh: (() => void) | null = null;
      let refreshSignal: AbortSignal | undefined;
      const readDirectoryStreamingSpy = vi
        .spyOn(mockAdapter, 'readDirectoryStreaming')
        .mockImplementation(async (_handle, onBatch, options) => {
          refreshSignal = options?.signal;
          await new Promise<void>((resolve) => {
            releaseRefresh = () => {
              onBatch(refreshedTree, { done: true, total: refreshedTree.length });
              resolve();
            };
          });
        });

      let expandedPaths = new Set<string>();
      let expandPromise = Promise.resolve();
      act(() => {
        expandPromise = result.current.expandAllProgressively((updater) => {
          expandedPaths = updater(expandedPaths);
        });
      });
      await waitFor(() => expect(result.current.isExpandingAll).toBe(true));

      let refreshSettled = false;
      let refreshPromise: Promise<FileTreeRefreshResult> = Promise.resolve({
        status: 'cancelled',
      });
      act(() => {
        refreshPromise = result.current.refreshTree();
        void refreshPromise.then(() => {
          refreshSettled = true;
        });
      });
      await waitFor(() => {
        expect(readDirectoryStreamingSpy).toHaveBeenCalledOnce();
        expect(result.current.isLoading).toBe(true);
      });

      act(() => {
        result.current.cancelExpandAll();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const rootWasAbortedByExpandCancel = refreshSignal?.aborted;
      const refreshWasPendingAfterExpandCancel = !refreshSettled;
      const refreshWasLoadingAfterExpandCancel = result.current.isLoading;

      const refreshIoPromise = readDirectoryStreamingSpy.mock.results[0]?.value;
      let refreshOutcome: FileTreeRefreshResult = { status: 'cancelled' };
      await act(async () => {
        releaseRefresh?.();
        await refreshIoPromise;
        refreshOutcome = await refreshPromise;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      const committedTreeAfterRefresh = result.current.fileTree;
      expandAllDeferred.reject(new Error('Operation aborted after refresh committed'));
      await act(async () => {
        await expandPromise;
      });

      expect(rootWasAbortedByExpandCancel).toBe(false);
      expect(refreshOutcome).toEqual({ status: 'completed' });
      expect(refreshWasPendingAfterExpandCancel).toBe(true);
      expect(refreshWasLoadingAfterExpandCancel).toBe(true);
      expect(mockWorkerPort.abort).toHaveBeenCalled();
      expect(result.current.isExpandingAll).toBe(false);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.fileTree).toEqual(refreshedTree);
      expect(result.current.fileTree).toEqual(committedTreeAfterRefresh);
      expect(result.current.__internalNormalizedTreeRef?.current.rootPaths).toEqual([
        refreshedDirectoryPath,
      ]);
      expect(result.current.__internalMaterializeSubtree?.(refreshedDirectoryPath)).toBeDefined();
      expect(mockWorkerPort.init).toHaveBeenLastCalledWith(expect.any(Array), handle.path);

      if (!requestLoadHandler) {
        throw new Error('Expected worker request handler after refreshed root commit');
      }
      await expect(requestLoadHandler('refreshed-root', [refreshedDirectoryPath])).resolves.toEqual(
        [expect.objectContaining({ children: expect.any(Array), path: refreshedDirectoryPath })]
      );
    });

    it.each([
      'cancelRecursiveSelect',
      'cancelSelectAll',
    ] as const)('keeps a pending root refresh authoritative when %s runs', async (cancelMethod) => {
      mockAdapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const { result } = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      const sourceFile = result.current.fileTree.find((node) => node.type === 'file');
      if (!sourceFile) {
        throw new Error('Expected a committed file before recursive cancellation');
      }
      const refreshedPath = `${handle.path}/${cancelMethod}-refresh.ts`;
      const refreshedTree = [
        ...result.current.fileTree,
        { ...sourceFile, name: `${cancelMethod}-refresh.ts`, path: refreshedPath },
      ];

      let releaseRefresh: (() => void) | null = null;
      let refreshSignal: AbortSignal | undefined;
      const readDirectoryStreamingSpy = vi
        .spyOn(mockAdapter, 'readDirectoryStreaming')
        .mockImplementation(async (_handle, onBatch, options) => {
          refreshSignal = options?.signal;
          await new Promise<void>((resolve) => {
            releaseRefresh = () => {
              onBatch(refreshedTree, { done: true, total: refreshedTree.length });
              resolve();
            };
          });
        });

      let refreshSettled = false;
      let refreshPromise: Promise<FileTreeRefreshResult> = Promise.resolve({
        status: 'cancelled',
      });
      act(() => {
        refreshPromise = result.current.refreshTree();
        void refreshPromise.then(() => {
          refreshSettled = true;
        });
      });
      await waitFor(() => {
        expect(readDirectoryStreamingSpy).toHaveBeenCalledOnce();
        expect(result.current.isLoading).toBe(true);
      });

      act(() => {
        result.current[cancelMethod]();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const rootWasAbortedByRecursiveCancel = refreshSignal?.aborted;
      const refreshWasPendingAfterRecursiveCancel = !refreshSettled;

      const refreshIoPromise = readDirectoryStreamingSpy.mock.results[0]?.value;
      let refreshOutcome: FileTreeRefreshResult = { status: 'cancelled' };
      await act(async () => {
        releaseRefresh?.();
        await refreshIoPromise;
        refreshOutcome = await refreshPromise;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      expect(rootWasAbortedByRecursiveCancel).toBe(false);
      expect(refreshOutcome).toEqual({ status: 'completed' });
      expect(refreshWasPendingAfterRecursiveCancel).toBe(true);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.fileTree).toHaveLength(refreshedTree.length);
      expect(result.current.fileTree).toEqual(expect.arrayContaining(refreshedTree));
      expect(result.current.__internalNormalizedTreeRef?.current.rootPaths).toContain(
        refreshedPath
      );
      expect(mockWorkerPort.init).toHaveBeenLastCalledWith(expect.any(Array), handle.path);
    });

    it.each([
      { changePath: true, changeRootId: false, switchKind: 'path-only' },
      { changePath: false, changeRootId: true, switchKind: 'rootId-only' },
    ])('atomically clears committed root state when a $switchKind switch is cancelled', async ({
      changePath,
      changeRootId,
    }) => {
      mockAdapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
      const firstHandle = await mockAdapter.requestDirectoryAccess();
      const secondHandle = changePath
        ? { ...firstHandle, name: 'next-root', path: 'next-root' }
        : { ...firstHandle };
      const firstRootId = 'first-root-id';
      const secondRootId = changeRootId ? 'second-root-id' : firstRootId;

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const { result, rerender } = renderHook(
        ({ handle, rootId }) => useFileTree(handle, { rootId }),
        {
          initialProps: { handle: firstHandle, rootId: firstRootId },
          wrapper: TestWrapper,
        }
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      const staleDirectoryPath = result.current.fileTree.find(
        (node) => node.type === 'directory'
      )?.path;
      expect(staleDirectoryPath).toBeDefined();
      expect(result.current.__internalNormalizedTreeRef?.current.rootPaths).not.toEqual([]);
      expect(mockWorkerPort.init).toHaveBeenLastCalledWith(expect.any(Array), firstRootId);

      const lateChildren = result.current.fileTree.map((node) => ({
        ...node,
        path: node.path.replace(firstHandle.path, secondHandle.path),
        rootFolderId: secondRootId,
      }));
      let releaseRootSwitch: (() => void) | null = null;
      let rootSwitchSignal: AbortSignal | undefined;
      const readDirectoryStreamingSpy = vi
        .spyOn(mockAdapter, 'readDirectoryStreaming')
        .mockImplementation(async (_handle, onBatch, options) => {
          rootSwitchSignal = options?.signal;
          await new Promise<void>((resolve) => {
            releaseRootSwitch = () => {
              onBatch(lateChildren, { done: true, total: lateChildren.length });
              resolve();
            };
          });
        });

      act(() => {
        rerender({ handle: secondHandle, rootId: secondRootId });
      });
      await waitFor(() => {
        expect(readDirectoryStreamingSpy).toHaveBeenCalledOnce();
        expect(result.current.isLoading).toBe(true);
      });
      expect(readDirectoryStreamingSpy.mock.calls[0]?.[0]).toMatchObject({
        path: secondHandle.path,
      });

      act(() => {
        result.current.cancelOperation();
      });
      const rootSwitchIoPromise = readDirectoryStreamingSpy.mock.results[0]?.value;
      await act(async () => {
        releaseRootSwitch?.();
        await rootSwitchIoPromise;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(rootSwitchSignal?.aborted).toBe(true);
      expect(result.current.fileTree).toEqual([]);
      expect(result.current.__internalNormalizedTreeRef?.current.rootPaths).toEqual([]);
      expect(result.current.__internalNormalizedTreeRef?.current.nodeByPath.size).toBe(0);
      expect(
        result.current.__internalMaterializeSubtree?.(staleDirectoryPath ?? '')
      ).toBeUndefined();
      expect(mockWorkerPort.init).toHaveBeenLastCalledWith([], secondRootId);

      if (!(requestLoadHandler && staleDirectoryPath)) {
        throw new Error('Expected worker request handler and prior root directory path');
      }
      await expect(requestLoadHandler('stale-root', [staleDirectoryPath])).resolves.toEqual([
        { error: 'Handle not found', path: staleDirectoryPath },
      ]);

      readDirectoryStreamingSpy.mockImplementation(async (_handle, onBatch) => {
        onBatch(lateChildren, { done: true, total: lateChildren.length });
      });
      await act(async () => {
        await expect(result.current.refreshTree()).resolves.toEqual({ status: 'completed' });
      });

      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.fileTree).toEqual(lateChildren);
      expect(result.current.__internalNormalizedTreeRef?.current.rootPaths).toEqual(
        lateChildren.map((node) => node.path)
      );
      expect(mockWorkerPort.init).toHaveBeenLastCalledWith(expect.any(Array), secondRootId);
    });

    it('settles an atomic root switch and permits retry when worker reset throws', async () => {
      mockAdapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
      const firstHandle = await mockAdapter.requestDirectoryAccess();
      const secondHandle = { ...firstHandle, name: 'next-root', path: 'next-root' };
      const firstRootId = 'first-root-id';
      const secondRootId = 'second-root-id';

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const { result, rerender } = renderHook(
        ({ handle, rootId }) => useFileTree(handle, { rootId }),
        {
          initialProps: { handle: firstHandle, rootId: firstRootId },
          wrapper: TestWrapper,
        }
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      const staleDirectoryPath = result.current.fileTree.find(
        (node) => node.type === 'directory'
      )?.path;
      if (!staleDirectoryPath) {
        throw new Error('Expected a committed directory before switching roots');
      }
      const nextChildren = result.current.fileTree.map((node) => ({
        ...node,
        path: node.path.replace(firstHandle.path, secondHandle.path),
        rootFolderId: secondRootId,
      }));
      const readDirectoryStreamingSpy = vi
        .spyOn(mockAdapter, 'readDirectoryStreaming')
        .mockImplementation(async (_handle, onBatch) => {
          onBatch(nextChildren, { done: true, total: nextChildren.length });
        });
      const workerResetError = new Error('worker reset failed');
      mockWorkerPort.init.mockImplementationOnce(() => {
        throw workerResetError;
      });

      act(() => {
        rerender({ handle: secondHandle, rootId: secondRootId });
      });

      await waitFor(() => expect(result.current.error).toBe(workerResetError));
      expect(result.current.isLoading).toBe(false);
      expect(result.current.fileTree).toEqual([]);
      expect(result.current.__internalNormalizedTreeRef?.current.rootPaths).toEqual([]);
      expect(result.current.__internalNormalizedTreeRef?.current.nodeByPath.size).toBe(0);
      expect(result.current.__internalMaterializeSubtree?.(staleDirectoryPath)).toBeUndefined();
      expect(readDirectoryStreamingSpy).not.toHaveBeenCalled();

      if (!requestLoadHandler) {
        throw new Error('Expected worker request handler after failed root reset');
      }
      await expect(requestLoadHandler('failed-root-reset', [staleDirectoryPath])).resolves.toEqual([
        { error: 'Handle not found', path: staleDirectoryPath },
      ]);

      let retryOutcome: FileTreeRefreshResult = { status: 'cancelled' };
      await act(async () => {
        retryOutcome = await result.current.refreshTree();
      });

      expect(retryOutcome).toEqual({ status: 'completed' });
      expect(readDirectoryStreamingSpy).toHaveBeenCalledOnce();
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.fileTree).toEqual(nextChildren);
      expect(result.current.__internalNormalizedTreeRef?.current.rootPaths).toEqual(
        nextChildren.map((node) => node.path)
      );
      expect(mockWorkerPort.init).toHaveBeenLastCalledWith(expect.any(Array), secondRootId);
    });
  });

  describe('Error handling', () => {
    it('rejects a manual refresh with the exact adapter error', async () => {
      mockAdapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const refreshError = new Error('manual refresh failed');
      vi.spyOn(mockAdapter, 'readDirectoryStreaming').mockRejectedValueOnce(refreshError);

      await act(async () => {
        await expect(result.current.refreshTree()).rejects.toBe(refreshError);
      });

      expect(result.current.error).toBe(refreshError);
      expect(result.current.isLoading).toBe(false);
    });

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

    it('preserves a committed refresh snapshot and permits retry when worker init throws', async () => {
      mockAdapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
      const handle = await mockAdapter.requestDirectoryAccess();
      const rootId = 'committed-root-id';

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const { result } = renderHook(() => useFileTree(handle, { rootId }), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      const committedTree = result.current.fileTree;
      const committedRootPaths = result.current.__internalNormalizedTreeRef?.current.rootPaths;
      const committedDirectoryPath = committedTree.find((node) => node.type === 'directory')?.path;
      const sourceFile = committedTree.find((node) => node.type === 'file');
      if (!(committedDirectoryPath && sourceFile)) {
        throw new Error('Expected committed directory and file nodes before refresh');
      }
      const refreshedPath = `${handle.path}/refreshed-only.ts`;
      const refreshedTree = [
        {
          ...sourceFile,
          name: 'refreshed-only.ts',
          path: refreshedPath,
        },
      ];
      vi.spyOn(mockAdapter, 'readDirectoryStreaming').mockImplementation(
        async (_handle, onBatch) => {
          onBatch(refreshedTree, { done: true, total: refreshedTree.length });
        }
      );
      const workerInitError = new Error('worker init failed');
      mockWorkerPort.init.mockImplementationOnce(() => {
        throw workerInitError;
      });

      await act(async () => {
        await expect(result.current.refreshTree()).rejects.toBe(workerInitError);
      });

      expect(result.current.error).toBe(workerInitError);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.fileTree).toEqual(committedTree);
      expect(result.current.__internalNormalizedTreeRef?.current.rootPaths).toEqual(
        committedRootPaths
      );
      expect(result.current.__internalMaterializeSubtree?.(committedDirectoryPath)).toBeDefined();

      if (!requestLoadHandler) {
        throw new Error('Expected worker request handler after failed refresh commit');
      }
      await expect(requestLoadHandler('failed-refresh', [committedDirectoryPath])).resolves.toEqual(
        [expect.objectContaining({ children: expect.any(Array), path: committedDirectoryPath })]
      );

      let retryOutcome: FileTreeRefreshResult = { status: 'cancelled' };
      await act(async () => {
        retryOutcome = await result.current.refreshTree();
      });

      expect(retryOutcome).toEqual({ status: 'completed' });
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.fileTree).toEqual(refreshedTree);
      expect(result.current.__internalNormalizedTreeRef?.current.rootPaths).toEqual([
        refreshedPath,
      ]);
      expect(result.current.__internalMaterializeSubtree?.(committedDirectoryPath)).toBeUndefined();
      expect(mockWorkerPort.init).toHaveBeenLastCalledWith(expect.any(Array), rootId);
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

      await act(async () => {
        await expect(result.current.refreshTree()).resolves.toEqual({ status: 'completed' });
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
        initialProps,
        wrapper: TestWrapper,
      });

      await act(async () => {
        await expect(result.current.refreshTree()).resolves.toEqual({ status: 'cancelled' });
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
        initialProps: { handle: initialHandle },
        wrapper: TestWrapper,
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

    it('keeps a shared root request alive until its last consumer cancels', async () => {
      mockAdapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
      const handle = await mockAdapter.requestDirectoryAccess();
      const terminalNodes = await mockAdapter.readDirectory(handle);
      let releaseRootLoad: (() => void) | null = null;
      let rootSignal: AbortSignal | undefined;

      const readDirectoryStreamingSpy = vi
        .spyOn(mockAdapter, 'readDirectoryStreaming')
        .mockImplementation(async (_handle, onBatch, options) => {
          rootSignal = options?.signal;
          await new Promise<void>((resolve) => {
            releaseRootLoad = () => {
              onBatch(terminalNodes, { done: true, total: terminalNodes.length });
              resolve();
            };
          });
        });

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const firstHook = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });
      const secondHook = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });

      await waitFor(() => {
        expect(readDirectoryStreamingSpy).toHaveBeenCalledOnce();
        expect(firstHook.result.current.isLoading).toBe(true);
        expect(secondHook.result.current.isLoading).toBe(true);
      });

      act(() => {
        firstHook.result.current.cancelOperation();
      });
      const wasUnderlyingAbortedAfterFirstCancel = rootSignal?.aborted;
      const wasFirstConsumerLoadingAfterCancel = firstHook.result.current.isLoading;
      const wasSecondConsumerLoadingAfterFirstCancel = secondHook.result.current.isLoading;

      act(() => {
        secondHook.result.current.cancelOperation();
      });
      const wasUnderlyingAbortedAfterLastCancel = rootSignal?.aborted;

      await act(async () => {
        releaseRootLoad?.();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(firstHook.result.current.isLoading).toBe(false);
        expect(secondHook.result.current.isLoading).toBe(false);
      });

      expect(rootSignal).toBeInstanceOf(AbortSignal);
      expect(wasUnderlyingAbortedAfterFirstCancel).toBe(false);
      expect(wasUnderlyingAbortedAfterLastCancel).toBe(true);
      expect(wasFirstConsumerLoadingAfterCancel).toBe(false);
      expect(wasSecondConsumerLoadingAfterFirstCancel).toBe(true);
      expect(firstHook.result.current.fileTree).toEqual([]);
      expect(secondHook.result.current.fileTree).toEqual([]);
    });

    it('lets a joined refresh commit after the starter cancels without clearing either snapshot', async () => {
      mockAdapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
      const handle = await mockAdapter.requestDirectoryAccess();

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const starterHook = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });
      const joinerHook = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });

      await waitFor(() => {
        expect(starterHook.result.current.isLoading).toBe(false);
        expect(joinerHook.result.current.isLoading).toBe(false);
      });
      const starterSnapshot = starterHook.result.current.fileTree;
      const joinerSnapshot = joinerHook.result.current.fileTree;
      const sourceNode = joinerSnapshot.find((node) => node.type === 'file');
      if (!sourceNode) {
        throw new Error('Expected a committed file node for the joined refresh');
      }
      const refreshedPath = `${handle.path}/refreshed-file.ts`;
      const refreshedTree = [
        ...joinerSnapshot,
        {
          ...sourceNode,
          name: 'refreshed-file.ts',
          path: refreshedPath,
        },
      ];
      let releaseSharedRefresh: (() => void) | null = null;
      let sharedRefreshSignal: AbortSignal | undefined;
      const readDirectoryStreamingSpy = vi
        .spyOn(mockAdapter, 'readDirectoryStreaming')
        .mockImplementation(async (_handle, onBatch, options) => {
          sharedRefreshSignal = options?.signal;
          await new Promise<void>((resolve) => {
            releaseSharedRefresh = () => {
              onBatch(refreshedTree, { done: true, total: refreshedTree.length });
              resolve();
            };
          });
        });

      let starterRefreshPromise: Promise<FileTreeRefreshResult> = Promise.resolve({
        status: 'completed',
      });
      let joinerRefreshPromise: Promise<FileTreeRefreshResult> = Promise.resolve({
        status: 'completed',
      });
      act(() => {
        starterRefreshPromise = starterHook.result.current.refreshTree();
        joinerRefreshPromise = joinerHook.result.current.refreshTree();
      });
      await waitFor(() => {
        expect(readDirectoryStreamingSpy).toHaveBeenCalledOnce();
        expect(starterHook.result.current.isLoading).toBe(true);
        expect(joinerHook.result.current.isLoading).toBe(true);
      });

      act(() => {
        starterHook.result.current.cancelOperation();
      });

      expect(sharedRefreshSignal?.aborted).toBe(false);
      expect(starterHook.result.current.isLoading).toBe(false);
      expect(joinerHook.result.current.isLoading).toBe(true);
      expect(starterHook.result.current.fileTree).toEqual(starterSnapshot);
      expect(joinerHook.result.current.fileTree).toEqual(joinerSnapshot);

      const sharedRefreshIoPromise = readDirectoryStreamingSpy.mock.results[0]?.value;
      let starterOutcome: FileTreeRefreshResult = { status: 'completed' };
      let joinerOutcome: FileTreeRefreshResult = { status: 'cancelled' };
      await act(async () => {
        releaseSharedRefresh?.();
        await sharedRefreshIoPromise;
        [starterOutcome, joinerOutcome] = await Promise.all([
          starterRefreshPromise,
          joinerRefreshPromise,
        ]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      expect(sharedRefreshSignal?.aborted).toBe(false);
      expect(starterOutcome).toEqual({ status: 'cancelled' });
      expect(joinerOutcome).toEqual({ status: 'completed' });
      expect(starterHook.result.current.fileTree).toEqual(starterSnapshot);
      expect(joinerHook.result.current.fileTree).toEqual(refreshedTree);
      expect(starterHook.result.current.isLoading).toBe(false);
      expect(joinerHook.result.current.isLoading).toBe(false);
    });

    it('does NOT share a root load between loaders with different rootId (no rootFolderId contamination)', async () => {
      // The forest focused-root bug: the section loader (rootId = UUID) and the
      // legacy panel loader (no rootId → path-stamped) load the SAME path. The
      // in-flight dedup must NOT let them share — otherwise whichever registers
      // first stamps the other's nodes, and directory recursive-select keys
      // composite selections by the wrong identity (checkboxes vanish).
      const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
      mockAdapter.setMockFileSystem(mockFS);
      const handle = await mockAdapter.requestDirectoryAccess();
      const ROOT_UUID = 'd4e516c5-e91e-4b1d-89ed-cb01cbfec159';

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      // Panel loader (no rootId) mounts first and registers the in-flight load.
      const panelHook = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });
      // Section loader (rootId = UUID) mounts concurrently for the same path.
      const sectionHook = renderHook(() => useFileTree(handle, { rootId: ROOT_UUID }), {
        wrapper: TestWrapper,
      });

      await waitFor(() => {
        expect(panelHook.result.current.isLoading).toBe(false);
        expect(sectionHook.result.current.isLoading).toBe(false);
      });

      // Each loader stamps its OWN identity onto its nodes.
      const panelRoot = panelHook.result.current.fileTree[0];
      const sectionRoot = sectionHook.result.current.fileTree[0];
      expect(panelRoot?.rootFolderId).toBe(handle.path);
      expect(sectionRoot?.rootFolderId).toBe(ROOT_UUID);
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

    it('loads root and child directories through non-streaming adapters', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      const readDirectorySpy = vi.spyOn(mockAdapter, 'readDirectory');
      const nonStreamingAdapter = {
        readDirectory: mockAdapter.readDirectory.bind(mockAdapter),
      } as unknown as MockFileSystemAdapter;

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: nonStreamingAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const parentDir = result.current.fileTree.find(
        (node) => node.type === 'directory' && node.name === 'parent'
      );
      expect(parentDir?.type).toBe('directory');
      if (parentDir?.type !== 'directory') {
        throw new Error('Expected parent directory before non-streaming child load');
      }

      await act(async () => {
        await result.current.loadChildren(parentDir.path);
      });

      expect(readDirectorySpy).toHaveBeenCalledTimes(2);

      const reloadedParent = result.current.fileTree.find((node) => node.path === parentDir.path);
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

    it('skips restoration requests while expand-all is in progress', async () => {
      const mockFS = createExpandAllMockFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      const expandAllDeferred = createDeferred<{
        expandedPaths: string[];
        loadedCount: number;
        patches: AccumulatedFileTreePatchMessage[];
      }>();
      mockWorkerPort.expandAll.mockReturnValueOnce(expandAllDeferred.promise);

      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

      const { result } = renderHook(() => useFileTree(handle), {
        wrapper: TestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let expandedPaths = new Set<string>();
      const expandPromise = result.current.expandAllProgressively((updater) => {
        expandedPaths = updater(expandedPaths);
      });

      await waitFor(() => expect(result.current.isExpandingAll).toBe(true));

      const progress = vi.fn();
      await act(async () => {
        await result.current.loadSpecificPaths(['mock-root/alpha', 'mock-root/beta'], progress);
      });

      expect(mockWorkerPort.loadPaths).not.toHaveBeenCalled();
      expect(progress).not.toHaveBeenCalled();

      await act(async () => {
        expandAllDeferred.resolve({
          expandedPaths: ['mock-root/alpha'],
          loadedCount: 1,
          patches: [
            {
              payload: { children: [], loadState: 'loaded', path: 'mock-root/alpha' },
              type: 'childrenLoaded',
            },
          ],
        });
        await expandPromise;
      });

      expect(expandedPaths).toEqual(
        new Set(['mock-root/alpha', 'mock-root/beta', 'mock-root/gamma'])
      );
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
        if (initialParentDir?.type !== 'directory') {
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
        if (parentDir?.type !== 'directory') {
          throw new Error('Expected parent directory to be restored');
        }
        expect(parentDir.loadState).toBe('loaded');

        const childDir = parentDir.children?.find((node) => node.name === 'child');
        expect(childDir?.type).toBe('directory');
        if (childDir?.type !== 'directory') {
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
        if (parentDir?.type !== 'directory') {
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
      if (parentDir?.type !== 'directory') {
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
      if (parentAfterDirectLoad?.type !== 'directory') {
        throw new Error('Expected parent directory after direct load');
      }
      expect(parentAfterDirectLoad.children?.some((child) => child.path === childPath)).toBe(true);

      await act(async () => {
        loadPathsDeferred.resolve({
          expandedPaths: [parentDir.path, childPath],
          loadedCount: 1,
          patches: [
            {
              payload: {
                children: [],
                loadState: 'loaded',
                path: childPath,
              },
              type: 'childrenLoaded',
            },
          ],
        });
        await restorationPromise;
      });

      const parentAfterRestoration = result.current.fileTree.find(
        (node) => node.path === parentDir.path
      );
      expect(parentAfterRestoration?.type).toBe('directory');
      if (parentAfterRestoration?.type !== 'directory') {
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
      if (parentDir?.type !== 'directory') {
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
      if (parentDir?.type !== 'directory') {
        throw new Error('Expected parent directory before refreshing children');
      }

      await act(async () => {
        await result.current.loadChildren(parentDir.path);
      });

      mockAdapter.setMockFileSystem({
        parent: {
          children: {
            child: {
              children: {},
              name: 'child',
              type: 'directory' as const,
            },
            'fresh-file.md': {
              content: 'new content',
              name: 'fresh-file.md',
              type: 'file' as const,
            },
          },
          name: 'parent',
          type: 'directory' as const,
        },
      });

      await act(async () => {
        await result.current.refreshDirectory(parentDir.path);
      });

      const refreshedParent = result.current.fileTree.find((node) => node.path === parentDir.path);
      expect(refreshedParent?.type).toBe('directory');
      if (refreshedParent?.type !== 'directory') {
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
      if (parentDir?.type !== 'directory') {
        throw new Error('Expected parent directory before restoration');
      }

      await act(async () => {
        await result.current.loadChildren(parentDir.path);
      });

      const loadedParent = result.current.fileTree.find((node) => node.path === parentDir.path);
      expect(loadedParent?.type).toBe('directory');
      if (loadedParent?.type !== 'directory') {
        throw new Error('Expected loaded parent directory before worker patch');
      }
      const childDir = loadedParent.children?.find((node) => node.name === 'child');
      expect(childDir?.type).toBe('directory');
      if (childDir?.type !== 'directory') {
        throw new Error('Expected child directory handle before worker patch');
      }

      const progress = vi.fn();
      mockWorkerPort.loadPaths.mockResolvedValueOnce({
        expandedPaths: [parentDir.path],
        loadedCount: 1,
        patches: [
          {
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
            type: 'childrenLoaded',
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
            type: 'childrenLoaded',
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

        await waitFor(() => expect(loggedErrors).toContain('loadSpecificPaths failed'));
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
      if (parentDir?.type !== 'directory') {
        throw new Error('Expected parent directory before cache assertions');
      }

      await act(async () => {
        await result.current.loadSpecificPaths([parentDir.path]);
      });

      const loadedParent = result.current.fileTree.find((node) => node.path === parentDir.path);
      expect(loadedParent?.type).toBe('directory');
      if (loadedParent?.type !== 'directory') {
        throw new Error('Expected loaded parent directory before loading child');
      }
      const childDir = loadedParent.children?.find((node) => node.name === 'child');
      expect(childDir?.type).toBe('directory');
      if (childDir?.type !== 'directory') {
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
      if (betaDirectory?.type !== 'directory') {
        throw new Error('Expected beta directory to be present');
      }
      const nestedDirectory = betaDirectory.children?.find(
        (node) => node.path === 'mock-root/beta/nested'
      );
      expect(nestedDirectory?.type).toBe('directory');
      if (nestedDirectory?.type !== 'directory') {
        throw new Error('Expected nested directory to be present');
      }
      expect(nestedDirectory.loadState).toBe('loaded');
    });

    it('uses the worker bulk expand-all path instead of renderer child loads', async () => {
      const mockFS = createExpandAllMockFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      mockWorkerPort.expandAll.mockResolvedValueOnce({
        expandedPaths: ['mock-root/alpha', 'mock-root/beta', 'mock-root/gamma'],
        loadedCount: 3,
        patches: [
          {
            payload: { children: [], loadState: 'loaded', path: 'mock-root/alpha' },
            type: 'childrenLoaded',
          },
          {
            payload: { children: [], loadState: 'loaded', path: 'mock-root/beta' },
            type: 'childrenLoaded',
          },
          {
            payload: { children: [], loadState: 'loaded', path: 'mock-root/gamma' },
            type: 'childrenLoaded',
          },
        ],
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

    it('surfaces worker expand-all failures and clears progress state', async () => {
      const mockFS = createExpandAllMockFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      mockWorkerPort.expandAll.mockRejectedValueOnce(new Error('worker crashed'));

      const loggedErrors: string[] = [];
      const unsubscribe = addLogListener((record) => {
        if (record.scope === 'ExpandAll' && typeof record.message === 'string') {
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
          await result.current.expandAllProgressively(() => new Set());
        });

        expect(result.current.expandAllProgress).toBeNull();
        await waitFor(() => expect(loggedErrors).toContain('expandAllProgressively: error'));
      } finally {
        unsubscribe();
      }
    });

    it('bulk-applies worker expand-all children patches in one normalized update', async () => {
      const mockFS = createExpandAllMockFileSystem();
      mockAdapter.setMockFileSystem(mockFS);

      const handle = await mockAdapter.requestDirectoryAccess();
      mockWorkerPort.expandAll.mockResolvedValueOnce({
        expandedPaths: ['mock-root/alpha', 'mock-root/beta', 'mock-root/gamma'],
        loadedCount: 3,
        patches: [
          {
            payload: {
              children: [],
              loadState: 'loaded',
              path: 'mock-root/alpha',
            },
            type: 'childrenLoaded',
          },
          {
            payload: {
              children: [],
              loadState: 'loaded',
              path: 'mock-root/beta',
            },
            type: 'childrenLoaded',
          },
          {
            payload: { children: [], loadState: 'loaded', path: 'mock-root/gamma' },
            type: 'childrenLoaded',
          },
        ],
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
        expandedPaths: ['mock-root/alpha'],
        loadedCount: 1,
        patches: [
          {
            payload: { children: [], loadState: 'loaded', path: 'mock-root/alpha' },
            type: 'childrenLoaded',
          },
          {
            payload: {
              loadError: 'Permission denied',
              loadState: 'error',
              path: 'mock-root/beta',
            },
            type: 'nodeLoadStateChanged',
          },
        ],
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

  describe('recursive-select tree hydration', () => {
    it('hydrates scanned directories so a completed folder select can derive checked without manual expansion', async () => {
      const nestedFS = createNestedMockFileSystem();
      mockAdapter.setMockFileSystem(nestedFS);
      const handle = await mockAdapter.requestDirectoryAccess();
      const TestWrapper = ({ children }: { children: ReactNode }) =>
        FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
      const { result } = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const parentNode = result.current.fileTree.find((n) => n.name === 'parent');
      if (!parentNode) {
        throw new Error('parent directory not found in loaded root');
      }
      expect(parentNode.loadState).toBe('unloaded');

      const addMultipleSelectedFiles = vi.fn();
      await act(async () => {
        await result.current.selectFolderRecursively(
          parentNode,
          'folder-1',
          addMultipleSelectedFiles,
          1000,
          0,
          0
        );
      });

      // The scan read parent/ and parent/child/ from the adapter — the lazy
      // tree must ingest those listings (loadState 'loaded' + counts) so the
      // tri-state derivation can prove completeness immediately. Previously
      // the selection landed but the tree stayed unloaded, leaving the folder
      // stuck at indeterminate until the user expanded every subdirectory.
      await waitFor(() => {
        expect(result.current.__internalGetDescendantFileCount?.(parentNode.path)).toBe(1);
      });
      const hydratedParent = result.current.fileTree.find((n) => n.name === 'parent');
      expect(hydratedParent?.loadState).toBe('loaded');
      const child = hydratedParent?.children?.find((n) => n.name === 'child');
      expect(child?.loadState).toBe('loaded');
      expect(child?.children?.map((n) => n.name)).toEqual(['nested-file.txt']);
    });
  });
});
