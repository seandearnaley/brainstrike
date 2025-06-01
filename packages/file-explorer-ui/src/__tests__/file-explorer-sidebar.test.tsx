import { createDirectoryNode, createFileNode } from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FileExplorerSidebar from '../file-explorer-sidebar';
import { FileExplorerTestWrapper } from './test-helpers';

vi.mock('@brainstrike/file-explorer-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-ui')>();
  return {
    ...actual,
    FolderBadge: ({ folderId }: { folderId: string }) => <div>{folderId}</div>,
  };
});

describe('FileExplorerSidebar', () => {
  const mockTreeData: IFileNode[] = [
    createDirectoryNode({
      name: 'src',
      path: 'src',
      children: [
        createFileNode({
          name: 'index.ts',
          path: 'src/index.ts',
        }),
      ],
    }),
  ];

  // Create a mock directory handle with name property
  const mockDirectoryHandle = {
    name: 'test-directory',
    kind: 'directory',
  } as FileSystemDirectoryHandle;

  const defaultProps = {
    rootDirectoryHandle: mockDirectoryHandle,
    treeError: null,
    filterError: null,
    quickFilteredTree: mockTreeData,
    loadingFiles: new Set<string>(),
    isLoading: false,
    isInitialLoad: false,
    currentFolderId: 'test-folder',
    onTreeRender: vi.fn(),
  };

  it('renders with directory and files', () => {
    render(<FileExplorerSidebar {...defaultProps} />, { wrapper: FileExplorerTestWrapper });

    // Check that the file tree is rendered
    expect(screen.getByRole('tree', { name: 'File tree' })).toBeInTheDocument();
  });

  it('displays "No directory selected" when rootDirectoryHandle is null', () => {
    render(<FileExplorerSidebar {...defaultProps} rootDirectoryHandle={null} />, {
      wrapper: FileExplorerTestWrapper,
    });

    expect(screen.getByText('No directory selected')).toBeInTheDocument();
    expect(screen.getByText('Use the folder button to select a directory')).toBeInTheDocument();
  });

  it('displays error message when treeError exists', () => {
    const mockError = new Error('Tree loading failed');

    render(<FileExplorerSidebar {...defaultProps} treeError={mockError} />, {
      wrapper: FileExplorerTestWrapper,
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Tree loading failed/i, { exact: false })).toBeInTheDocument();
  });

  it('displays error message when filterError exists', () => {
    const mockError = new Error('Filter error');

    render(<FileExplorerSidebar {...defaultProps} filterError={mockError} />, {
      wrapper: FileExplorerTestWrapper,
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Filter error/i, { exact: false })).toBeInTheDocument();
  });

  it('displays both errors when treeError and filterError exist', () => {
    const treeError = new Error('Tree error');
    const filterError = new Error('Filter error');

    render(
      <FileExplorerSidebar {...defaultProps} treeError={treeError} filterError={filterError} />,
      { wrapper: FileExplorerTestWrapper }
    );

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain('Tree error');
    expect(alert.textContent).toContain('Filter error');
  });

  it('displays "No matching files found" when quickFilteredTree is empty', () => {
    render(<FileExplorerSidebar {...defaultProps} quickFilteredTree={[]} />, {
      wrapper: FileExplorerTestWrapper,
    });

    expect(screen.getByText('No matching files found')).toBeInTheDocument();
  });
});
