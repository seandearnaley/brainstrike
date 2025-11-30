import type { IFileNode } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OptimizedFileTree from '../optimized-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

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

    const tree = screen.getByTestId('file-tree');
    expect(tree).toBeInTheDocument();
    expect(tree).toHaveAttribute('role', 'tree');
    expect(tree).toHaveAttribute('aria-label', 'File tree');
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

    const tree = screen.getByTestId('file-tree');
    expect(tree).toBeInTheDocument();
    expect(tree.children.length).toBe(0);
  });

  it('applies correct classes to tree container', () => {
    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    const tree = screen.getByTestId('file-tree');
    expect(tree).toHaveClass('relative', 'file-tree');
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

  it('applies performance optimization styles', () => {
    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    const tree = screen.getByTestId('file-tree');
    expect(tree.style.willChange).toBe('transform');
    expect(tree.style.contain).toBe('layout style paint');
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
