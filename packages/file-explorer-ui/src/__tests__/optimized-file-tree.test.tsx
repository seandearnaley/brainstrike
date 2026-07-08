import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import OptimizedFileTree, {
  fileTreeTelemetry,
  resetFileTreeTelemetry,
} from '../tree/optimized-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

type FileExplorerStore = ReturnType<typeof useFileExplorerStoreContext>;

function StoreHandleBridge({ onStoreReady }: { onStoreReady: (store: FileExplorerStore) => void }) {
  const store = useFileExplorerStoreContext();
  useEffect(() => {
    onStoreReady(store);
  }, [onStoreReady, store]);
  return null;
}

describe('OptimizedFileTree', () => {
  const mockFileTree: IFileNode[] = [
    {
      children: [
        {
          depth: 1,
          handle: {} as FileSystemFileHandle,
          isVisible: true,
          name: 'file1.txt',
          path: '/src/file1.txt',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
        {
          depth: 1,
          handle: {} as FileSystemFileHandle,
          isVisible: true,
          name: 'file2.txt',
          path: '/src/file2.txt',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
      ],
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      name: 'src',
      path: '/src',
      rootFolderId: 'root',
      selectionState: 'unchecked',
      type: 'directory',
    },
    {
      depth: 0,
      handle: {} as FileSystemFileHandle,
      isVisible: true,
      name: 'test.txt',
      path: '/test.txt',
      rootFolderId: 'root',
      selectionState: 'unchecked',
      type: 'file',
    },
  ];

  it('renders file tree container with correct attributes', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    const container = screen.getByTestId('file-tree-scroll-container');
    expect(container).toBeInTheDocument();
    expect(container).toHaveClass('h-full', 'relative', 'flex-1', 'min-h-0', 'overflow-y-auto');
  });

  it('renders file tree with correct role and label', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    const treeGrid = screen.getByRole('treegrid', { name: 'File tree' });
    expect(treeGrid).toBeInTheDocument();
  });

  it('opens a focused file row with keyboard activation', async () => {
    const openFileInTab = vi.fn();
    const uiModule = await import('@brainstrike/ui');
    const useIdeFileEditorSpy = vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
      openFileInTab,
      registerOpenFileInTab: vi.fn(),
    });
    const fileOnlyTree: IFileNode[] = [
      {
        depth: 0,
        handle: {} as FileSystemFileHandle,
        isVisible: true,
        name: 'test.txt',
        path: '/test.txt',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'file',
      },
    ];

    try {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={fileOnlyTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );

      const treeGrid = screen.getByRole('treegrid', { name: 'File tree' });
      fireEvent.keyDown(treeGrid, { key: 'ArrowDown' });
      fireEvent.keyDown(treeGrid, { key: 'Enter' });

      expect(openFileInTab).toHaveBeenCalledWith(encodeFileSelection('root', '/test.txt'));
    } finally {
      useIdeFileEditorSpy.mockRestore();
    }
  });

  it('deduplicates child-load requests when expand is retriggered during loading', async () => {
    let resolveLoad: (() => void) | undefined;
    const onLoadChildren = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );

    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree
          fileTree={mockFileTree}
          folderId="root"
          loadingFiles={new Set()}
          onLoadChildren={onLoadChildren}
        />
      </FileExplorerTestWrapper>
    );

    const expandButton = screen.getByRole('button', { name: /expand/i });
    fireEvent.click(expandButton);
    fireEvent.click(expandButton);

    expect(onLoadChildren).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoad?.();
      await Promise.resolve();
    });
  });

  it('does not materialize stale children when an expanded directory is not fully loaded', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;
    const loadedDirectoryNode: IFileNode = {
      children: [
        {
          depth: 1,
          handle: {} as FileSystemFileHandle,
          isVisible: true,
          name: 'stale-child.ts',
          path: '/workspace/stale-child.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
      ],
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'loaded',
      name: 'workspace',
      path: '/workspace',
      rootFolderId: 'root',
      selectionState: 'unchecked',
      type: 'directory',
    };
    const loadedDirectoryTree: IFileNode[] = [loadedDirectoryNode];
    const loadingDirectoryTree: IFileNode[] = [
      {
        ...loadedDirectoryNode,
        loadState: 'loading',
      },
    ];

    const { rerender } = render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree
          fileTree={loadedDirectoryTree}
          folderId="root"
          loadingFiles={new Set()}
        />
      </FileExplorerTestWrapper>
    );

    await act(async () => {
      await Promise.resolve();
    });
    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().toggleDirectoryExpansion('/workspace');
      await Promise.resolve();
    });
    expect(screen.getByText('stale-child.ts')).toBeInTheDocument();

    await act(async () => {
      rerender(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            fileTree={loadingDirectoryTree}
            folderId="root"
            loadingFiles={new Set()}
          />
        </FileExplorerTestWrapper>
      );
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /collapse/i })).toBeInTheDocument();
    expect(screen.queryByText('stale-child.ts')).not.toBeInTheDocument();
  });

  it('does not render an unloaded persisted directory as expanded before its children are restored', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;
    const unloadedTree: IFileNode[] = [
      {
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'apps',
        path: '/apps',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      },
    ];

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={unloadedTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().setExpandedPaths(new Set(['/apps']));
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /collapse/i })).not.toBeInTheDocument();
  });

  it('calls onRender callback when provided', async () => {
    const mockOnRender = vi.fn();

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            fileTree={mockFileTree}
            folderId="root"
            loadingFiles={new Set()}
            onRender={mockOnRender}
          />
        </FileExplorerTestWrapper>
      );
    });

    expect(mockOnRender).toHaveBeenCalled();
  });

  it('renders empty tree when fileTree is empty', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={[]} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByText('No data available')).toBeInTheDocument();
  });

  it('applies correct classes to tree container', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    const treeGrid = screen.getByRole('treegrid', { name: 'File tree' });
    expect(treeGrid).toHaveClass('file-tree');
  });

  it('renders with loading files set', async () => {
    const loadingFiles = new Set(['root:/src/file1.txt']);

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={loadingFiles} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('handles folderId changes', async () => {
    let rerenderFn: ReturnType<typeof render>['rerender'];

    await act(async () => {
      const result = render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
      rerenderFn = result.rerender;
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();

    await act(async () => {
      rerenderFn!(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="other" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('does not call onRender when not provided', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('handles fileTree updates', async () => {
    let rerenderFn: ReturnType<typeof render>['rerender'];

    await act(async () => {
      const result = render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
      rerenderFn = result.rerender;
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();

    const newFileTree: IFileNode[] = [
      {
        depth: 0,
        handle: {} as FileSystemFileHandle,
        isVisible: true,
        name: 'new-file.txt',
        path: '/new-file.txt',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'file',
      },
    ];

    await act(async () => {
      rerenderFn!(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={newFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('renders with invisible nodes filtered out', async () => {
    const treeWithInvisible: IFileNode[] = [
      {
        children: [
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            isVisible: false,
            name: 'invisible.txt',
            path: '/visible/invisible.txt',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        name: 'visible',
        path: '/visible',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      },
    ];

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            fileTree={treeWithInvisible}
            folderId="root"
            loadingFiles={new Set()}
          />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('handles nested directory structure', async () => {
    const nestedTree: IFileNode[] = [
      {
        children: [
          {
            children: [
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'deep-file.txt',
                path: '/level1/level2/deep-file.txt',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
            ],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            name: 'level2',
            path: '/level1/level2',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        name: 'level1',
        path: '/level1',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      },
    ];

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={nestedTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  describe('performance: columns stability', () => {
    it('should NOT rebuild columns when a file is selected', async () => {
      let fileExplorerStore: FileExplorerStore | null = null;

      await act(async () => {
        render(
          <StrictMode>
            <FileExplorerTestWrapper>
              <StoreHandleBridge
                onStoreReady={(store) => {
                  fileExplorerStore = store;
                }}
              />
              <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
            </FileExplorerTestWrapper>
          </StrictMode>
        );
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(fileExplorerStore).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
      const store = fileExplorerStore!;

      await act(async () => {
        store.getState().clearSelectedFiles();
        store.getState().setMaxSelectionCount(10);
        await Promise.resolve();
      });

      // Reset telemetry AFTER initial render settles
      resetFileTreeTelemetry();

      // Select a file via store (simulates clicking a checkbox)
      await act(async () => {
        store.getState().toggleSelectedFile('root', '/test.txt');
        await Promise.resolve();
      });

      // treeRows should NOT rebuild on selection change
      expect(fileTreeTelemetry.treeRowsRebuildCount).toBe(0);

      // columns should NOT rebuild on selection change — selection state
      // is delivered via FileTreeSelectionContext, not column closures
      expect(fileTreeTelemetry.columnsRebuildCount).toBe(0);
    });
  });

  describe('opening files via row click (VS Code semantics)', () => {
    it('clicking a file row opens it in a workspace tab', async () => {
      const uiModule = await import('@brainstrike/ui');
      const openFileInTab = vi.fn();
      vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
        openFileInTab,
        registerOpenFileInTab: vi.fn(),
      });

      await act(async () => {
        render(
          <FileExplorerTestWrapper>
            <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
          </FileExplorerTestWrapper>
        );
      });

      const fileLabel = await screen.findByText('test.txt');
      await act(async () => {
        fireEvent.click(fileLabel);
      });

      expect(openFileInTab).toHaveBeenCalledTimes(1);
      expect(openFileInTab).toHaveBeenCalledWith(encodeFileSelection('root', '/test.txt'));
    });

    it('clicking a directory row does NOT open a tab', async () => {
      const uiModule = await import('@brainstrike/ui');
      const openFileInTab = vi.fn();
      vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
        openFileInTab,
        registerOpenFileInTab: vi.fn(),
      });

      await act(async () => {
        render(
          <FileExplorerTestWrapper>
            <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
          </FileExplorerTestWrapper>
        );
      });

      const dirLabel = await screen.findByText('src');
      await act(async () => {
        fireEvent.click(dirLabel);
      });

      expect(openFileInTab).not.toHaveBeenCalled();
    });
  });
});
