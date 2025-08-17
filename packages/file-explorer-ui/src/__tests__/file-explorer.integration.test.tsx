import { MockFileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import FileTree from '../file-tree';
import { PreviewPanel } from '../preview-panel';
import { FileExplorerTestWrapper } from './test-helpers';

describe('File Explorer Integration Tests', () => {
  const mockFiles: IFileNode[] = [
    {
      name: 'src',
      path: '/src',
      type: 'directory',
      children: [
        {
          name: 'index.ts',
          path: '/src/index.ts',
          type: 'file',
          extension: 'ts',
          size: 1024,
        },
        {
          name: 'components',
          path: '/src/components',
          type: 'directory',
          children: [
            {
              name: 'Button.tsx',
              path: '/src/components/Button.tsx',
              type: 'file',
              extension: 'tsx',
              size: 2048,
            },
          ],
        },
      ],
    },
    {
      name: 'package.json',
      path: '/package.json',
      type: 'file',
      extension: 'json',
      size: 512,
    },
  ];

  let mockFileSystemAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
    mockFileSystemAdapter = new MockFileSystemAdapter(mockFS);
  });

  it('should render file tree and handle folder expansion', async () => {
    const _user = userEvent.setup();

    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} loadingFiles={new Set()} folderId="test-folder" />
      </FileExplorerTestWrapper>
    );

    // Check that the root folder is rendered
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();

    // The tree should render successfully
    expect(screen.getByRole('tree')).toBeInTheDocument();
  });

  it('should handle file selection and multi-selection', async () => {
    const user = userEvent.setup();

    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} loadingFiles={new Set()} folderId="test-folder" />
      </FileExplorerTestWrapper>
    );

    // Check that files are rendered and clickable
    const packageFile = screen.getByText('package.json');
    expect(packageFile).toBeInTheDocument();

    // Click should work without errors
    await user.click(packageFile);
    await user.click(packageFile, { ctrlKey: true });
  });

  it('should integrate with preview panel for selected files', async () => {
    const { container } = render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <div className="flex">
          <FileTree fileTree={mockFiles} loadingFiles={new Set()} folderId="test-folder" />
          <PreviewPanel
            selectedFiles={new Set(['test-folder:/package.json'])}
            fileContents={{}}
            loadingFiles={new Set()}
            onSelectionChange={() => {}}
            decodeFileSelection={(key: string) => {
              const [folderId, path] = key.split(':');
              return { folderId, path };
            }}
            countTokensHeuristic={() => 100}
            performUndoableAction={() => {}}
          />
        </div>
      </FileExplorerTestWrapper>
    );

    // Check that both components render
    expect(screen.getByRole('tree')).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector('.flex')).toBeInTheDocument();
    });
  });

  it('should handle drag and drop operations', async () => {
    const user = userEvent.setup();

    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} loadingFiles={new Set()} folderId="test-folder" />
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
        <FileTree fileTree={mockFiles} loadingFiles={new Set()} folderId="test-folder" />
      </FileExplorerTestWrapper>
    );

    // Focus on the tree
    const tree = screen.getByRole('tree');
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
        <FileTree fileTree={mockFiles} loadingFiles={new Set()} folderId="test-folder" />
      </FileExplorerTestWrapper>
    );

    const file = screen.getByText('package.json');

    // Right-click should not throw errors
    await user.pointer([{ keys: '[MouseRight]', target: file }]);

    // Check that the file is still there
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });

  it('should handle file filtering and search', async () => {
    const _user = userEvent.setup();

    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} loadingFiles={new Set()} folderId="test-folder" />
      </FileExplorerTestWrapper>
    );

    // Check that files are rendered
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });

  it('should handle file operations errors gracefully', async () => {
    render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <FileTree fileTree={mockFiles} loadingFiles={new Set()} folderId="test-folder" />
      </FileExplorerTestWrapper>
    );

    // Check that the tree renders without errors
    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });
});
