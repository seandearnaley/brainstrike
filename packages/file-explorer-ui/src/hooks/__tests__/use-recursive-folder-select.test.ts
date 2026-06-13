import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRecursiveFolderSelect } from '../use-recursive-folder-select';

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
  useOptionalFileExplorerStoreContext: () => (mockStoreState ? {} : null),
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

function createDirectory(overrides: Partial<IFileNode> = {}): IFileNode {
  return {
    name: 'dir',
    path: '/root/dir',
    type: 'directory',
    handle: {} as FileSystemDirectoryHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    loadState: 'unloaded',
    children: [],
    isVisible: true,
    ...overrides,
  };
}

function createFile(overrides: Partial<IFileNode> = {}): IFileNode {
  return {
    name: 'file.txt',
    path: '/root/file.txt',
    type: 'file',
    handle: {} as FileSystemFileHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    isVisible: true,
    ...overrides,
  };
}

function findNodeByPath(node: IFileNode, path: string): IFileNode | undefined {
  if (node.path === path) {
    return node;
  }
  for (const child of node.children ?? []) {
    const nested = findNodeByPath(child, path);
    if (nested) {
      return nested;
    }
  }
  return;
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

describe('useRecursiveFolderSelect', () => {
  const onError = vi.fn();
  const addMultipleSelectedFiles = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState = null;
  });

  it('rejects non-directory nodes', async () => {
    const root = createDirectory();
    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter: createMockAdapter({}),
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(
        createFile(),
        'folder-id',
        addMultipleSelectedFiles,
        10,
        0
      )
    );

    expect(selectionResult).toEqual({
      success: false,
      filePaths: [],
      error: 'Node is not a directory',
    });
  });

  it('selects descendant files from a fully loaded folder without adapter reads', async () => {
    const root = createDirectory({
      path: '/root/src',
      loadState: 'loaded',
      children: [
        createFile({ name: 'a.ts', path: '/root/src/a.ts', depth: 1 }),
        createFile({ name: 'b.ts', path: '/root/src/b.ts', depth: 1 }),
      ],
    });
    const fileSystemAdapter = createMockAdapter({});

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 10, 0)
    );

    expect(selectionResult.filePaths).toEqual(['/root/src/a.ts', '/root/src/b.ts']);
    expect(addMultipleSelectedFiles).toHaveBeenCalledWith('folder-id', [
      '/root/src/a.ts',
      '/root/src/b.ts',
    ]);
    expect(fileSystemAdapter.readDirectory).not.toHaveBeenCalled();
  });

  it('passes large explicit folder-selection results through the optimized chunked action', async () => {
    const root = createDirectory({
      path: '/root/src',
      loadState: 'loaded',
      children: Array.from({ length: 120 }, (_, index) =>
        createFile({ name: `file-${index}.ts`, path: `/root/src/file-${index}.ts`, depth: 1 })
      ),
    });
    const addMultipleSelectedFilesChunked = vi.fn(async () => ({
      addedCount: 100,
      cancelled: false,
      limitReached: false,
    }));

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter: createMockAdapter({}),
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    await act(async () =>
      result.current.selectFolderRecursively(
        root,
        'folder-id',
        addMultipleSelectedFiles,
        120,
        0,
        0,
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

  it('clamps the remaining budget to zero before adapter work', async () => {
    const root = createDirectory({
      path: '/root/src',
      loadState: 'loaded',
      children: [createFile({ name: 'a.ts', path: '/root/src/a.ts', depth: 1 })],
    });

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter: createMockAdapter({}),
        getSubtreeByPath: (path) => findNodeByPath(root, path),
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 1, 2)
    );

    expect(selectionResult).toEqual({ success: true, filePaths: [] });
    expect(addMultipleSelectedFiles).not.toHaveBeenCalled();
  });

  it('reads unloaded descendants from the adapter without materializing the subtree first', async () => {
    const root = createDirectory({
      path: '/root/src',
      loadState: 'unloaded',
      children: [],
    });
    const fileSystemAdapter = createMockAdapter({
      '/root/src': [
        createDirectory({
          name: 'nested',
          path: '/root/src/nested',
          depth: 1,
          loadState: 'unloaded',
          children: [],
        }),
        createFile({ name: 'main.ts', path: '/root/src/main.ts', depth: 1 }),
      ],
      '/root/src/nested': [
        createFile({ name: 'deep.ts', path: '/root/src/nested/deep.ts', depth: 2 }),
      ],
    });

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 10, 0)
    );

    expect(fileSystemAdapter.readDirectory).toHaveBeenCalledTimes(2);
    expect(selectionResult.filePaths).toEqual(['/root/src/main.ts', '/root/src/nested/deep.ts']);
    expect(root.loadState).toBe('unloaded');
  });

  it('commits full-result recursive folder selection through query mode even for small subtrees', async () => {
    const root = createDirectory({
      path: '/root/src',
      loadState: 'unloaded',
      children: [],
    });
    const setQuerySelection = vi.fn();
    mockStoreState = {
      setQuerySelection,
    };
    const fileSystemAdapter = createMockAdapter({
      '/root/src': [
        createFile({ name: 'main.ts', path: '/root/src/main.ts', depth: 1 }),
        createDirectory({
          name: 'nested',
          path: '/root/src/nested',
          depth: 1,
          loadState: 'unloaded',
          children: [],
        }),
      ],
      '/root/src/nested': [
        createFile({ name: 'deep.ts', path: '/root/src/nested/deep.ts', depth: 2 }),
      ],
    });

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 10, 0)
    );

    expect(selectionResult.success).toBe(true);
    expect(selectionResult.filePaths).toEqual(['/root/src/main.ts', '/root/src/nested/deep.ts']);
    expect(setQuerySelection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'recursive-folder',
        folderId: 'folder-id',
        rootPath: '/root/src',
        coveredDirectoryPaths: ['/root', '/root/src', '/root/src/nested'],
        includeFilters: [],
        excludeFilters: [],
        includedPaths: [],
        excludedPaths: [],
        manifestSnapshotId: null,
        useRegex: false,
        totalSelectedCount: 2,
      }),
      expect.objectContaining({
        filePaths: ['/root/src/main.ts', '/root/src/nested/deep.ts'],
        snapshotId: null,
        status: 'ready',
      }),
      new Set(['/root/src/main.ts', '/root/src/nested/deep.ts'])
    );
    expect(addMultipleSelectedFiles).not.toHaveBeenCalled();
  });

  it('commits a partially restored folder selection through query mode when the current selection is entirely inside that folder', async () => {
    const root = createDirectory({
      path: '/root/src',
      loadState: 'unloaded',
      children: [],
    });
    const setQuerySelection = vi.fn();
    mockStoreState = {
      setQuerySelection,
    };
    const fileSystemAdapter = createMockAdapter({
      '/root/src': [
        createFile({ name: 'main.ts', path: '/root/src/main.ts', depth: 1 }),
        createDirectory({
          name: 'nested',
          path: '/root/src/nested',
          depth: 1,
          loadState: 'unloaded',
          children: [],
        }),
      ],
      '/root/src/nested': [
        createFile({ name: 'deep.ts', path: '/root/src/nested/deep.ts', depth: 2 }),
      ],
    });

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 10, 2, 2)
    );

    expect(selectionResult.success).toBe(true);
    expect(setQuerySelection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'recursive-folder',
        folderId: 'folder-id',
        rootPath: '/root/src',
        totalSelectedCount: 2,
      }),
      expect.objectContaining({
        filePaths: ['/root/src/main.ts', '/root/src/nested/deep.ts'],
        status: 'ready',
      }),
      new Set(['/root/src/main.ts', '/root/src/nested/deep.ts'])
    );
    expect(addMultipleSelectedFiles).not.toHaveBeenCalled();
  });

  it('applies filterTreeFn to adapter-loaded nodes', async () => {
    const root = createDirectory({
      path: '/root/src',
      loadState: 'unloaded',
      children: [],
    });
    const fileSystemAdapter = createMockAdapter({
      '/root/src': [
        createFile({ name: 'keep.ts', path: '/root/src/keep.ts', depth: 1 }),
        createFile({ name: 'skip.md', path: '/root/src/skip.md', depth: 1 }),
      ],
    });

    const filterTreeFn = vi.fn((nodes: IFileNode[]): IFileNode[] =>
      nodes.filter((node) => (node.type === 'directory' ? true : node.path.endsWith('.ts')))
    );

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        filterTreeFn,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 10, 0)
    );

    expect(filterTreeFn).toHaveBeenCalled();
    expect(selectionResult.filePaths).toEqual(['/root/src/keep.ts']);
  });

  it('blocks concurrent recursive folder selection operations', async () => {
    const root = createDirectory({
      path: '/root/src',
      loadState: 'unloaded',
      children: [],
    });
    let resolveRead: (() => void) | null = null;
    const fileSystemAdapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(
        () =>
          new Promise<IFileNode[]>((resolve) => {
            resolveRead = () => {
              resolve([createFile({ name: 'done.ts', path: '/root/src/done.ts', depth: 1 })]);
            };
          })
      ),
      readFile: vi.fn(),
      exists: vi.fn(),
    } as unknown as FileSystemAdapter;

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    act(() => {
      void result.current.selectFolderRecursively(
        root,
        'folder-id',
        addMultipleSelectedFiles,
        10,
        0
      );
    });

    const secondResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 10, 0)
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

  it('cancels in-flight recursive folder selection', async () => {
    const root = createDirectory({
      path: '/root/src',
      loadState: 'unloaded',
      children: [],
    });
    let resolveRead: (() => void) | null = null;
    const fileSystemAdapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(
        () =>
          new Promise<IFileNode[]>((resolve) => {
            resolveRead = () => {
              resolve([createFile({ name: 'done.ts', path: '/root/src/done.ts', depth: 1 })]);
            };
          })
      ),
      readFile: vi.fn(),
      exists: vi.fn(),
    } as unknown as FileSystemAdapter;
    const cancelLoadOperations = vi.fn();

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        cancelLoadOperations,
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
      })
    );

    let selectionPromise:
      | Promise<Awaited<ReturnType<typeof result.current.selectFolderRecursively>>>
      | undefined;

    act(() => {
      selectionPromise = result.current.selectFolderRecursively(
        root,
        'folder-id',
        addMultipleSelectedFiles,
        10,
        0
      );
    });

    await waitFor(() => {
      expect(result.current.isLoadingForSelectionRef.current).toBe(true);
      expect(result.current.loadingPath).toBe('/root/src');
    });

    act(() => {
      result.current.cancelRecursiveSelect();
      resolveRead?.();
    });

    const selectionResult = await act(async () => selectionPromise!);

    expect(cancelLoadOperations).toHaveBeenCalled();
    expect(selectionResult.cancelled).toBe(true);
    expect(selectionResult.success).toBe(false);
    expect(selectionResult.error).toBeUndefined();
  });

  it('routes a foreign-root recursive selection through explicit selection, never query mode', async () => {
    // Forest mode: the focused root is root-a; the clicked directory belongs
    // to root-b. Query-mode selection writes the TOP-LEVEL selection model
    // (the focused root's), so a foreign target must use explicit selection
    // (the store mutators route foreign keys into that root's folderState).
    const root = createDirectory({
      path: '/project-b/src',
      loadState: 'unloaded',
      children: [],
      rootFolderId: 'root-b',
    });
    const setQuerySelection = vi.fn();
    mockStoreState = {
      setQuerySelection,
      currentFolderId: 'root-a',
    };
    const fileSystemAdapter = createMockAdapter({
      '/project-b/src': [
        createFile({ name: 'b.ts', path: '/project-b/src/b.ts', depth: 1, rootFolderId: 'root-b' }),
      ],
    });

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: () => undefined,
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'root-b', addMultipleSelectedFiles, 10, 0)
    );

    expect(selectionResult.success).toBe(true);
    expect(selectionResult.filePaths).toEqual(['/project-b/src/b.ts']);
    expect(setQuerySelection).not.toHaveBeenCalled();
    expect(addMultipleSelectedFiles).toHaveBeenCalledWith('root-b', ['/project-b/src/b.ts']);
  });

  it('still commits through query mode when the target IS the focused root', async () => {
    const root = createDirectory({
      path: '/project-b/src',
      loadState: 'unloaded',
      children: [],
      rootFolderId: 'root-b',
    });
    const setQuerySelection = vi.fn();
    mockStoreState = {
      setQuerySelection,
      currentFolderId: 'root-b',
    };
    const fileSystemAdapter = createMockAdapter({
      '/project-b/src': [
        createFile({ name: 'b.ts', path: '/project-b/src/b.ts', depth: 1, rootFolderId: 'root-b' }),
      ],
    });

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'root-b', addMultipleSelectedFiles, 10, 0)
    );

    expect(selectionResult.success).toBe(true);
    expect(setQuerySelection).toHaveBeenCalled();
    expect(addMultipleSelectedFiles).not.toHaveBeenCalled();
  });

  it('shows a toast when the folder has no selectable files (filtered to zero)', async () => {
    // The historical failure mode: workspace include filters (e.g. *.ts) make
    // a folder of .html files scan to ZERO matches — the checkbox click must
    // never be a silent no-op.
    const root = createDirectory({
      path: '/root/html-only',
      loadState: 'unloaded',
      children: [],
    });
    const fileSystemAdapter = createMockAdapter({
      '/root/html-only': [createFile({ name: 'index.html', path: '/root/html-only/index.html' })],
    });

    // includeFilters come from the store selector mock — set BEFORE render.
    mockStoreState = { includeFilters: ['**/*.ts'], excludeFilters: [] };

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 10, 0)
    );

    expect(selectionResult.success).toBe(true);
    expect(selectionResult.filePaths).toEqual([]);
    expect(addMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('No selectable files') })
    );
  });

  it('respects DISABLED filter toggles: a toggled-off include filter no longer restricts the scan', async () => {
    // "Switch to all files" via filter toggles must reach the scans — they
    // previously read the RAW filter lists and kept filtering.
    const root = createDirectory({
      path: '/root/html-only',
      loadState: 'unloaded',
      children: [],
    });
    const fileSystemAdapter = createMockAdapter({
      '/root/html-only': [createFile({ name: 'index.html', path: '/root/html-only/index.html' })],
    });
    mockStoreState = {
      includeFilters: ['**/*.ts'],
      excludeFilters: [],
      disabledIncludeFilters: new Set(['**/*.ts']),
      currentFolderId: 'folder-id',
    };

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 10, 0)
    );

    expect(selectionResult.success).toBe(true);
    expect(selectionResult.filePaths).toEqual(['/root/html-only/index.html']);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('shows a toast when the selection limit blocks the folder selection', async () => {
    const root = createDirectory({ path: '/root/src', loadState: 'unloaded', children: [] });
    const fileSystemAdapter = createMockAdapter({});

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    // currentSelectionSize === maxSelectionCount → zero slots.
    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 10, 10)
    );

    expect(selectionResult.success).toBe(true);
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('Selection limit') })
    );
  });

  it('surfaces adapter errors through onError', async () => {
    const root = createDirectory({
      path: '/root/src',
      loadState: 'unloaded',
      children: [],
    });
    const fileSystemAdapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(async () => {
        throw new Error('Load failed');
      }),
      readFile: vi.fn(),
      exists: vi.fn(),
    } as unknown as FileSystemAdapter;

    const { result } = renderHook(() =>
      useRecursiveFolderSelect({
        fileSystemAdapter,
        getSubtreeByPath: (path) => findNodeByPath(root, path),
        onError,
      })
    );

    const selectionResult = await act(async () =>
      result.current.selectFolderRecursively(root, 'folder-id', addMultipleSelectedFiles, 10, 0)
    );

    expect(selectionResult.success).toBe(false);
    expect(selectionResult.error).toBe('Load failed');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Load failed' }));
  });
});
