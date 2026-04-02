import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection, memoizedFileExplorer } from '@brainstrike/utils';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import OptimizedFileTree, {
  fileTreeTelemetry,
  resetFileTreeTelemetry,
} from '../optimized-file-tree';
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
      name: 'src',
      path: '/src',
      type: 'directory',
      isVisible: true,
      handle: {} as FileSystemDirectoryHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'root',
      children: [
        {
          name: 'file1.txt',
          path: '/src/file1.txt',
          type: 'file',
          isVisible: true,
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
        {
          name: 'file2.txt',
          path: '/src/file2.txt',
          type: 'file',
          isVisible: true,
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ],
    },
    {
      name: 'test.txt',
      path: '/test.txt',
      type: 'file',
      isVisible: true,
      handle: {} as FileSystemFileHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'root',
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
      name: 'workspace',
      path: '/workspace',
      type: 'directory',
      isVisible: true,
      handle: {} as FileSystemDirectoryHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'root',
      loadState: 'loaded',
      children: [
        {
          name: 'stale-child.ts',
          path: '/workspace/stale-child.ts',
          type: 'file',
          isVisible: true,
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ],
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

  it('updates visible file checkbox state after selection changes', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    const fileCheckbox = screen.getByLabelText('Select test.txt');
    expect(fileCheckbox).not.toBeChecked();

    await act(async () => {
      fireEvent.click(fileCheckbox);
    });
    expect(fileCheckbox).toBeChecked();
  });

  it('updates directory checkbox state as nested selections change', async () => {
    const loadedTree: IFileNode[] = [
      {
        name: 'src',
        path: '/src',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'loaded',
        children: [
          {
            name: 'file1.txt',
            path: '/src/file1.txt',
            type: 'file',
            isVisible: true,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
          {
            name: 'file2.txt',
            path: '/src/file2.txt',
            type: 'file',
            isVisible: true,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
        ],
      },
      {
        name: 'test.txt',
        path: '/test.txt',
        type: 'file',
        isVisible: true,
        handle: {} as FileSystemFileHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      },
    ];
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={loadedTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    const getDirectoryCheckbox = () => screen.getByLabelText('Select src');
    expect(getDirectoryCheckbox()).toHaveAttribute('data-state', 'unchecked');

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setMaxSelectionCount(10);
      await Promise.resolve();
    });

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file1.txt');
      await Promise.resolve();
    });
    expect(readyStore.getState().selectedFilePaths).toContain(
      encodeFileSelection('root', '/src/file1.txt')
    );
    expect(getDirectoryCheckbox()).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file2.txt');
      await Promise.resolve();
    });
    expect(getDirectoryCheckbox()).toHaveAttribute('data-state', 'checked');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file1.txt');
      await Promise.resolve();
    });
    expect(getDirectoryCheckbox()).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file2.txt');
      await Promise.resolve();
    });
    expect(getDirectoryCheckbox()).toHaveAttribute('data-state', 'unchecked');
  });

  it('does not recompute directory file counts on file-selection rerenders', async () => {
    const getFolderFileCountSpy = vi.spyOn(memoizedFileExplorer, 'getFolderFileCount');
    try {
      await act(async () => {
        render(
          <FileExplorerTestWrapper>
            <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
          </FileExplorerTestWrapper>
        );
      });

      const initialCallCount = getFolderFileCountSpy.mock.calls.length;
      const fileCheckbox = screen.getByLabelText('Select test.txt');

      await act(async () => {
        fireEvent.click(fileCheckbox);
      });
      await act(async () => {
        fireEvent.click(fileCheckbox);
      });

      expect(getFolderFileCountSpy.mock.calls.length).toBe(initialCallCount);
    } finally {
      getFolderFileCountSpy.mockRestore();
    }
  });

  it('keeps directory selection counts stable across StrictMode rerenders', async () => {
    const loadedTree: IFileNode[] = [
      {
        name: 'src',
        path: '/src',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'loaded',
        children: [
          {
            name: 'file1.txt',
            path: '/src/file1.txt',
            type: 'file',
            isVisible: true,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
          {
            name: 'file2.txt',
            path: '/src/file2.txt',
            type: 'file',
            isVisible: true,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
        ],
      },
    ];
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <StrictMode>
        <FileExplorerTestWrapper>
          <StoreHandleBridge
            onStoreReady={(store) => {
              fileExplorerStore = store;
            }}
          />
          <OptimizedFileTree fileTree={loadedTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      </StrictMode>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setMaxSelectionCount(10);
      await Promise.resolve();
    });

    const directoryCheckbox = screen.getByLabelText('Select src');
    expect(directoryCheckbox).toHaveAttribute('data-state', 'unchecked');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file1.txt');
      await Promise.resolve();
    });
    expect(directoryCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file2.txt');
      await Promise.resolve();
    });
    expect(directoryCheckbox).toHaveAttribute('data-state', 'checked');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file1.txt');
      readyStore.getState().toggleSelectedFile('root', '/src/file2.txt');
      await Promise.resolve();
    });
    expect(directoryCheckbox).toHaveAttribute('data-state', 'unchecked');
  });

  it('selects all unselected files in a directory when capacity allows', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
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
      readyStore.getState().setMaxSelectionCount(2);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });

    const selectedKeys = Array.from(readyStore.getState().selectedFilePaths);
    const selectedSourceFiles = selectedKeys.filter((key) => key.startsWith('root|@|/src/'));

    expect(selectedKeys).toHaveLength(2);
    expect(selectedSourceFiles).toHaveLength(2);
  });

  it('removes all files in a fully selected directory on second toggle', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
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
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setMaxSelectionCount(4);
      await Promise.resolve();
    });

    const getSelectedSourceFiles = (): string[] =>
      Array.from(readyStore.getState().selectedFilePaths).filter((key) =>
        key.startsWith('root|@|/src/')
      );

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });
    expect(getSelectedSourceFiles()).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });
    expect(getSelectedSourceFiles()).toHaveLength(0);
  });

  it('does not change selection when toggling an empty directory', async () => {
    const treeWithEmptyDirectory: IFileNode[] = [
      {
        name: 'empty',
        path: '/empty',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'loaded',
        children: [],
      },
    ];
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree
          fileTree={treeWithEmptyDirectory}
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

    expect(readyStore.getState().selectedFilePaths.size).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select empty'));
    });
    expect(readyStore.getState().selectedFilePaths.size).toBe(0);
  });

  it('uses recursive directory selection callback for unloaded folders', async () => {
    const onSelectFolderRecursively = vi.fn(async () => ({ success: true, filePaths: [] }));

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            fileTree={mockFileTree}
            folderId="root"
            loadingFiles={new Set()}
            onSelectFolderRecursively={onSelectFolderRecursively}
          />
        </FileExplorerTestWrapper>
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });

    expect(onSelectFolderRecursively).toHaveBeenCalledTimes(1);
    expect(onSelectFolderRecursively).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/src', type: 'directory' })
    );
  });

  it('blocks new file selection when max selection capacity is reached', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
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
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setMaxSelectionCount(1);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select test.txt'));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });

    const selectedKeys = Array.from(readyStore.getState().selectedFilePaths);
    expect(selectedKeys).toEqual([encodeFileSelection('root', '/test.txt')]);
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
        name: 'new-file.txt',
        path: '/new-file.txt',
        type: 'file',
        isVisible: true,
        handle: {} as FileSystemFileHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
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
        name: 'visible',
        path: '/visible',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [
          {
            name: 'invisible.txt',
            path: '/visible/invisible.txt',
            type: 'file',
            isVisible: false,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
        ],
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
        name: 'level1',
        path: '/level1',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [
          {
            name: 'level2',
            path: '/level1/level2',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            children: [
              {
                name: 'deep-file.txt',
                path: '/level1/level2/deep-file.txt',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
            ],
          },
        ],
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
});
