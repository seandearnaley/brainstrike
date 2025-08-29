import {
  composeWrappers,
  createDirectoryNode,
  createFileNode,
  makeRenderWithProviders,
} from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FileExplorerSidebar from '../file-explorer-sidebar';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

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
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} />);
    });

    // Check that the file tree is rendered
    expect(screen.getByRole('tree', { name: 'File tree' })).toBeInTheDocument();
  });

  it('displays "No directory selected" when rootDirectoryHandle is null', () => {
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} rootDirectoryHandle={null} />);
    });

    expect(screen.getByText('No directory selected')).toBeInTheDocument();
    expect(screen.getByText('Use the folder button to select a directory')).toBeInTheDocument();
  });

  it('displays error message when treeError exists', () => {
    const mockError = new Error('Tree loading failed');
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} treeError={mockError} />);
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Tree loading failed/i, { exact: false })).toBeInTheDocument();
  });

  it('displays error message when filterError exists', () => {
    const mockError = new Error('Filter error');
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} filterError={mockError} />);
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Filter error/i, { exact: false })).toBeInTheDocument();
  });

  it('displays both errors when treeError and filterError exist', () => {
    const treeError = new Error('Tree error');
    const filterError = new Error('Filter error');
    act(() => {
      renderWithProviders(
        <FileExplorerSidebar {...defaultProps} treeError={treeError} filterError={filterError} />
      );
    });

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain('Tree error');
    expect(alert.textContent).toContain('Filter error');
  });

  it('displays "No matching files found" when quickFilteredTree is empty', () => {
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} quickFilteredTree={[]} />);
    });

    expect(screen.getByText('No matching files found')).toBeInTheDocument();
  });
});
