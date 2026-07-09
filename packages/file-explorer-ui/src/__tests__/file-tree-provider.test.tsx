import '@testing-library/jest-dom/vitest';
import type { IFileNode } from '@brainstrike/types';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileTreeProvider,
  useFileTreeContext,
  useFileTreeIndexContext,
  useOptionalFileTreeContext,
  useOptionalFileTreeIndexContext,
  useOptionalFileTreeNormalizedContext,
} from '../tree/file-tree-provider';

const {
  addNodesMock,
  clearFolderMock,
  clearMock,
  getHandleMock,
  getNodeMock,
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
  setExpandedPathsMock: vi.fn(),
  storeMock: vi.fn(),
  useExpandedPathRestorationMock: vi.fn(),
  useExpandSelectedFileParentDirectoriesMock: vi.fn(),
  useFileTreeMock: vi.fn(),
}));

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
    getNodeMock.mockReturnValue(undefined);
    getHandleMock.mockReturnValue(undefined);
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
