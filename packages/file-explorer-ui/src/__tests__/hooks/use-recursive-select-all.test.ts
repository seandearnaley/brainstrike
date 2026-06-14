import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRecursiveSelectAll } from '../../hooks/use-recursive-select-all';

let mockStoreState: Record<string, unknown> | null = null;

vi.mock('@brainstrike/hooks', () => ({
  useEventCallback: <TArgs extends unknown[], TResult>(callback: (...args: TArgs) => TResult) =>
    callback,
  useFileFilters: () => ({
    applyFileFilters: vi.fn((tree: IFileNode[]) => tree),
  }),
}));

const showToastMock = vi.fn();

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    storageAdapter: {
      getItem: vi.fn(),
      setItem: vi.fn(async () => undefined),
      removeItem: vi.fn(),
      clear: vi.fn(),
      getAllKeys: vi.fn(),
    },
  }),
  useToastManager: () => ({ showToast: showToastMock }),
}));

vi.mock('../../shell/file-explorer-provider', () => ({
  useOptionalFileExplorerStoreContext: () =>
    mockStoreState ? { getState: () => mockStoreState } : null,
  useOptionalFileExplorerStoreSelector: (
    selector: ((state: Record<string, unknown>) => unknown) | unknown,
    fallbackValue: unknown
  ) => {
    if (!(mockStoreState && typeof selector === 'function')) {
      return fallbackValue;
    }
    const selectedValue = selector(mockStoreState);
    return selectedValue === undefined ? fallbackValue : selectedValue;
  },
}));

vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

function createFileNode(
  overrides: Partial<IFileNode> & { name: string; path: string; type: 'file' | 'directory' }
): IFileNode {
  return {
    handle:
      overrides.type === 'directory'
        ? ({} as FileSystemDirectoryHandle)
        : ({} as FileSystemFileHandle),
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'folder-1',
    loadState: 'loaded',
    isVisible: true,
    ...overrides,
  };
}

function createMockAdapter(directoryMap: Record<string, IFileNode[]>): FileSystemAdapter {
  const readDirectory = vi.fn(async (handle: DirectoryHandle) => directoryMap[handle.path] ?? []);

  return {
    requestDirectoryAccess: vi.fn(),
    readDirectory,
    readFile: vi.fn(),
    exists: vi.fn(),
  } as unknown as FileSystemAdapter;
}

function createLoadedTree(): IFileNode[] {
  return [
    createFileNode({
      name: 'src',
      path: '/src',
      type: 'directory',
      children: [
        createFileNode({ name: 'index.ts', path: '/src/index.ts', type: 'file', depth: 1 }),
        createFileNode({ name: 'utils.ts', path: '/src/utils.ts', type: 'file', depth: 1 }),
      ],
    }),
    createFileNode({ name: 'README.md', path: '/README.md', type: 'file' }),
  ];
}

function createPartiallyLoadedTree(): IFileNode[] {
  return [
    createFileNode({
      name: 'src',
      path: '/src',
      type: 'directory',
      loadState: 'unloaded',
      children: [],
    }),
    createFileNode({
      name: 'notes.md',
      path: '/notes.md',
      type: 'file',
    }),
  ];
}

describe('useRecursiveSelectAll', () => {
  const onTreeUpdate = vi.fn();
  const onError = vi.fn();
  const addMultipleSelectedFiles = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState = null;
  });

  it('toasts and commits nothing when the view filters exclude every file', async () => {
    // The historical mystery no-op: include filters (e.g. *.ts) on an
    // html-only workspace scan to zero matches. Select All must never be a
    // silent no-op, and an EMPTY query selection must never be committed.
    const currentTree = [createFileNode({ name: 'index.html', path: '/index.html', type: 'file' })];
    const fileSystemAdapter = createMockAdapter({});
    const setQuerySelection = vi.fn();
    mockStoreState = {
      setQuerySelection,
      includeFilters: ['**/*.ts'],
      excludeFilters: [],
    };

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 10)
    );

    expect(selectionResult.success).toBe(true);
    expect(selectionResult.filePaths).toEqual([]);
    expect(setQuerySelection).not.toHaveBeenCalled();
    expect(addMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('No selectable files') })
    );
  });

  it('uses explicit selection (never top-level query mode) when the target is not the focused root', async () => {
    // Forest mode: a per-root select-all for a NON-focused root must route
    // through the store mutators (which write that root's folderState) —
    // query mode lives on the focused root's top-level model.
    const currentTree = createLoadedTree();
    const fileSystemAdapter = createMockAdapter({});
    const setQuerySelection = vi.fn();
    mockStoreState = {
      setQuerySelection,
      currentFolderId: 'other-root',
      selectionModel: { mode: 'explicit' },
      selectedFilePaths: new Set<string>(),
    };

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 10)
    );

    expect(selectionResult.success).toBe(true);
    expect(setQuerySelection).not.toHaveBeenCalled();
    expect(addMultipleSelectedFiles).toHaveBeenCalledWith('folder-1', [
      '/src/index.ts',
      '/src/utils.ts',
      '/README.md',
    ]);
  });

  it('selects all visible files from loaded roots without adapter reads', async () => {
    const currentTree = createLoadedTree();
    const fileSystemAdapter = createMockAdapter({});

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 10)
    );

    expect(selectionResult.success).toBe(true);
    expect(selectionResult.filePaths).toEqual(['/src/index.ts', '/src/utils.ts', '/README.md']);
    expect(addMultipleSelectedFiles).toHaveBeenCalledWith('folder-1', [
      '/src/index.ts',
      '/src/utils.ts',
      '/README.md',
    ]);
    expect(fileSystemAdapter.readDirectory).not.toHaveBeenCalled();
    expect(onTreeUpdate).toHaveBeenCalledWith(currentTree);
  });

  it('passes large explicit select-all results through the optimized chunked action', async () => {
    const currentTree = Array.from({ length: 120 }, (_, index) =>
      createFileNode({
        name: `file-${index}.ts`,
        path: `/file-${index}.ts`,
        type: 'file',
      })
    );
    const addMultipleSelectedFilesChunked = vi.fn(async () => ({
      addedCount: 120,
      cancelled: false,
      limitReached: false,
    }));

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter: createMockAdapter({}),
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    await act(async () =>
      result.current.selectAllRecursively(
        currentTree,
        'folder-1',
        addMultipleSelectedFiles,
        120,
        addMultipleSelectedFilesChunked
      )
    );

    expect(addMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(addMultipleSelectedFilesChunked).toHaveBeenCalledTimes(1);
    const chunkedCalls = addMultipleSelectedFilesChunked.mock.calls as unknown as [
      string,
      string[],
      { signal?: AbortSignal },
    ][];
    expect(chunkedCalls[0]?.[1]).toHaveLength(120);
  });

  it('respects visibility and maxSelectionCount in the canonical query path', async () => {
    const currentTree: IFileNode[] = [
      createFileNode({ name: 'a.ts', path: '/a.ts', type: 'file', isVisible: true }),
      createFileNode({ name: 'b.ts', path: '/b.ts', type: 'file', isVisible: false }),
      createFileNode({ name: 'c.ts', path: '/c.ts', type: 'file', isVisible: true }),
    ];

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter: createMockAdapter({}),
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 1)
    );

    expect(selectionResult.filePaths).toEqual(['/a.ts']);
    expect(selectionResult.totalAvailable).toBe(1);
  });

  it('reads unloaded directories from the adapter without mutating tree state for selection', async () => {
    const currentTree = createPartiallyLoadedTree();
    const fileSystemAdapter = createMockAdapter({
      '/src': [
        createFileNode({ name: 'main.ts', path: '/src/main.ts', type: 'file', depth: 1 }),
        createFileNode({
          name: 'nested',
          path: '/src/nested',
          type: 'directory',
          depth: 1,
          loadState: 'unloaded',
          children: [],
        }),
      ],
      '/src/nested': [
        createFileNode({
          name: 'deep.ts',
          path: '/src/nested/deep.ts',
          type: 'file',
          depth: 2,
        }),
      ],
    });

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 10)
    );

    expect(fileSystemAdapter.readDirectory).toHaveBeenCalledTimes(2);
    expect(selectionResult.filePaths).toEqual(['/notes.md', '/src/main.ts', '/src/nested/deep.ts']);
    expect(currentTree[0]?.loadState).toBe('unloaded');
  });

  it('commits full-result recursive select-all through query selection even for small trees', async () => {
    const currentTree = createPartiallyLoadedTree();
    const setQuerySelection = vi.fn();
    mockStoreState = {
      setQuerySelection,
    };
    const fileSystemAdapter = createMockAdapter({
      '/src': [
        createFileNode({ name: 'main.ts', path: '/src/main.ts', type: 'file', depth: 1 }),
        createFileNode({
          name: 'nested',
          path: '/src/nested',
          type: 'directory',
          depth: 1,
          loadState: 'unloaded',
          children: [],
        }),
      ],
      '/src/nested': [
        createFileNode({
          name: 'deep.ts',
          path: '/src/nested/deep.ts',
          type: 'file',
          depth: 2,
        }),
      ],
    });

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 10)
    );

    expect(selectionResult.success).toBe(true);
    expect(selectionResult.filePaths).toEqual(['/notes.md', '/src/main.ts', '/src/nested/deep.ts']);
    expect(setQuerySelection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'recursive-select-all',
        folderId: 'folder-1',
        rootPath: null,
        coveredDirectoryPaths: ['/src', '/src/nested'],
        includeFilters: [],
        excludeFilters: [],
        includedPaths: [],
        excludedPaths: [],
        manifestSnapshotId: null,
        useRegex: false,
        totalSelectedCount: 3,
      }),
      expect.objectContaining({
        filePaths: ['/notes.md', '/src/main.ts', '/src/nested/deep.ts'],
        snapshotId: null,
        status: 'ready',
      }),
      new Set(['/notes.md', '/src/main.ts', '/src/nested/deep.ts'])
    );
    expect(addMultipleSelectedFiles).not.toHaveBeenCalled();
  });

  it('stops adapter traversal once the visible frontier satisfies the cap', async () => {
    const currentTree = createPartiallyLoadedTree();
    const fileSystemAdapter = createMockAdapter({
      '/src': [
        createFileNode({ name: 'a.ts', path: '/src/a.ts', type: 'file', depth: 1 }),
        createFileNode({ name: 'b.ts', path: '/src/b.ts', type: 'file', depth: 1 }),
        createFileNode({
          name: 'nested',
          path: '/src/nested',
          type: 'directory',
          depth: 1,
          loadState: 'unloaded',
          children: [],
        }),
      ],
      '/src/nested': [
        createFileNode({
          name: 'deep.ts',
          path: '/src/nested/deep.ts',
          type: 'file',
          depth: 2,
        }),
      ],
    });

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 2)
    );

    expect(fileSystemAdapter.readDirectory).toHaveBeenCalledTimes(1);
    expect(selectionResult.filePaths).toEqual(['/notes.md', '/src/a.ts']);
  });

  it('applies filterTreeFn while traversing adapter-loaded nodes', async () => {
    const currentTree = createPartiallyLoadedTree();
    const fileSystemAdapter = createMockAdapter({
      '/src': [
        createFileNode({ name: 'keep.ts', path: '/src/keep.ts', type: 'file', depth: 1 }),
        createFileNode({ name: 'skip.md', path: '/src/skip.md', type: 'file', depth: 1 }),
      ],
    });

    const filterTreeFn = vi.fn((nodes: IFileNode[]): IFileNode[] =>
      nodes.filter((node) => (node.type === 'directory' ? true : node.path.endsWith('.ts')))
    );

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        filterTreeFn,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 10)
    );

    expect(filterTreeFn).toHaveBeenCalled();
    expect(selectionResult.filePaths).toEqual(['/src/keep.ts']);
  });

  it('blocks concurrent select-all operations', async () => {
    const currentTree = createPartiallyLoadedTree();
    let resolveRead: (() => void) | null = null;
    const fileSystemAdapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(
        () =>
          new Promise<IFileNode[]>((resolve) => {
            resolveRead = () => {
              resolve([
                createFileNode({ name: 'done.ts', path: '/src/done.ts', type: 'file', depth: 1 }),
              ]);
            };
          })
      ),
      readFile: vi.fn(),
      exists: vi.fn(),
    } as unknown as FileSystemAdapter;

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    act(() => {
      void result.current.selectAllRecursively(
        currentTree,
        'folder-1',
        addMultipleSelectedFiles,
        10
      );
    });

    const secondResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 10)
    );

    expect(secondResult).toEqual({
      success: false,
      filePaths: [],
      error: 'Operation already in progress',
    });

    act(() => {
      resolveRead?.();
    });
  });

  it('returns a cancelled result when cancellation happens during adapter traversal', async () => {
    const currentTree = createPartiallyLoadedTree();
    let resolveRead: (() => void) | null = null;
    const fileSystemAdapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(
        () =>
          new Promise<IFileNode[]>((resolve) => {
            resolveRead = () => {
              resolve([
                createFileNode({ name: 'done.ts', path: '/src/done.ts', type: 'file', depth: 1 }),
              ]);
            };
          })
      ),
      readFile: vi.fn(),
      exists: vi.fn(),
    } as unknown as FileSystemAdapter;
    const cancelLoadOperations = vi.fn();

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        cancelLoadOperations,
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    let selectionPromise:
      | Promise<Awaited<ReturnType<typeof result.current.selectAllRecursively>>>
      | undefined;

    act(() => {
      selectionPromise = result.current.selectAllRecursively(
        currentTree,
        'folder-1',
        addMultipleSelectedFiles,
        10
      );
    });

    await waitFor(() => {
      expect(result.current.isLoadingForSelectAllRef.current).toBe(true);
    });

    act(() => {
      result.current.cancelSelectAll();
      resolveRead?.();
    });

    const selectionResult = await act(async () => selectionPromise!);

    expect(cancelLoadOperations).toHaveBeenCalled();
    expect(selectionResult.cancelled).toBe(true);
    expect(selectionResult.success).toBe(false);
    expect(selectionResult.error).toBeUndefined();
  });

  it('surfaces adapter errors through onError', async () => {
    const currentTree = createPartiallyLoadedTree();
    const fileSystemAdapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(async () => {
        throw new Error('Load failed');
      }),
      readFile: vi.fn(),
      exists: vi.fn(),
    } as unknown as FileSystemAdapter;

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onError,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 10)
    );

    expect(selectionResult.success).toBe(false);
    expect(selectionResult.error).toBe('Load failed');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Load failed' }));
  });

  it('commits EXPLICIT selection (never query mode) in forest mode, even for the focused root', async () => {
    // FOREST INVARIANT: query selections live on top-level state that focus
    // switches cannot carry into folderState snapshots — with multiple
    // active roots every select-all is explicit.
    const currentTree = createLoadedTree();
    const fileSystemAdapter = createMockAdapter({});
    const setQuerySelection = vi.fn();
    mockStoreState = {
      setQuerySelection,
      currentFolderId: 'folder-1',
      activeRootIds: ['folder-1', 'root-b'],
      selectionModel: { mode: 'explicit' },
      selectedFilePaths: new Set<string>(),
      folderStates: {},
    };

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 10)
    );

    expect(selectionResult.success).toBe(true);
    expect(setQuerySelection).not.toHaveBeenCalled();
    expect(addMultipleSelectedFiles).toHaveBeenCalledWith('folder-1', [
      '/src/index.ts',
      '/src/utils.ts',
      '/README.md',
    ]);
  });

  it('shrinks the scan cap by other roots’ selections (forest-union budget)', async () => {
    // Whole-forest cap: with max 3 and root-b already holding 2 selections,
    // a focused-root select-all may take at most 1. The focused root's OWN
    // current selection does NOT consume budget — select-all replaces it.
    const currentTree = createLoadedTree();
    const fileSystemAdapter = createMockAdapter({});
    mockStoreState = {
      setQuerySelection: vi.fn(),
      currentFolderId: 'folder-1',
      activeRootIds: ['folder-1', 'root-b'],
      selectionModel: { mode: 'explicit' },
      selectedFilePaths: new Set(['folder-1|@|old.ts']),
      folderStates: {
        'root-b': { selectedFilePaths: new Set(['root-b|@|x.ts', 'root-b|@|y.ts']) },
      },
    };

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 3)
    );

    expect(selectionResult.success).toBe(true);
    expect(selectionResult.filePaths).toEqual(['/src/index.ts']);
    expect(selectionResult.limitReached).toBe(true);
  });

  it('subtracts the focused selection from a foreign-root select-all budget', async () => {
    // A select-all on a NON-focused root keeps the focused root's selection
    // in place, so both the focused live selection (2) and root-b's
    // folderState (1) consume budget: max 4 leaves a cap of 1.
    const currentTree = createLoadedTree();
    const fileSystemAdapter = createMockAdapter({});
    mockStoreState = {
      setQuerySelection: vi.fn(),
      currentFolderId: 'other-root',
      activeRootIds: ['other-root', 'folder-1', 'root-b'],
      selectionModel: { mode: 'explicit' },
      selectedFilePaths: new Set(['other-root|@|a.ts', 'other-root|@|b.ts']),
      folderStates: {
        'root-b': { selectedFilePaths: new Set(['root-b|@|x.ts']) },
      },
    };

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 4)
    );

    expect(selectionResult.success).toBe(true);
    expect(selectionResult.filePaths).toEqual(['/src/index.ts']);
  });

  it('toasts and skips the scan entirely when the forest budget is exhausted', async () => {
    const currentTree = createLoadedTree();
    const fileSystemAdapter = createMockAdapter({});
    mockStoreState = {
      setQuerySelection: vi.fn(),
      currentFolderId: 'folder-1',
      activeRootIds: ['folder-1', 'root-b'],
      selectionModel: { mode: 'explicit' },
      selectedFilePaths: new Set<string>(),
      folderStates: {
        'root-b': { selectedFilePaths: new Set(['root-b|@|x.ts', 'root-b|@|y.ts']) },
      },
    };

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 2)
    );

    expect(selectionResult).toEqual({
      success: true,
      filePaths: [],
      limitReached: true,
      totalAvailable: 0,
    });
    expect(addMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(fileSystemAdapter.readDirectory).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('Selection limit reached (2)') })
    );
  });

  it('toasts when Select All commits a partial selection at the max limit', async () => {
    const currentTree = createPartiallyLoadedTree();
    const fileSystemAdapter = createMockAdapter({
      '/src': [
        createFileNode({ name: 'index.ts', path: '/src/index.ts', type: 'file', depth: 1 }),
        createFileNode({ name: 'utils.ts', path: '/src/utils.ts', type: 'file', depth: 1 }),
      ],
    });

    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => currentTree,
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively(currentTree, 'folder-1', addMultipleSelectedFiles, 2)
    );

    expect(selectionResult).toMatchObject({
      success: true,
      limitReached: true,
      filePaths: ['/notes.md', '/src/index.ts'],
    });
    expect(showToastMock).toHaveBeenCalledWith({
      title: 'Selection limit reached (2)',
      description: 'Selected 2 files before hitting the limit. Raise the limit to select more.',
      variant: 'destructive',
    });
  });

  it('returns an error for an empty tree before any adapter work', async () => {
    const fileSystemAdapter = createMockAdapter({});
    const { result } = renderHook(() =>
      useRecursiveSelectAll({
        fileSystemAdapter,
        getCurrentTree: () => [],
        onTreeUpdate,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectAllRecursively([], 'folder-1', addMultipleSelectedFiles, 10)
    );

    expect(selectionResult).toEqual({
      success: false,
      filePaths: [],
      error: 'No files in tree',
    });
    expect(fileSystemAdapter.readDirectory).not.toHaveBeenCalled();
  });
});
