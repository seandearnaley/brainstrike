/**
 * Worker bulk operations vs in-flight manual loads.
 *
 * Expand-all commit batching applies ONLY to the renderer-fallback session.
 * A manual directory load that resolves while a WORKER-path expand-all is in
 * flight must commit immediately — buffering it would let the session-end
 * flush replace a worker-loaded deep subtree with the stale shallow children
 * (PR #1742 review finding).
 *
 * The reverse also holds: a bulk restoration result must not replace a
 * directory that a manual load already committed while the bulk request was in
 * flight, or the committed descendants are discarded.
 */

import { MockFileSystemAdapter } from '@brainstrike/file-system';
import type { AccumulatedFileTreePatchMessage } from '@brainstrike/file-tree-worker';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileTree } from '../tree/use-file-tree-context';
import { __resetInFlightRootLoads } from '../tree/use-lazy-file-tree';
import { toWorkerFileNodes } from '../utils/worker-node-conversion';
import { FileExplorerTestWrapper } from './test-helpers';

const mockWorkerPort = {
  abort: vi.fn(),
  expandAll: vi.fn(),
  init: vi.fn(),
  loadPaths: vi.fn().mockResolvedValue({ expandedPaths: [], loadedCount: 0, patches: [] }),
  onChildrenLoaded: vi.fn(() => () => {}),
  onError: vi.fn(() => () => {}),
  onExpandedPathsDelta: vi.fn(() => () => {}),
  onLog: vi.fn(() => () => {}),
  onNodeLoadStateChanged: vi.fn(() => () => {}),
  onProgress: vi.fn(() => () => {}),
  onRequestLoad: vi.fn(() => () => {}),
  onTreeSnapshot: vi.fn(() => () => {}),
  terminate: vi.fn(),
  updateTree: vi.fn(),
};

vi.mock('@brainstrike/file-tree-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-tree-worker')>();
  return {
    ...actual,
    createFileTreeWorkerPort: vi.fn(() => mockWorkerPort),
    resolveFileTreeWorkerUrl: vi.fn(() => new URL('data:text/javascript,')),
  };
});

vi.stubGlobal(
  'Worker',
  vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn(),
    postMessage: vi.fn(),
    removeEventListener: vi.fn(),
    terminate: vi.fn(),
  }))
);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useLazyFileTree worker-path expand-all with in-flight manual load', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
    vi.clearAllMocks();
    __resetInFlightRootLoads();
  });

  it('commits a manual load immediately during worker expand-all instead of buffering it', async () => {
    mockAdapter.setMockFileSystem({
      other: { children: {}, name: 'other', type: 'directory' },
      parent: {
        children: {
          'a.txt': { content: 'a', name: 'a.txt', type: 'file' },
          inner: { children: {}, name: 'inner', type: 'directory' },
        },
        name: 'parent',
        type: 'directory',
      },
    });
    const handle = await mockAdapter.requestDirectoryAccess();
    const parentPath = `${handle.path}/parent`;

    // Gate reads of `parent` behind a deferred so the manual load stays in
    // flight until the worker expand-all has started.
    const parentReadGate = createDeferred<void>();
    const originalStreaming = mockAdapter.readDirectoryStreaming.bind(mockAdapter);
    mockAdapter.readDirectoryStreaming = async (dirHandle, onBatch, options) => {
      if (dirHandle.path === parentPath) {
        await parentReadGate.promise;
      }
      return originalStreaming(dirHandle, onBatch, options);
    };

    const expandAllGate = createDeferred<{
      expandedPaths: string[];
      loadedCount: number;
      patches: never[];
    }>();
    mockWorkerPort.expandAll.mockReturnValue(expandAllGate.promise);

    const TestWrapper = ({ children }: { children: ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

    const { result } = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });

    await waitFor(() => expect(result.current.fileTree.length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let manualLoad: Promise<void> = Promise.resolve();
    act(() => {
      manualLoad = result.current.loadChildren(parentPath);
    });

    let expandedPaths = new Set<string>();
    const setExpandedPaths = (updater: (prev: Set<string>) => Set<string>): void => {
      expandedPaths = updater(expandedPaths);
    };
    let expandPromise: Promise<void> = Promise.resolve();
    act(() => {
      expandPromise = result.current.expandAllProgressively(setExpandedPaths, expandedPaths);
    });
    await waitFor(() => expect(mockWorkerPort.expandAll).toHaveBeenCalled());

    // Manual load resolves while the worker expand-all is still in flight.
    await act(async () => {
      parentReadGate.resolve();
      await manualLoad;
    });

    // The result must be committed immediately (worker path is active — the
    // renderer-session batching must not buffer it).
    const committedParent = result.current.fileTree.find((node) => node.path === parentPath);
    expect(committedParent?.loadState).toBe('loaded');
    expect(committedParent?.children?.map((child) => child.name)).toEqual(['inner', 'a.txt']);

    await act(async () => {
      expandAllGate.resolve({
        expandedPaths: [parentPath, `${handle.path}/other`],
        loadedCount: 0,
        patches: [],
      });
      await expandPromise;
    });

    // After the session ends (final flush runs), the committed subtree is
    // still intact — nothing stale replaced it.
    const finalParent = result.current.fileTree.find((node) => node.path === parentPath);
    expect(finalParent?.loadState).toBe('loaded');
    expect(finalParent?.children?.map((child) => child.name)).toEqual(['inner', 'a.txt']);
  });
});

describe('useLazyFileTree worker-path restoration with committed manual loads', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
    vi.clearAllMocks();
    __resetInFlightRootLoads();
  });

  it('keeps a manually loaded descendant when a stale bulk patch re-lists its parent', async () => {
    mockAdapter.setMockFileSystem({
      src: {
        children: {
          'App.tsx': { content: 'app', name: 'App.tsx', type: 'file' },
          components: {
            children: {
              'molecule-viewer.tsx': {
                content: 'viewer',
                name: 'molecule-viewer.tsx',
                type: 'file',
              },
            },
            name: 'components',
            type: 'directory',
          },
          hooks: { children: {}, name: 'hooks', type: 'directory' },
        },
        name: 'src',
        type: 'directory',
      },
    });
    const handle = await mockAdapter.requestDirectoryAccess();
    const srcPath = `${handle.path}/src`;
    const componentsPath = `${srcPath}/components`;

    const loadPathsGate = createDeferred<{
      expandedPaths: string[];
      loadedCount: number;
      patches: AccumulatedFileTreePatchMessage[];
    }>();
    mockWorkerPort.loadPaths.mockReturnValueOnce(loadPathsGate.promise);

    const TestWrapper = ({ children }: { children: ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

    const { result } = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });

    await waitFor(() => expect(result.current.fileTree.length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let restoration: Promise<void> = Promise.resolve();
    act(() => {
      restoration = result.current.loadSpecificPaths([srcPath, componentsPath]);
    });
    await waitFor(() => expect(mockWorkerPort.loadPaths).toHaveBeenCalled());

    // While the bulk request is in flight, manual loads commit `src` and then
    // `components`. The worker read `src` before `components` loaded, so its
    // `src` listing still carries an unloaded `components` child, and it skips
    // `components` because the manual load already populated its tree.
    await act(async () => {
      await result.current.loadChildren(srcPath);
    });
    const staleSrcChildren =
      result.current.fileTree.find((node) => node.path === srcPath)?.children ?? [];
    await act(async () => {
      await result.current.loadChildren(componentsPath);
    });

    await act(async () => {
      loadPathsGate.resolve({
        expandedPaths: [],
        loadedCount: 1,
        patches: [
          {
            payload: {
              children: toWorkerFileNodes(staleSrcChildren),
              loadState: 'loaded',
              path: srcPath,
            },
            type: 'childrenLoaded',
          },
        ],
      });
      await restoration;
    });

    const components = result.current.fileTree
      .find((node) => node.path === srcPath)
      ?.children?.find((node) => node.path === componentsPath);
    expect(components?.loadState).toBe('loaded');
    expect(components?.children?.map((child) => child.name)).toEqual(['molecule-viewer.tsx']);
  });
});
