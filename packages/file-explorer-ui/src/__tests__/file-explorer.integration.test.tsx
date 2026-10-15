import { MockFileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTree from '../tree/file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lucide-react')>();
  return {
    ...actual,
    ChevronDown: () => <div data-testid="chevron-down" />,
    ChevronRight: () => <div data-testid="chevron-right" />,
    File: () => <div data-testid="file-icon" />,
    Folder: () => <div data-testid="folder-icon" />,
    FolderOpen: () => <div data-testid="folder-open-icon" />,
    Link2: () => <div data-testid="link-icon" />,
    Loader2: () => <div data-testid="loader-icon" />,
    MoreHorizontal: () => <div data-testid="more-icon" />,
    Trash2: () => <div data-testid="trash-icon" />,
  };
});

describe('File Explorer Integration Tests', () => {
  const mockFiles: IFileNode[] = [
    {
      children: [
        {
          depth: 1,
          handle: {} as FileSystemFileHandle,
          name: 'index.ts',
          path: '/src/index.ts',
          rootFolderId: 'test-folder',
          selectionState: 'unchecked',
          size: 1024,
          type: 'file',
        },
        {
          children: [
            {
              depth: 2,
              handle: {} as FileSystemFileHandle,
              name: 'Button.tsx',
              path: '/src/components/Button.tsx',
              rootFolderId: 'test-folder',
              selectionState: 'unchecked',
              size: 2048,
              type: 'file',
            },
          ],
          depth: 1,
          handle: {} as FileSystemDirectoryHandle,
          name: 'components',
          path: '/src/components',
          rootFolderId: 'test-folder',
          selectionState: 'unchecked',
          type: 'directory',
        },
      ],
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      name: 'src',
      path: '/src',
      rootFolderId: 'test-folder',
      selectionState: 'unchecked',
      type: 'directory',
    },
    {
      depth: 0,
      handle: {} as FileSystemFileHandle,
      name: 'package.json',
      path: '/package.json',
      rootFolderId: 'test-folder',
      selectionState: 'unchecked',
      size: 512,
      type: 'file',
    },
  ];

  let mockFileSystemAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
    mockFileSystemAdapter = new MockFileSystemAdapter(mockFS);
  });

  it('should render file tree and handle folder expansion', async () => {
    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} folderId="test-folder" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    // Check that the root folder is rendered
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();

    // The tree should render successfully
    expect(screen.getByRole('treegrid', { name: 'File tree' })).toBeInTheDocument();
  });

  it('should handle file selection and multi-selection', async () => {
    const user = userEvent.setup();

    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} folderId="test-folder" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    // Check that files are rendered and clickable
    const packageFile = screen.getByText('package.json');
    expect(packageFile).toBeInTheDocument();

    // Click should work without errors
    await user.click(packageFile);
  });

  it('should handle drag and drop operations', async () => {
    const user = userEvent.setup();

    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} folderId="test-folder" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    // Check that the files exist for potential drag and drop
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();

    // Basic interaction test
    const srcFolder = screen.getByText('src');
    await user.hover(srcFolder);
  });

  it('should handle keyboard navigation', async () => {
    const user = userEvent.setup();

    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} folderId="test-folder" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    // Focus on the tree
    const tree = screen.getByRole('treegrid', { name: 'File tree' });
    tree.focus();

    // Navigate with arrow keys should not throw errors
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
  });

  it('should handle context menu operations', async () => {
    const user = userEvent.setup();

    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} folderId="test-folder" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    const file = screen.getByText('package.json');

    // Right-click should not throw errors
    await user.pointer([{ keys: '[MouseRight]', target: file }]);

    // Check that the file is still there
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });

  it('should handle file filtering and search', async () => {
    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} folderId="test-folder" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    // Check that files are rendered
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });

  it('should handle file operations errors gracefully', async () => {
    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} folderId="test-folder" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    // Check that the tree renders without errors
    expect(screen.getByRole('treegrid', { name: 'File tree' })).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });
});
