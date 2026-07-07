/**
 * Phase 6 forest index sharing: nested FileTreeProviders (one per RootSection)
 * write into ONE shared FileTreeIndex owned by the outermost provider, so the
 * panel-level content loader can resolve nodes from EVERY root during a
 * cross-root import. Folder entries are refcounted: a focus switch on the
 * outer provider must not wipe a sibling root's entries, but the last
 * registrant of a folder (e.g. a disconnected root's section unmounting)
 * clears them.
 *
 * Uses the REAL FileTreeIndex (unlike file-tree-provider.test.tsx, which mocks
 * it) — the sharing semantics ARE the subject under test.
 */
import type { IFileNode } from '@brainstrike/types';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTreeProvider, useFileTreeIndexContext } from '../tree/file-tree-provider';

const {
  capturedOptionsByPath,
  setExpandedPathsMock,
  storeMock,
  useExpandSelectedFileParentDirectoriesMock,
  useExpandedPathRestorationMock,
  useFileTreeMock,
} = vi.hoisted(() => ({
  capturedOptionsByPath: new Map<
    string,
    { onNodesIndexed?: (nodes: IFileNode[], parentPath: string | null) => void }
  >(),
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

const ROOT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ROOT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ROOT_C = 'cccccccc-0000-4000-8000-00000000000c';

function makeHandle(path: string) {
  return {
    _internal: undefined,
    kind: 'directory',
    name: path.slice(1),
    path,
    platform: 'electron',
  } as const;
}

function makeFileNode(rootFolderId: string, path: string): IFileNode {
  return {
    depth: 0,
    handle: undefined,
    isVisible: true,
    name: path.split('/').pop() ?? path,
    path,
    rootFolderId,
    selectionState: 'unchecked',
    type: 'file',
  } as unknown as IFileNode;
}

/**
 * Probe rendered OUTSIDE the nested child provider — captures the OUTER
 * index's getNode for IMPERATIVE assertions. This mirrors the real consumer:
 * the content loader calls getNode at import time; index-version bumps from
 * CHILD providers deliberately do not re-render outer consumers.
 */
let outerGetNode: ((folderId: string, path: string) => IFileNode | undefined) | null = null;
function OuterIndexProbe(): ReactNode {
  outerGetNode = useFileTreeIndexContext().getNode;
  return null;
}

function baseTreeState() {
  return {
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
    loadChildren: vi.fn(),
    loadingFiles: new Set<string>(),
    loadingPaths: new Set<string>(),
    loadingProgress: null,
    loadSpecificPaths: vi.fn(),
    refreshDirectory: vi.fn(),
    selectAllRecursively: vi.fn(),
    selectFolderRecursively: vi.fn(),
  };
}

describe('forest FileTreeIndex sharing (Phase 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptionsByPath.clear();
    useExpandedPathRestorationMock.mockReturnValue({
      isRestorationSettled: true,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
    });
    useFileTreeMock.mockImplementation(
      (handle: { path?: string } | null, options: Record<string, unknown>) => {
        if (handle?.path) {
          capturedOptionsByPath.set(handle.path, options);
        }
        return baseTreeState();
      }
    );
  });

  function indexNodes(handlePath: string, nodes: IFileNode[]): void {
    const options = capturedOptionsByPath.get(handlePath);
    if (!options?.onNodesIndexed) {
      throw new Error(`No captured onNodesIndexed for ${handlePath}`);
    }
    act(() => {
      options.onNodesIndexed?.(nodes, null);
    });
  }

  it('nested provider writes resolve through the OUTER index context', () => {
    render(
      <FileTreeProvider rootDirectoryHandle={makeHandle('/a')} rootId={ROOT_A}>
        <FileTreeProvider rootDirectoryHandle={makeHandle('/b')} rootId={ROOT_B}>
          {null}
        </FileTreeProvider>
        <OuterIndexProbe />
      </FileTreeProvider>
    );

    indexNodes('/b', [makeFileNode(ROOT_B, 'src/b.ts')]);

    expect(outerGetNode?.(ROOT_B, 'src/b.ts')).toBeDefined();
  });

  it('outer identity change (focus switch) does NOT wipe a sibling root entries', () => {
    const { rerender } = render(
      <FileTreeProvider rootDirectoryHandle={makeHandle('/a')} rootId={ROOT_A}>
        <FileTreeProvider rootDirectoryHandle={makeHandle('/b')} rootId={ROOT_B}>
          {null}
        </FileTreeProvider>
        <OuterIndexProbe />
      </FileTreeProvider>
    );
    indexNodes('/b', [makeFileNode(ROOT_B, 'src/b.ts')]);

    // Focus switch: the OUTER provider's identity changes A → C.
    rerender(
      <FileTreeProvider rootDirectoryHandle={makeHandle('/c')} rootId={ROOT_C}>
        <FileTreeProvider rootDirectoryHandle={makeHandle('/b')} rootId={ROOT_B}>
          {null}
        </FileTreeProvider>
        <OuterIndexProbe />
      </FileTreeProvider>
    );

    expect(outerGetNode?.(ROOT_B, 'src/b.ts')).toBeDefined();
  });

  it('unmounting the child clears ITS folder from the shared index (last registrant)', () => {
    const { rerender } = render(
      <FileTreeProvider rootDirectoryHandle={makeHandle('/a')} rootId={ROOT_A}>
        <FileTreeProvider rootDirectoryHandle={makeHandle('/b')} rootId={ROOT_B}>
          {null}
        </FileTreeProvider>
        <OuterIndexProbe />
      </FileTreeProvider>
    );
    indexNodes('/b', [makeFileNode(ROOT_B, 'src/b.ts')]);
    expect(outerGetNode?.(ROOT_B, 'src/b.ts')).toBeDefined();

    // Disconnect root B: its section (and provider) unmounts.
    rerender(
      <FileTreeProvider rootDirectoryHandle={makeHandle('/a')} rootId={ROOT_A}>
        <OuterIndexProbe />
      </FileTreeProvider>
    );

    expect(outerGetNode?.(ROOT_B, 'src/b.ts')).toBeUndefined();
  });

  it('standalone provider still clears its OLD folder on identity change', () => {
    const { rerender } = render(
      <FileTreeProvider rootDirectoryHandle={makeHandle('/a')} rootId={ROOT_A}>
        <OuterIndexProbe />
      </FileTreeProvider>
    );
    indexNodes('/a', [makeFileNode(ROOT_A, 'src/a.ts')]);
    expect(outerGetNode?.(ROOT_A, 'src/a.ts')).toBeDefined();

    // Single-root workspace switch A → C: A's entries must clear.
    rerender(
      <FileTreeProvider rootDirectoryHandle={makeHandle('/c')} rootId={ROOT_C}>
        <OuterIndexProbe />
      </FileTreeProvider>
    );

    expect(outerGetNode?.(ROOT_A, 'src/a.ts')).toBeUndefined();
  });
});
