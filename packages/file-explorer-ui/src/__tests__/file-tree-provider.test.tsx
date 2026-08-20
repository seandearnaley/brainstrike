import '@testing-library/jest-dom/vitest';
import type {
  FileExplorerState,
  FolderState,
  IFileNode,
  QuerySelectionManifest,
  SelectionModel,
} from '@brainstrike/types';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileExplorerRefreshEvent } from '../shell/file-explorer-refresh-event';
import {
  FileTreeProvider,
  useFileTreeContext,
  useFileTreeIndexContext,
  useOptionalFileTreeContext,
  useOptionalFileTreeIndexContext,
  useOptionalFileTreeNormalizedContext,
} from '../tree/file-tree-provider';
import type { FileTreeRefreshResult } from '../tree/use-lazy-file-tree';
import { createNormalizedFileTreeState } from '../utils/normalized-file-tree';

const {
  addNodesMock,
  clearFolderMock,
  clearMock,
  getHandleMock,
  getNodeMock,
  getSelectionAncestorDirectoriesMock,
  reconcileSelectionWithDirectorySnapshotMock,
  reconcileSelectionWithDirectorySnapshotsMock,
  setExpandedPathsMock,
  storeMock,
  useExpandSelectedFileParentDirectoriesMock,
  useExpandedPathRestorationMock,
  useFileTreeMock,
} = vi.hoisted(() => ({
  addNodesMock: vi.fn(),
  clearFolderMock: vi.fn(),
  clearMock: vi.fn(),
  getHandleMock: vi.fn(),
  getNodeMock: vi.fn(),
  getSelectionAncestorDirectoriesMock: vi.fn(),
  reconcileSelectionWithDirectorySnapshotMock: vi.fn(),
  reconcileSelectionWithDirectorySnapshotsMock: vi.fn(),
  setExpandedPathsMock: vi.fn(),
  storeMock: vi.fn(),
  useExpandedPathRestorationMock: vi.fn(),
  useExpandSelectedFileParentDirectoriesMock: vi.fn(),
  useFileTreeMock: vi.fn(),
}));

vi.mock('@brainstrike/file-explorer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer')>();
  return {
    ...actual,
    getSelectionAncestorDirectories: getSelectionAncestorDirectoriesMock,
  };
});

vi.mock('../shell/file-explorer-provider', () => ({
  useFileExplorerStoreContext: () => storeMock,
  useFileExplorerStoreSelector: (
    selector: (state: {
      selectionVersion: number;
      setExpandedPaths: typeof setExpandedPathsMock;
    }) => unknown
  ) =>
    selector({
      selectionVersion: 0,
      setExpandedPaths: setExpandedPathsMock,
    }),
}));

vi.mock('../use-expanded-path-restoration', () => ({
  useExpandedPathRestoration: useExpandedPathRestorationMock,
  useExpandSelectedFileParentDirectories: useExpandSelectedFileParentDirectoriesMock,
}));

vi.mock('../tree/use-file-tree-context', () => ({
  useFileTree: useFileTreeMock,
}));

vi.mock('../tree/file-tree-index', () => ({
  FileTreeIndex: class {
    public stats = {
      totalDirectories: 1,
      totalFiles: 2,
      totalNodes: 3,
    };

    public addNodes = addNodesMock;
    public clear = clearMock;
    public clearFolder = clearFolderMock;
    public getHandle = getHandleMock;
    public getNode = getNodeMock;
  },
}));

const rootHandle = {
  _internal: undefined,
  kind: 'directory',
  name: 'workspace',
  path: '/workspace',
  platform: 'electron',
} as const;

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createManifest(filePaths: string[]): QuerySelectionManifest {
  return {
    directoryCounts: new Map([['/workspace/src', filePaths.length]]),
    errorMessage: null,
    filePaths,
    fingerprint: 'stable-fingerprint',
    pathSet: new Set(filePaths),
    snapshotId: 'stable-snapshot',
    status: 'ready',
  };
}

function createQuerySelectionModel(rootId: string): SelectionModel {
  return {
    explicitPaths: new Set<string>(),
    materializedAt: null,
    materializedPaths: null,
    mode: 'query',
    queryDescriptor: {
      coveredDirectoryPaths: ['/workspace/src'],
      excludedPaths: [],
      excludeFilters: [],
      folderId: rootId,
      includedPaths: [],
      includeFilters: ['**/*.ts'],
      kind: 'recursive-select-all',
      manifestFingerprint: 'stable-fingerprint',
      manifestSnapshotId: 'stable-snapshot',
      rootPath: null,
      totalSelectedCount: 1,
      useRegex: false,
    },
  };
}

function Consumer(): ReactNode {
  const treeContext = useFileTreeContext();
  const optionalTreeContext = useOptionalFileTreeContext();
  const indexContext = useFileTreeIndexContext();
  const optionalIndexContext = useOptionalFileTreeIndexContext();
  const normalizedContext = useOptionalFileTreeNormalizedContext();

  return (
    <div>
      <div data-testid="root-path">{treeContext.rootDirectoryHandle?.path ?? 'none'}</div>
      <div data-testid="restoring">{String(treeContext.isRestoringExpandedPaths)}</div>
      <div data-testid="settled">{String(treeContext.isRestorationSettled)}</div>
      <div data-testid="optional-tree">{optionalTreeContext ? 'present' : 'missing'}</div>
      <div data-testid="optional-index">{optionalIndexContext ? 'present' : 'missing'}</div>
      <div data-testid="index-version">{String(indexContext.version)}</div>
      <div data-testid="normalized-version">{String(normalizedContext?.version ?? -1)}</div>
    </div>
  );
}

describe('FileTreeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(storeMock, {
      getState: () => ({
        currentFolderId: null,
        folderStates: {},
        querySelectionManifest: null,
        reconcileSelectionWithDirectorySnapshot: reconcileSelectionWithDirectorySnapshotMock,
        reconcileSelectionWithDirectorySnapshots: reconcileSelectionWithDirectorySnapshotsMock,
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit' as const,
          queryDescriptor: null,
        },
        selectionVersion: 0,
      }),
    });
    getNodeMock.mockReturnValue(undefined);
    getHandleMock.mockReturnValue(undefined);
    getSelectionAncestorDirectoriesMock.mockReturnValue([]);
    useFileTreeMock.mockReturnValue({
      __internalNormalizedTreeVersion: 7,
      cancelChildLoading: vi.fn(),
      cancelExpandAll: vi.fn(),
      cancellable: false,
      cancelOperation: vi.fn(),
      cancelRecursiveSelect: vi.fn(),
      cancelSelectAll: vi.fn(),
      error: null,
      expandAllProgress: null,
      expandAllProgressively: vi.fn(),
      fileTree: [],
      isCancelling: false,
      isExpandingAll: false,
      isLoading: false,
      isLoadingForSelectAll: false,
      isLoadingForSelection: false,
      loadChildren: vi.fn(),
      loadingPathForSelection: null,
      loadingPaths: new Set<string>(),
      loadingProgress: { isInitialLoading: false, loadingCount: 0 },
      loadSpecificPaths: vi.fn(),
      refreshDirectory: vi.fn(),
      refreshTree: vi.fn(),
      selectAllRecursively: vi.fn(),
      selectFolderRecursively: vi.fn(),
      workerPortRef: { current: null },
    });
    useExpandedPathRestorationMock.mockReturnValue({
      isRestorationSettled: true,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
    });
  });

  it('wires store state, restoration state, and index callbacks through the provider', async () => {
    const filterTreeFn = vi.fn((tree: IFileNode[]) => tree);
    const { rerender } = render(
      <FileTreeProvider filterTreeFn={filterTreeFn} rootDirectoryHandle={rootHandle}>
        <Consumer />
      </FileTreeProvider>
    );

    expect(useFileTreeMock).toHaveBeenCalledWith(
      rootHandle,
      expect.objectContaining({
        filterTreeFn,
        onNodesIndexed: expect.any(Function),
      })
    );
    expect(useExpandedPathRestorationMock).toHaveBeenCalledWith({
      currentRootFolderId: '/workspace',
      currentRootPath: '/workspace',
      disabled: false,
      fileTree: [],
      isTreeLoading: false,
      loadSpecificPaths: expect.any(Function),
      restorationKey: '/workspace',
      setExpandedPaths: setExpandedPathsMock,
      store: storeMock,
    });

    // Phase 6: mount REGISTERS the folder (refcounted) — nothing clears yet.
    expect(clearFolderMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();

    const options = useFileTreeMock.mock.calls[0]?.[1];
    expect(options).toBeDefined();

    act(() => {
      options?.onNodesIndexed?.([], null);
    });

    await waitFor(() => {
      expect(addNodesMock).toHaveBeenCalledWith([], null);
      // Bumps are microtask-coalesced: registration + onNodesIndexed may land
      // as one increment — assert the version ADVANCED, not an exact count.
      expect(screen.getByTestId('index-version')).not.toHaveTextContent('0');
    });

    expect(screen.getByTestId('root-path')).toHaveTextContent('/workspace');
    expect(screen.getByTestId('restoring')).toHaveTextContent('false');
    expect(screen.getByTestId('settled')).toHaveTextContent('true');
    expect(screen.getByTestId('optional-tree')).toHaveTextContent('present');
    expect(screen.getByTestId('optional-index')).toHaveTextContent('present');
    expect(screen.getByTestId('normalized-version')).toHaveTextContent('7');

    rerender(
      <FileTreeProvider
        rootDirectoryHandle={{
          ...rootHandle,
          path: '/workspace-next',
        }}
      >
        <Consumer />
      </FileTreeProvider>
    );

    // Phase 6: identity change releases the OLD folder; as the only
    // registrant, its entries clear via clearFolder (never a full clear()).
    await waitFor(() => {
      expect(clearFolderMock).toHaveBeenCalledWith('/workspace');
    });
    expect(clearMock).not.toHaveBeenCalled();

    expect(useExpandedPathRestorationMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        currentRootFolderId: '/workspace-next',
      })
    );
  });

  it('forwards the rootId UUID to the lazy tree hook so nodes carry the durable identity', () => {
    // Storage v5 linchpin: the lazy tree hook reads options.rootId and stamps
    // it onto every node as rootFolderId. Restoration keys by the same UUID.
    const ROOT_UUID = 'd4e516c5-e91e-4b1d-89ed-cb01cbfec159';
    render(
      <FileTreeProvider rootDirectoryHandle={rootHandle} rootId={ROOT_UUID}>
        <Consumer />
      </FileTreeProvider>
    );

    expect(useFileTreeMock).toHaveBeenCalledWith(
      rootHandle,
      expect.objectContaining({ rootId: ROOT_UUID })
    );
    expect(useExpandedPathRestorationMock).toHaveBeenCalledWith(
      expect.objectContaining({ currentRootFolderId: ROOT_UUID })
    );
  });

  it('reconciles selection from the authoritative directory snapshot using durable root identity', () => {
    const rootId = 'd4e516c5-e91e-4b1d-89ed-cb01cbfec159';
    render(
      <FileTreeProvider rootDirectoryHandle={rootHandle} rootId={rootId}>
        <Consumer />
      </FileTreeProvider>
    );
    const options = useFileTreeMock.mock.calls[0]?.[1];
    const entries = [
      {
        children: undefined,
        depth: 0,
        handle: {} as FileSystemFileHandle,
        name: 'keep.ts',
        path: '/workspace/keep.ts',
        rootFolderId: rootId,
        selectionState: 'unchecked' as const,
        type: 'file' as const,
      },
    ];

    act(() => {
      options?.onRootRefreshSnapshot?.(rootId, '/workspace', entries);
    });

    expect(reconcileSelectionWithDirectorySnapshotMock).toHaveBeenCalledWith(
      rootId,
      '/workspace',
      entries
    );
  });

  it('routes a late same-path root-switch snapshot by its authoritative rootId', () => {
    const firstRootId = 'first-root-id';
    const secondRootId = 'second-root-id';
    const { rerender } = render(
      <FileTreeProvider rootDirectoryHandle={rootHandle} rootId={firstRootId}>
        <Consumer />
      </FileTreeProvider>
    );
    const staleSnapshotCallback = useFileTreeMock.mock.calls[0]?.[1]?.onRootRefreshSnapshot;

    rerender(
      <FileTreeProvider rootDirectoryHandle={rootHandle} rootId={secondRootId}>
        <Consumer />
      </FileTreeProvider>
    );
    reconcileSelectionWithDirectorySnapshotMock.mockClear();
    const entries: IFileNode[] = [];

    act(() => {
      staleSnapshotCallback?.(secondRootId, rootHandle.path, entries);
    });

    expect(reconcileSelectionWithDirectorySnapshotMock).toHaveBeenCalledExactlyOnceWith(
      secondRootId,
      rootHandle.path,
      entries
    );
  });

  it('keeps a sequential watcher snapshot batch bound to the root that started it', async () => {
    const firstRootId = 'first-root-id';
    const secondRootId = 'second-root-id';
    const srcPath = `${rootHandle.path}/src`;
    const testPath = `${rootHandle.path}/test`;
    const directoryNode = (path: string): IFileNode => ({
      children: [],
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'loaded',
      name: path.split('/').at(-1) ?? path,
      path,
      rootFolderId: firstRootId,
      selectionState: 'unchecked',
      type: 'directory',
    });
    const normalizedTreeRef = {
      current: createNormalizedFileTreeState([directoryNode(srcPath), directoryNode(testPath)]),
    };
    const secondReadGate = createDeferred<void>();
    const refreshDirectory = vi.fn(async (path: string) => {
      if (path === testPath) {
        await secondReadGate.promise;
      }
      return { directoryPath: path, entries: [] };
    });
    const baseFileTreeState = useFileTreeMock();
    useFileTreeMock.mockClear();
    useFileTreeMock.mockReturnValue({
      ...baseFileTreeState,
      __internalNormalizedTreeRef: normalizedTreeRef,
      refreshDirectory,
      refreshTree: vi.fn().mockResolvedValue({ status: 'completed' as const }),
    });

    const { rerender } = render(
      <FileTreeProvider rootDirectoryHandle={rootHandle} rootId={firstRootId}>
        <Consumer />
      </FileTreeProvider>
    );
    await act(async () => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [
                { kind: 'file', path: `${srcPath}/gone.ts`, type: 'removed' },
                { kind: 'file', path: `${testPath}/gone.test.ts`, type: 'removed' },
              ],
              rootId: firstRootId,
              rootPath: rootHandle.path,
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(2));

    rerender(
      <FileTreeProvider rootDirectoryHandle={rootHandle} rootId={secondRootId}>
        <Consumer />
      </FileTreeProvider>
    );
    secondReadGate.resolve();

    await waitFor(() => expect(reconcileSelectionWithDirectorySnapshotsMock).toHaveBeenCalled());
    expect(reconcileSelectionWithDirectorySnapshotsMock).toHaveBeenCalledExactlyOnceWith(
      firstRootId,
      [
        { directoryPath: srcPath, entries: [] },
        { directoryPath: testPath, entries: [] },
      ]
    );
  });

  it('revalidates selected ancestors when the outer provider is refreshed directly', async () => {
    const rootId = 'd4e516c5-e91e-4b1d-89ed-cb01cbfec159';
    const srcPath = `${rootHandle.path}/src`;
    const nestedPath = `${srcPath}/nested`;
    const nestedNode: IFileNode = {
      children: [],
      depth: 1,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'unloaded',
      name: 'nested',
      path: nestedPath,
      rootFolderId: rootId,
      selectionState: 'unchecked',
      type: 'directory',
    };
    const srcNode: IFileNode = {
      ...nestedNode,
      children: [nestedNode],
      depth: 0,
      name: 'src',
      path: srcPath,
    };
    const normalizedTreeRef = {
      current: createNormalizedFileTreeState([srcNode]),
    };
    const rawRefreshTree = vi.fn().mockResolvedValue({ status: 'completed' as const });
    const refreshDirectory = vi.fn(async (path: string) => ({
      directoryPath: path,
      entries: path === srcPath ? [nestedNode] : [],
    }));
    const baseFileTreeState = useFileTreeMock();
    useFileTreeMock.mockClear();
    useFileTreeMock.mockReturnValue({
      ...baseFileTreeState,
      __internalNormalizedTreeRef: normalizedTreeRef,
      refreshDirectory,
      refreshTree: rawRefreshTree,
    });
    getSelectionAncestorDirectoriesMock.mockReturnValue([srcPath, nestedPath]);
    let refreshFromContext: ReturnType<typeof useFileTreeContext>['refreshTree'] | null = null;
    function RefreshProbe(): null {
      refreshFromContext = useFileTreeContext().refreshTree;
      return null;
    }
    render(
      <FileTreeProvider rootDirectoryHandle={rootHandle} rootId={rootId}>
        <RefreshProbe />
      </FileTreeProvider>
    );

    if (!refreshFromContext) {
      throw new Error('Expected the provider refresh dispatcher');
    }
    await act(async () => {
      await refreshFromContext?.();
    });

    expect(rawRefreshTree).toHaveBeenCalledOnce();
    expect(refreshDirectory.mock.calls.map(([path]) => path)).toEqual([srcPath, nestedPath]);
    expect(reconcileSelectionWithDirectorySnapshotsMock).toHaveBeenCalledExactlyOnceWith(rootId, [
      { directoryPath: srcPath, entries: [nestedNode] },
      { directoryPath: nestedPath, entries: [] },
    ]);
  });

  it('serializes direct manual refresh with watcher refresh before exposing a new selection', async () => {
    const rootId = 'd4e516c5-e91e-4b1d-89ed-cb01cbfec159';
    const srcPath = `${rootHandle.path}/src`;
    const newFilePath = `${srcPath}/new.ts`;
    const srcNode: IFileNode = {
      children: [],
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'loaded',
      name: 'src',
      path: srcPath,
      rootFolderId: rootId,
      selectionState: 'unchecked',
      type: 'directory',
    };
    const newFile: IFileNode = {
      depth: 1,
      handle: {} as FileSystemFileHandle,
      isVisible: true,
      name: 'new.ts',
      path: newFilePath,
      rootFolderId: rootId,
      selectionState: 'checked',
      type: 'file',
    };
    const normalizedTreeRef = {
      current: createNormalizedFileTreeState([srcNode]),
    };
    const manualReadGate = createDeferred<void>();
    let selectedNewFile = false;
    let selectedPaths = new Set<string>();
    let selectionVersion = 0;
    const refreshDirectory = vi.fn(async (path: string) => {
      if (refreshDirectory.mock.calls.length === 1) {
        await manualReadGate.promise;
        return { directoryPath: path, entries: [] };
      }
      selectedNewFile = true;
      selectedPaths = new Set([`${rootId}|@|${newFilePath}`]);
      selectionVersion += 1;
      return { directoryPath: path, entries: [newFile] };
    });
    reconcileSelectionWithDirectorySnapshotsMock.mockImplementation(
      (_folderId: string, snapshots: readonly { entries: readonly IFileNode[] }[]) => {
        if (selectedNewFile && !snapshots.some(({ entries }) => entries.includes(newFile))) {
          selectedNewFile = false;
        }
      }
    );
    Object.assign(storeMock, {
      getState: () => ({
        currentFolderId: rootId,
        folderStates: {},
        querySelectionManifest: null,
        reconcileSelectionWithDirectorySnapshot: reconcileSelectionWithDirectorySnapshotMock,
        reconcileSelectionWithDirectorySnapshots: reconcileSelectionWithDirectorySnapshotsMock,
        selectedFilePaths: selectedPaths,
        selectionModel: {
          explicitPaths: selectedPaths,
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit' as const,
          queryDescriptor: null,
        },
        selectionVersion,
      }),
    });
    const baseFileTreeState = useFileTreeMock();
    useFileTreeMock.mockClear();
    useFileTreeMock.mockReturnValue({
      ...baseFileTreeState,
      __internalNormalizedTreeRef: normalizedTreeRef,
      refreshDirectory,
      refreshTree: vi.fn().mockResolvedValue({ status: 'completed' as const }),
    });
    getSelectionAncestorDirectoriesMock.mockReturnValue([srcPath]);
    let refreshFromContext: ReturnType<typeof useFileTreeContext>['refreshTree'] | null = null;
    function RefreshProbe(): null {
      refreshFromContext = useFileTreeContext().refreshTree;
      return null;
    }
    render(
      <FileTreeProvider rootDirectoryHandle={rootHandle} rootId={rootId}>
        <RefreshProbe />
      </FileTreeProvider>
    );

    let manualRefresh: Promise<FileTreeRefreshResult> = Promise.resolve({ status: 'completed' });
    act(() => {
      manualRefresh = refreshFromContext?.() ?? manualRefresh;
    });
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledOnce());
    await act(async () => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: newFilePath, type: 'added' }],
              rootId,
              rootPath: rootHandle.path,
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });
    await act(async () => Promise.resolve());
    const watcherStartedBeforeManualSettled = refreshDirectory.mock.calls.length > 1;

    manualReadGate.resolve();
    await act(async () => {
      await manualRefresh;
    });
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(2));
    await act(async () => Promise.resolve());

    expect(watcherStartedBeforeManualSettled).toBe(false);
    expect(reconcileSelectionWithDirectorySnapshotsMock).toHaveBeenCalledOnce();
    expect(selectedNewFile).toBe(true);
  });

  it('returns cancelled when the direct refresh authority unmounts during its root read', async () => {
    const rawRefreshGate = createDeferred<FileTreeRefreshResult>();
    const rawRefreshTree = vi.fn(() => rawRefreshGate.promise);
    const baseFileTreeState = useFileTreeMock();
    useFileTreeMock.mockClear();
    useFileTreeMock.mockReturnValue({
      ...baseFileTreeState,
      refreshTree: rawRefreshTree,
    });
    let refreshFromContext: ReturnType<typeof useFileTreeContext>['refreshTree'] | null = null;
    function RefreshProbe(): null {
      refreshFromContext = useFileTreeContext().refreshTree;
      return null;
    }
    const { unmount } = render(
      <FileTreeProvider rootDirectoryHandle={rootHandle}>
        <RefreshProbe />
      </FileTreeProvider>
    );

    let refreshResult = Promise.resolve<FileTreeRefreshResult>({ status: 'completed' });
    act(() => {
      refreshResult = refreshFromContext?.() ?? refreshResult;
    });
    await waitFor(() => expect(rawRefreshTree).toHaveBeenCalledOnce());
    unmount();
    rawRefreshGate.resolve({ status: 'completed' });

    await expect(refreshResult).resolves.toEqual({ status: 'cancelled' });
  });

  it('preserves a raw cancelled refresh outcome while the provider remains active', async () => {
    const rawRefreshTree = vi.fn().mockResolvedValue({ status: 'cancelled' as const });
    const refreshDirectory = vi.fn();
    const baseFileTreeState = useFileTreeMock();
    useFileTreeMock.mockClear();
    useFileTreeMock.mockReturnValue({
      ...baseFileTreeState,
      refreshDirectory,
      refreshTree: rawRefreshTree,
    });
    getSelectionAncestorDirectoriesMock.mockReturnValue(['/workspace/src']);
    let refreshFromContext: ReturnType<typeof useFileTreeContext>['refreshTree'] | null = null;
    function RefreshProbe(): null {
      refreshFromContext = useFileTreeContext().refreshTree;
      return null;
    }
    render(
      <FileTreeProvider rootDirectoryHandle={rootHandle}>
        <RefreshProbe />
      </FileTreeProvider>
    );

    let refreshResult = Promise.resolve<FileTreeRefreshResult>({ status: 'completed' });
    act(() => {
      refreshResult = refreshFromContext?.() ?? refreshResult;
    });

    await expect(refreshResult).resolves.toEqual({ status: 'cancelled' });
    expect(refreshDirectory).not.toHaveBeenCalled();
  });

  it('discards a gated snapshot when query manifest paths change without selectionVersion', async () => {
    const rootId = 'query-root-id';
    const srcPath = `${rootHandle.path}/src`;
    const srcNode: IFileNode = {
      children: [],
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'loaded',
      name: 'src',
      path: srcPath,
      rootFolderId: rootId,
      selectionState: 'unchecked',
      type: 'directory',
    };
    const normalizedTreeRef = { current: createNormalizedFileTreeState([srcNode]) };
    const refreshGate = createDeferred<void>();
    const refreshDirectory = vi.fn(async (path: string) => {
      await refreshGate.promise;
      return { directoryPath: path, entries: [] };
    });
    let state = {
      currentFolderId: rootId,
      folderStates: {},
      querySelectionManifest: createManifest([`${srcPath}/old.ts`]),
      reconcileSelectionWithDirectorySnapshot: reconcileSelectionWithDirectorySnapshotMock,
      reconcileSelectionWithDirectorySnapshots: reconcileSelectionWithDirectorySnapshotsMock,
      selectedFilePaths: new Set<string>(),
      selectionModel: createQuerySelectionModel(rootId),
      selectionVersion: 0,
    } as unknown as FileExplorerState;
    Object.assign(storeMock, { getState: () => state });
    const baseFileTreeState = useFileTreeMock();
    useFileTreeMock.mockClear();
    useFileTreeMock.mockReturnValue({
      ...baseFileTreeState,
      __internalNormalizedTreeRef: normalizedTreeRef,
      refreshDirectory,
      refreshTree: vi.fn().mockResolvedValue({ status: 'completed' as const }),
    });
    render(
      <FileTreeProvider rootDirectoryHandle={rootHandle} rootId={rootId}>
        <Consumer />
      </FileTreeProvider>
    );

    await act(async () => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: `${srcPath}/gone.ts`, type: 'removed' }],
              rootId,
              rootPath: rootHandle.path,
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledOnce());
    state = {
      ...state,
      querySelectionManifest: createManifest([`${srcPath}/new.ts`]),
    };
    refreshGate.resolve();
    await act(async () => Promise.resolve());

    expect(reconcileSelectionWithDirectorySnapshotsMock).not.toHaveBeenCalled();
  });

  it('discards a gated snapshot when its foreign-root selection changes', async () => {
    const rootId = 'foreign-root-id';
    const srcPath = `${rootHandle.path}/src`;
    const srcNode: IFileNode = {
      children: [],
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'loaded',
      name: 'src',
      path: srcPath,
      rootFolderId: rootId,
      selectionState: 'unchecked',
      type: 'directory',
    };
    const normalizedTreeRef = { current: createNormalizedFileTreeState([srcNode]) };
    const refreshGate = createDeferred<void>();
    const refreshDirectory = vi.fn(async (path: string) => {
      await refreshGate.promise;
      return { directoryPath: path, entries: [] };
    });
    const createForeignFolderState = (path: string): FolderState =>
      ({
        selectedFilePaths: new Set([`${rootId}|@|${path}`]),
        selectionModel: {
          explicitPaths: new Set([`${rootId}|@|${path}`]),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
        },
      }) as FolderState;
    let state = {
      currentFolderId: 'focused-root-id',
      folderStates: { [rootId]: createForeignFolderState(`${srcPath}/old.ts`) },
      querySelectionManifest: null,
      reconcileSelectionWithDirectorySnapshot: reconcileSelectionWithDirectorySnapshotMock,
      reconcileSelectionWithDirectorySnapshots: reconcileSelectionWithDirectorySnapshotsMock,
      selectedFilePaths: new Set<string>(),
      selectionModel: createQuerySelectionModel('focused-root-id'),
      selectionVersion: 0,
    } as unknown as FileExplorerState;
    Object.assign(storeMock, { getState: () => state });
    const baseFileTreeState = useFileTreeMock();
    useFileTreeMock.mockClear();
    useFileTreeMock.mockReturnValue({
      ...baseFileTreeState,
      __internalNormalizedTreeRef: normalizedTreeRef,
      refreshDirectory,
      refreshTree: vi.fn().mockResolvedValue({ status: 'completed' as const }),
    });
    render(
      <FileTreeProvider rootDirectoryHandle={rootHandle} rootId={rootId}>
        <Consumer />
      </FileTreeProvider>
    );

    await act(async () => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: `${srcPath}/gone.ts`, type: 'removed' }],
              rootId,
              rootPath: rootHandle.path,
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledOnce());
    state = {
      ...state,
      folderStates: { [rootId]: createForeignFolderState(`${srcPath}/new.ts`) },
    };
    refreshGate.resolve();
    await act(async () => Promise.resolve());

    expect(reconcileSelectionWithDirectorySnapshotsMock).not.toHaveBeenCalled();
  });

  it('keeps FileTreeContext value identity stable across re-renders when deps are unchanged', () => {
    // Mount may re-render once for index registration (version bump); that must
    // NOT mint a new FileTreeContext value when fileTree/restoration/root deps
    // are unchanged.
    const seen: unknown[] = [];
    function ValueProbe(): null {
      seen.push(useFileTreeContext());
      return null;
    }

    const { rerender } = render(
      <FileTreeProvider rootDirectoryHandle={rootHandle}>
        <ValueProbe />
      </FileTreeProvider>
    );
    const afterMount = seen.at(-1);
    expect(afterMount).toBeDefined();
    const lengthAfterMount = seen.length;

    rerender(
      <FileTreeProvider rootDirectoryHandle={rootHandle}>
        <ValueProbe />
      </FileTreeProvider>
    );
    expect(seen.length).toBeGreaterThan(lengthAfterMount);
    expect(seen.at(-1)).toBe(afterMount);
  });

  it('throws for required hooks outside the provider and returns null for optional hooks', () => {
    expect(() => renderHook(() => useFileTreeContext())).toThrow(
      'useFileTreeContext must be used within a FileTreeProvider'
    );
    expect(() => renderHook(() => useFileTreeIndexContext())).toThrow(
      'useFileTreeIndexContext must be used within a FileTreeProvider'
    );

    const optionalTree = renderHook(() => useOptionalFileTreeContext());
    const optionalIndex = renderHook(() => useOptionalFileTreeIndexContext());
    const optionalNormalized = renderHook(() => useOptionalFileTreeNormalizedContext());

    expect(optionalTree.result.current).toBeNull();
    expect(optionalIndex.result.current).toBeNull();
    expect(optionalNormalized.result.current).toBeNull();
  });
});
