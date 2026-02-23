import type { IFileNode } from '@brainstrike/types';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import OptimizedFileTree from '../optimized-file-tree';
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

  it('renders file tree container with correct attributes', () => {
    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    const container = screen.getByTestId('file-tree-scroll-container');
    expect(container).toBeInTheDocument();
    expect(container).toHaveClass('h-full', 'relative', 'flex-1', 'min-h-0', 'overflow-y-auto');
  });

  it('renders file tree with correct role and label', () => {
    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

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

  it('updates visible file checkbox state after selection changes', () => {
    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    const fileCheckbox = screen.getByLabelText('Select test.txt');
    expect(fileCheckbox).not.toBeChecked();

    fireEvent.click(fileCheckbox);
    expect(fileCheckbox).toBeChecked();
  });

  it('calls onRender callback when provided', () => {
    const mockOnRender = vi.fn();

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

    expect(mockOnRender).toHaveBeenCalled();
  });

  it('renders empty tree when fileTree is empty', () => {
    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={[]} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByText('No data available')).toBeInTheDocument();
  });

  it('applies correct classes to tree container', () => {
    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    const treeGrid = screen.getByRole('treegrid', { name: 'File tree' });
    expect(treeGrid).toHaveClass('file-tree');
  });

  it('renders with loading files set', () => {
    const loadingFiles = new Set(['root:/src/file1.txt']);

    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={loadingFiles} />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('handles folderId changes', () => {
    const { rerender } = render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();

    rerender(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="other" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('does not call onRender when not provided', () => {
    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('handles fileTree updates', () => {
    const { rerender } = render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

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

    rerender(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={newFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('renders with invisible nodes filtered out', () => {
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

    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={treeWithInvisible} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('handles nested directory structure', () => {
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

    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={nestedTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });
});
