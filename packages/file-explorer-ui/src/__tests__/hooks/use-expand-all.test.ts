/**
 * Tests for useExpandAll hook
 *
 * Covers the direct canonical-tree expand-all behavior, cancellation, and error handling.
 */

import type { IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { useExpandAll } from '../../hooks/use-expand-all';

vi.mock('@brainstrike/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...original,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

function createFileNode(overrides: Partial<IFileNode> = {}): IFileNode {
  return {
    depth: 1,
    handle: {} as FileSystemFileHandle,
    name: 'file.txt',
    path: '/root/file.txt',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
    ...overrides,
  };
}

function createDirectoryNode(overrides: Partial<IFileNode> = {}): IFileNode {
  return {
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    loadState: 'unloaded',
    name: 'dir',
    path: '/root/dir',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
    ...overrides,
  };
}

function findNodeByPath(nodes: IFileNode[], path: string): IFileNode | undefined {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    const found = node.children ? findNodeByPath(node.children, path) : undefined;
    if (found) {
      return found;
    }
  }
  return;
}

describe('useExpandAll', () => {
  let rootNodesRef: { current: IFileNode[] };
  let cancelLoadOperationsMock: Mock<() => void>;
  let onErrorMock: Mock<(error: Error) => void>;
  let onProgressMock: Mock<(loaded: number, total: number) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    rootNodesRef = {
      current: [
        createDirectoryNode({
          loadState: 'unloaded',
          name: 'src',
          path: '/root/src',
        }),
      ],
    };
    cancelLoadOperationsMock = vi.fn<() => void>();
    onErrorMock = vi.fn<(error: Error) => void>();
    onProgressMock = vi.fn<(loaded: number, total: number) => void>();
  });

  function renderExpandAllHook(
    loadDirectoryPath: (path: string) => Promise<void> = async (path: string) => {
      if (path !== '/root/src') {
        return;
      }
      rootNodesRef.current = [
        createDirectoryNode({
          children: [
            createDirectoryNode({
              children: [createFileNode({ depth: 2, path: '/root/src/nested/a.ts' })],
              depth: 1,
              loadState: 'loaded',
              name: 'nested',
              path: '/root/src/nested',
            }),
            createFileNode({ depth: 1, path: '/root/src/index.ts' }),
          ],
          loadState: 'loaded',
          name: 'src',
          path: '/root/src',
        }),
      ];
    },
    overrides: Partial<Parameters<typeof useExpandAll>[0]> = {}
  ) {
    return renderHook(() =>
      useExpandAll({
        cancelLoadOperations: (): void => {
          cancelLoadOperationsMock();
        },
        getNodeByPath: (path: string) => findNodeByPath(rootNodesRef.current, path),
        getRootNodes: () => rootNodesRef.current,
        loadDirectoryPath,
        onError: (error: Error): void => {
          onErrorMock(error);
        },
        onProgress: (loaded: number, total: number): void => {
          onProgressMock(loaded, total);
        },
        rootFolderId: 'root',
        ...overrides,
      })
    );
  }

  it('initializes with isExpandingAll=false', () => {
    const { result } = renderExpandAllHook();
    expect(result.current.isExpandingAll).toBe(false);
  });

  it('sets isExpandingAll=true during operation', async () => {
    let resolveLoad: (() => void) | undefined;
    const loadDirectoryPath = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );

    const { result } = renderExpandAllHook(loadDirectoryPath);
    const setExpandedPaths = vi.fn();

    let expandPromise: Promise<void>;
    await act(async () => {
      expandPromise = result.current.expandAllProgressively(setExpandedPaths);
    });

    expect(result.current.isExpandingAll).toBe(true);

    await act(async () => {
      resolveLoad?.();
      await expandPromise!;
    });

    expect(result.current.isExpandingAll).toBe(false);
  });

  it('loads unloaded directories and expands all discovered directory paths', async () => {
    const loadDirectoryPath = vi.fn(async (path: string) => {
      if (path !== '/root/src') {
        return;
      }
      rootNodesRef.current = [
        createDirectoryNode({
          children: [
            createDirectoryNode({
              children: [],
              depth: 1,
              loadState: 'loaded',
              name: 'nested',
              path: '/root/src/nested',
            }),
            createFileNode({ depth: 1, path: '/root/src/index.ts' }),
          ],
          loadState: 'loaded',
          name: 'src',
          path: '/root/src',
        }),
      ];
    });

    const { result } = renderExpandAllHook(loadDirectoryPath);
    const setExpandedPaths = vi.fn();

    await act(async () => {
      await result.current.expandAllProgressively(setExpandedPaths);
    });

    expect(loadDirectoryPath).toHaveBeenCalledWith('/root/src');
    expect(onProgressMock).toHaveBeenCalled();
    let expandedPaths = new Set<string>();
    for (const [updater] of setExpandedPaths.mock.calls as [(prev: Set<string>) => Set<string>][]) {
      expandedPaths = updater(expandedPaths);
    }
    expect(expandedPaths).toEqual(new Set(['/root/src', '/root/src/nested']));
  });

  it('does not enter expand-all when every known directory is already loaded and expanded', async () => {
    rootNodesRef.current = [
      createDirectoryNode({
        children: [
          createDirectoryNode({
            children: [],
            depth: 1,
            loadState: 'loaded',
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        loadState: 'loaded',
        name: 'src',
        path: '/root/src',
      }),
    ];
    const loadDirectoryPath = vi.fn();
    const { result } = renderExpandAllHook(loadDirectoryPath);
    const setExpandedPaths = vi.fn();

    await act(async () => {
      await result.current.expandAllProgressively(
        setExpandedPaths,
        new Set(['/root/src', '/root/src/nested'])
      );
    });

    expect(result.current.isExpandingAll).toBe(false);
    expect(loadDirectoryPath).not.toHaveBeenCalled();
    expect(setExpandedPaths).not.toHaveBeenCalled();
    expect(onProgressMock).not.toHaveBeenCalled();
  });

  it('commits already-loaded missing expansion paths without starting progressive traversal', async () => {
    rootNodesRef.current = [
      createDirectoryNode({
        children: [
          createDirectoryNode({
            children: [
              createDirectoryNode({
                children: [],
                depth: 2,
                loadState: 'loaded',
                name: 'leaf',
                path: '/root/src/nested/leaf',
              }),
            ],
            depth: 1,
            loadState: 'loaded',
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        loadState: 'loaded',
        name: 'src',
        path: '/root/src',
      }),
    ];
    const loadDirectoryPath = vi.fn();
    const yieldToBrowser = vi.fn(async () => undefined);
    const { result } = renderExpandAllHook(loadDirectoryPath, {
      batchConfig: { maxDirectoriesPerBatch: 1 },
      yieldToBrowser,
    });
    const setExpandedPaths = vi.fn();

    await act(async () => {
      await result.current.expandAllProgressively(setExpandedPaths, new Set(['/root/src']));
    });

    expect(result.current.isExpandingAll).toBe(false);
    expect(loadDirectoryPath).not.toHaveBeenCalled();
    expect(yieldToBrowser).not.toHaveBeenCalled();
    expect(onProgressMock).not.toHaveBeenCalled();
    expect(setExpandedPaths).toHaveBeenCalledTimes(1);

    const [updater] = setExpandedPaths.mock.calls[0] as [(prev: Set<string>) => Set<string>];
    expect(updater(new Set(['/root/src']))).toEqual(
      new Set(['/root/src', '/root/src/nested', '/root/src/nested/leaf'])
    );
  });

  it('commits newly discovered loaded descendants incrementally across batches', async () => {
    rootNodesRef.current = [
      createDirectoryNode({
        children: [
          createDirectoryNode({
            depth: 1,
            loadState: 'unloaded',
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        loadState: 'loaded',
        name: 'src',
        path: '/root/src',
      }),
    ];

    const loadDirectoryPath = vi.fn(async (path: string) => {
      if (path !== '/root/src/nested') {
        return;
      }
      rootNodesRef.current = [
        createDirectoryNode({
          children: [
            createDirectoryNode({
              children: [
                createDirectoryNode({
                  depth: 2,
                  loadState: 'loaded',
                  name: 'deep',
                  path: '/root/src/nested/deep',
                }),
              ],
              depth: 1,
              loadState: 'loaded',
              name: 'nested',
              path: '/root/src/nested',
            }),
          ],
          loadState: 'loaded',
          name: 'src',
          path: '/root/src',
        }),
      ];
    });
    const yieldToBrowser = vi.fn(async () => undefined);
    const { result } = renderExpandAllHook(loadDirectoryPath, {
      batchConfig: { maxDirectoriesPerBatch: 1 },
      yieldToBrowser,
    });
    const setExpandedPaths = vi.fn();

    await act(async () => {
      await result.current.expandAllProgressively(setExpandedPaths);
    });

    expect(loadDirectoryPath).toHaveBeenCalledWith('/root/src/nested');
    expect(setExpandedPaths).toHaveBeenCalledTimes(2);
    expect(yieldToBrowser).toHaveBeenCalledTimes(1);

    let expandedPaths = new Set<string>();
    for (const [updater] of setExpandedPaths.mock.calls as [(prev: Set<string>) => Set<string>][]) {
      expandedPaths = updater(expandedPaths);
    }
    expect(expandedPaths).toEqual(
      new Set(['/root/src', '/root/src/nested', '/root/src/nested/deep'])
    );
  });

  it('cancels expand-all via cancelExpandAll', async () => {
    const { result } = renderExpandAllHook();

    await act(async () => {
      result.current.cancelExpandAll();
    });

    expect(cancelLoadOperationsMock).toHaveBeenCalled();
    expect(result.current.isExpandingAll).toBe(false);
  });

  it('does not let a stale cancelled session finalize a newer session', async () => {
    const releaseLoads: Array<() => void> = [];
    const loadDirectoryPath = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseLoads.push(resolve);
        })
    );
    const { result } = renderExpandAllHook(loadDirectoryPath);
    const setExpandedPaths = vi.fn();

    let firstSessionPromise: Promise<void> | undefined;
    await act(async () => {
      firstSessionPromise = result.current.expandAllProgressively(setExpandedPaths);
      await Promise.resolve();
    });
    expect(loadDirectoryPath).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.cancelExpandAll();
    });

    let secondSessionPromise: Promise<void> | undefined;
    await act(async () => {
      secondSessionPromise = result.current.expandAllProgressively(setExpandedPaths);
      await Promise.resolve();
    });
    expect(loadDirectoryPath).toHaveBeenCalledTimes(2);
    expect(result.current.isExpandingAll).toBe(true);
    expect(result.current.isExpandingAllRef.current).toBe(true);

    await act(async () => {
      releaseLoads[0]?.();
      await firstSessionPromise;
    });

    const remainedActiveAfterStaleSettlement = result.current.isExpandingAll;
    const refRemainedActiveAfterStaleSettlement = result.current.isExpandingAllRef.current;

    await act(async () => {
      releaseLoads[1]?.();
      await secondSessionPromise;
    });

    expect(remainedActiveAfterStaleSettlement).toBe(true);
    expect(refRemainedActiveAfterStaleSettlement).toBe(true);
    expect(result.current.isExpandingAll).toBe(false);
    expect(result.current.isExpandingAllRef.current).toBe(false);
    expect(onErrorMock).not.toHaveBeenCalled();
  });

  it('leaves a valid partial expansion state when cancelled between batches', async () => {
    rootNodesRef.current = [
      createDirectoryNode({
        children: [
          createDirectoryNode({
            depth: 1,
            loadState: 'unloaded',
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        loadState: 'loaded',
        name: 'src',
        path: '/root/src',
      }),
    ];

    let cancelAfterFirstYield = false;
    const loadDirectoryPath = vi.fn(async (path: string) => {
      if (path !== '/root/src/nested') {
        return;
      }
      rootNodesRef.current = [
        createDirectoryNode({
          children: [
            createDirectoryNode({
              children: [
                createDirectoryNode({
                  depth: 2,
                  loadState: 'loaded',
                  name: 'deep',
                  path: '/root/src/nested/deep',
                }),
              ],
              depth: 1,
              loadState: 'loaded',
              name: 'nested',
              path: '/root/src/nested',
            }),
          ],
          loadState: 'loaded',
          name: 'src',
          path: '/root/src',
        }),
      ];
    });
    const { result } = renderExpandAllHook(loadDirectoryPath, {
      batchConfig: { maxDirectoriesPerBatch: 1 },
      yieldToBrowser: async () => {
        if (!cancelAfterFirstYield) {
          cancelAfterFirstYield = true;
          result.current.cancelExpandAll();
        }
      },
    });
    const setExpandedPaths = vi.fn();

    await act(async () => {
      await result.current.expandAllProgressively(setExpandedPaths);
    });

    expect(setExpandedPaths).toHaveBeenCalledTimes(2);
    let expandedPaths = new Set<string>();
    for (const [updater] of setExpandedPaths.mock.calls as [(prev: Set<string>) => Set<string>][]) {
      expandedPaths = updater(expandedPaths);
    }
    expect(expandedPaths).toEqual(
      new Set(['/root/src', '/root/src/nested', '/root/src/nested/deep'])
    );
  });

  it('prevents double-clicks from starting multiple operations', async () => {
    let resolveLoad: (() => void) | undefined;
    const loadDirectoryPath = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );

    const { result } = renderExpandAllHook(loadDirectoryPath);
    const setExpandedPaths = vi.fn();

    await act(async () => {
      void result.current.expandAllProgressively(setExpandedPaths);
      void result.current.expandAllProgressively(setExpandedPaths);
    });

    expect(loadDirectoryPath).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoad?.();
      await Promise.resolve();
    });
  });

  it('calls onError when directory loading fails', async () => {
    const testError = new Error('Test expand-all error');
    const loadDirectoryPath = vi.fn(async () => {
      throw testError;
    });

    const { result } = renderExpandAllHook(loadDirectoryPath);
    const setExpandedPaths = vi.fn();

    await act(async () => {
      await result.current.expandAllProgressively(setExpandedPaths);
    });

    expect(onErrorMock).toHaveBeenCalledWith(testError);
    expect(result.current.isExpandingAll).toBe(false);
  });

  it('does not call onError for AbortError', async () => {
    const abortError = new DOMException('Operation aborted', 'AbortError');
    const loadDirectoryPath = vi.fn(async () => {
      throw abortError;
    });

    const { result } = renderExpandAllHook(loadDirectoryPath);
    const setExpandedPaths = vi.fn();

    await act(async () => {
      await result.current.expandAllProgressively(setExpandedPaths);
    });

    expect(onErrorMock).not.toHaveBeenCalled();
    expect(result.current.isExpandingAll).toBe(false);
  });

  it('skips when there are no directories to expand', async () => {
    rootNodesRef.current = [createFileNode({ depth: 0, path: '/root/readme.md' })];
    const loadDirectoryPath = vi.fn();

    const { result } = renderExpandAllHook(loadDirectoryPath);
    const setExpandedPaths = vi.fn();

    await act(async () => {
      await result.current.expandAllProgressively(setExpandedPaths);
    });

    expect(loadDirectoryPath).not.toHaveBeenCalled();
    expect(setExpandedPaths).not.toHaveBeenCalled();
  });
});
