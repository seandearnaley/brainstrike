import type { IFileNode } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createDirectoryNode, createFileNode } from '../../../test/factories/file-node';
import { FileExplorerStrings } from '../constants/file-explorer-constants';
import FileExplorerSidebar from '../file-explorer-sidebar';

// Mock the GitPanel component since it's more complex and tested separately
vi.mock('../git-panel', () => ({
  GitPanel: () => <div data-testid="git-panel">Mock Git Panel</div>,
}));

// Mock the FolderBadge component to simplify testing
vi.mock('../folder-badge', () => ({
  FolderBadge: ({ folderId }: { folderId: string }) => <div>{folderId}</div>,
}));

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
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    quickFilter: '',
    quickFilteredTree: mockTreeData,
    loadingFiles: new Set<string>(),
    isLoading: false,
    isInitialLoad: false,
    currentFolderId: 'test-folder',
    onTreeRender: vi.fn(),
  };

  it('renders with directory and files', () => {
    render(<FileExplorerSidebar {...defaultProps} />);

    // Check for the directory status - use exact text from constants
    expect(screen.getByText(FileExplorerStrings.STATUS.CURRENT_DIRECTORY)).toBeInTheDocument();

    // Check that the files tab is present
    expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();

    // Check that the file tree is rendered
    expect(screen.getByRole('tree', { name: 'File tree' })).toBeInTheDocument();
  });

  it('displays "No directory selected" when rootDirectoryHandle is null', () => {
    render(<FileExplorerSidebar {...defaultProps} rootDirectoryHandle={null} />);

    expect(screen.getByText('No directory selected')).toBeInTheDocument();
    expect(screen.getByText('Use the folder button to select a directory')).toBeInTheDocument();
  });

  it('displays error message when treeError exists', () => {
    const mockError = new Error('Tree loading failed');

    render(<FileExplorerSidebar {...defaultProps} treeError={mockError} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Tree loading failed/i, { exact: false })).toBeInTheDocument();
  });

  it('displays error message when filterError exists', () => {
    const mockError = new Error('Filter error');

    render(<FileExplorerSidebar {...defaultProps} filterError={mockError} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Filter error/i, { exact: false })).toBeInTheDocument();
  });

  it('displays both errors when treeError and filterError exist', () => {
    const treeError = new Error('Tree error');
    const filterError = new Error('Filter error');

    render(
      <FileExplorerSidebar {...defaultProps} treeError={treeError} filterError={filterError} />
    );

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain('Tree error');
    expect(alert.textContent).toContain('Filter error');
  });

  it('displays "No matching files found" when quickFilteredTree is empty', () => {
    render(<FileExplorerSidebar {...defaultProps} quickFilteredTree={[]} />);

    expect(screen.getByText('No matching files found')).toBeInTheDocument();
  });

  it('displays include filters when provided', () => {
    render(<FileExplorerSidebar {...defaultProps} includeFilters={['.ts', '.tsx']} />);

    // Use getByText directly to find the filters
    expect(screen.getByText('.ts')).toBeInTheDocument();
    expect(screen.getByText('.tsx')).toBeInTheDocument();
  });

  it('displays exclude filters when provided', () => {
    render(<FileExplorerSidebar {...defaultProps} excludeFilters={['.css', '.md']} />);

    // Use getByText directly to find the filters
    expect(screen.getByText('.css')).toBeInTheDocument();
    expect(screen.getByText('.md')).toBeInTheDocument();
  });

  it('displays quick filter when provided', () => {
    render(<FileExplorerSidebar {...defaultProps} quickFilter="component" />);

    // Use getByText directly to find the filter
    expect(screen.getByText('component')).toBeInTheDocument();
  });

  it('displays regex badge when useRegex is true', () => {
    render(
      <FileExplorerSidebar
        {...defaultProps}
        useRegex={true}
        quickFilter="test" // Need to add a filter to make the regex badge appear
      />
    );

    // Use getByText directly to find the regex text
    expect(screen.getByText('regex')).toBeInTheDocument();
  });

  it('can switch to Git tab', async () => {
    const user = userEvent.setup();

    // Use userEvent.setup() to interact with the component
    const { getAllByRole } = render(<FileExplorerSidebar {...defaultProps} />);

    // Find the Git tab by its text content
    const gitTab = getAllByRole('tab').find((tab) => tab.textContent === 'Git');

    // Click on the Git tab
    if (gitTab) {
      await user.click(gitTab);

      // Check if git tab is selected
      expect(gitTab).toHaveAttribute('aria-selected', 'true');
    } else {
      // If gitTab is undefined, fail the test
      expect(gitTab).toBeDefined();
    }
  });
});
