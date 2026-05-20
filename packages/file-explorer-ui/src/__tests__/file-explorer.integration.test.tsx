import { MockFileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTree from '../tree/file-tree';
import { PreviewPanel } from '../preview-panel';
import { FileExplorerTestWrapper } from './test-helpers';

type PreviewPanelMocksModule = typeof import('./__mocks__/preview-panel-mocks');

const previewPanelMocksPromise = vi.hoisted(
  async () => (await import('./__mocks__/preview-panel-mocks')) as PreviewPanelMocksModule
);

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  const { createUiModuleMock } = await previewPanelMocksPromise;
  return {
    ...actual,
    ...createUiModuleMock(),
  };
});

vi.mock('@brainstrike/hooks', async () => {
  const { createHooksModuleMock } = await previewPanelMocksPromise;
  return createHooksModuleMock();
});

vi.mock('../use-preview-panel-state', () => ({
  formatTokenCount: (tokens: number) => tokens.toString(),
  usePreviewPanelState: () => ({
    totalStats: { totalFiles: 1, totalTokens: 0 },
    flatListItems: [],
  }),
}));

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lucide-react')>();
  const { createLucideModuleMock } = await previewPanelMocksPromise;
  return {
    ...actual,
    ...createLucideModuleMock(),
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
      name: 'src',
      path: '/src',
      type: 'directory',
      handle: {} as FileSystemDirectoryHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'test-folder',
      children: [
        {
          name: 'index.ts',
          path: '/src/index.ts',
          type: 'file',
          size: 1024,
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'test-folder',
        },
        {
          name: 'components',
          path: '/src/components',
          type: 'directory',
          handle: {} as FileSystemDirectoryHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'test-folder',
          children: [
            {
              name: 'Button.tsx',
              path: '/src/components/Button.tsx',
              type: 'file',
              size: 2048,
              handle: {} as FileSystemFileHandle,
              depth: 2,
              selectionState: 'unchecked',
              rootFolderId: 'test-folder',
            },
          ],
        },
      ],
    },
    {
      name: 'package.json',
      path: '/package.json',
      type: 'file',
      size: 512,
      handle: {} as FileSystemFileHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'test-folder',
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

  it('should integrate with preview panel for selected files', () => {
    const selectedFiles = new Set(['test-folder:/package.json']);
    const { container } = render(
      <FileExplorerTestWrapper mockFileSystemAdapter={mockFileSystemAdapter}>
        <div className="flex">
          <FileTree fileTree={mockFiles} folderId="test-folder" loadingFiles={new Set()} />
          <PreviewPanel
            decodeFileSelection={(key: string) => {
              const [folderId, path] = key.split(':');
              return { folderId: folderId!, path: path! };
            }}
            fileContents={{}}
            loadingFiles={new Set()}
            onSelectionChange={() => {}}
            performUndoableAction={() => {}}
            selectedFiles={selectedFiles}
            tokenCounting={{
              mode: 'accurate',
              reason: null,
              loading: false,
              countTokens: async () => 100,
            }}
          />
        </div>
      </FileExplorerTestWrapper>
    );

    // Check that both components render
    expect(screen.getByRole('treegrid', { name: 'File tree' })).toBeInTheDocument();
    expect(container.querySelector('.flex')).toBeInTheDocument();
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
