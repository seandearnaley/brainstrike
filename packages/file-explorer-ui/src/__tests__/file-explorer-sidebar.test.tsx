import {
  composeWrappers,
  createDirectoryNode,
  createFileNode,
  makeRenderWithProviders,
} from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

// No need to mock self-package; sidebar does not import FolderBadge.

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

  // Create a proper DirectoryHandle with all required properties
  const mockDirectoryHandle = {
    name: 'test-directory',
    kind: 'directory' as const,
    path: '/test-directory',
    platform: 'web' as const,
    _internal: {} as FileSystemDirectoryHandle,
  };

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
    expect(screen.getByRole('treegrid', { name: 'File tree' })).toBeInTheDocument();
  });

  it('displays "No directory selected" when rootDirectoryHandle is null', () => {
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} rootDirectoryHandle={null} />);
    });

    expect(screen.getByText('No directory selected')).toBeInTheDocument();
    expect(
      screen.getByText('Connect a directory to browse your project and select files')
    ).toBeInTheDocument();
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
        <FileExplorerSidebar {...defaultProps} filterError={filterError} treeError={treeError} />
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

  it('renders single-root layout (no section headers) when rootDirectoryHandles has one entry', () => {
    act(() => {
      renderWithProviders(
        <FileExplorerSidebar
          {...defaultProps}
          rootDirectoryHandles={[mockDirectoryHandle]}
          setFocusedRoot={vi.fn()}
        />
      );
    });

    // Single-root: no section headers, just the tree
    expect(screen.queryByTestId('root-section-header')).toBeNull();
    expect(screen.getByRole('treegrid', { name: 'File tree' })).toBeInTheDocument();
  });

  it('renders two section headers and two trees in forest mode (rootDirectoryHandles.length > 1)', () => {
    const handleA = {
      name: 'project-a',
      kind: 'directory' as const,
      path: '/project-a',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };
    const handleB = {
      name: 'project-b',
      kind: 'directory' as const,
      path: '/project-b',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };

    act(() => {
      renderWithProviders(
        <FileExplorerSidebar
          {...defaultProps}
          // Set the focused root to handleA so its quickFilteredTree renders
          rootDirectoryHandle={handleA}
          rootDirectoryHandles={[handleA, handleB]}
          setFocusedRoot={vi.fn()}
        />
      );
    });

    // Two section headers
    const headers = screen.getAllByTestId('root-section-header');
    expect(headers).toHaveLength(2);
    expect(screen.getByText('project-a')).toBeInTheDocument();
    expect(screen.getByText('project-b')).toBeInTheDocument();

    // At least the focused root's tree renders
    const trees = screen.getAllByRole('treegrid', { name: 'File tree' });
    expect(trees.length).toBeGreaterThanOrEqual(1);
  });

  it('calls setFocusedRoot when a section is clicked in forest mode', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const setFocusedRoot = vi.fn();

    const handleA = {
      name: 'project-a',
      kind: 'directory' as const,
      path: '/project-a',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };
    const handleB = {
      name: 'project-b',
      kind: 'directory' as const,
      path: '/project-b',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };

    act(() => {
      renderWithProviders(
        <FileExplorerSidebar
          {...defaultProps}
          rootDirectoryHandle={handleA}
          rootDirectoryHandles={[handleA, handleB]}
          setFocusedRoot={setFocusedRoot}
        />
      );
    });

    // Click on the header of the second root section to focus root B
    const headers = screen.getAllByTestId('root-section-header');
    await user.click(headers[1] as HTMLElement);
    expect(setFocusedRoot).toHaveBeenCalledWith('/project-b');
  });
});
