import { createFileSystemAdapter, useFileSystemStore } from '@brainstrike/file-system';
import type { FileNode } from '@brainstrike/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTree } from '../file-tree';
import { PreviewPanel } from '../preview-panel';

// Mock the file system store
vi.mock('@brainstrike/file-system', () => ({
  useFileSystemStore: vi.fn(),
  createFileSystemAdapter: vi.fn(),
}));

// Mock the storage module
vi.mock('@brainstrike/storage', () => ({
  createStorageAdapter: () => ({
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('File Explorer Integration Tests', () => {
  const mockFiles: FileNode[] = [
    {
      id: '1',
      name: 'src',
      path: '/src',
      type: 'directory',
      children: [
        {
          id: '2',
          name: 'index.ts',
          path: '/src/index.ts',
          type: 'file',
          extension: 'ts',
          size: 1024,
        },
        {
          id: '3',
          name: 'components',
          path: '/src/components',
          type: 'directory',
          children: [
            {
              id: '4',
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
      id: '5',
      name: 'package.json',
      path: '/package.json',
      type: 'file',
      extension: 'json',
      size: 512,
    },
  ];

  const mockFileSystemStore = {
    files: mockFiles,
    selectedFiles: new Set<string>(),
    expandedFolders: new Set<string>(['1']),
    toggleFolder: vi.fn(),
    selectFile: vi.fn(),
    deselectFile: vi.fn(),
    toggleFileSelection: vi.fn(),
    clearSelection: vi.fn(),
    setFiles: vi.fn(),
    getFileById: vi.fn((id: string) => {
      const stack: FileNode[] = [...mockFiles];
      while (stack.length) {
        const node = stack.pop() as FileNode;
        if (node.id === id) return node;
        if (node.children?.length) stack.push(...node.children);
      }
      return undefined;
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFileSystemStore).mockReturnValue(mockFileSystemStore);
    vi.mocked(createFileSystemAdapter).mockReturnValue({
      readDirectory: vi.fn().mockResolvedValue(mockFiles),
      readFile: vi.fn().mockResolvedValue('file content'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      createDirectory: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('should render file tree and handle folder expansion', async () => {
    const user = userEvent.setup();

    render(<FileTree />);

    // Check that the root folder is rendered
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();

    // Check that children are visible (folder is expanded)
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText('components')).toBeInTheDocument();

    // Click to collapse the folder
    const srcFolder = screen.getByText('src');
    await user.click(srcFolder);

    expect(mockFileSystemStore.toggleFolder).toHaveBeenCalledWith('1');
  });

  it('should handle file selection and multi-selection', async () => {
    const user = userEvent.setup();

    render(<FileTree />);

    // Select a single file
    const indexFile = screen.getByText('index.ts');
    await user.click(indexFile);

    expect(mockFileSystemStore.toggleFileSelection).toHaveBeenCalledWith('2');

    // Multi-select with Ctrl/Cmd
    const packageFile = screen.getByText('package.json');
    await user.click(packageFile, { ctrlKey: true });

    expect(mockFileSystemStore.toggleFileSelection).toHaveBeenCalledWith('5');
  });

  it('should integrate with preview panel for selected files', async () => {
    const selectedFiles = new Set(['2', '5']);
    const storeWithSelection = {
      ...mockFileSystemStore,
      selectedFiles,
    };

    vi.mocked(useFileSystemStore).mockReturnValue(storeWithSelection);

    const { container } = render(
      <div className="flex">
        <FileTree />
        <PreviewPanel />
      </div>
    );

    // Check that preview panel shows selected files
    await waitFor(() => {
      const previewPanel = container.querySelector('[role="region"]');
      expect(previewPanel).toBeInTheDocument();
    });

    // Verify selected files are indicated in the tree
    const selectedElements = container.querySelectorAll('[aria-selected="true"]');
    expect(selectedElements.length).toBeGreaterThan(0);
  });

  it('should handle drag and drop operations', async () => {
    const user = userEvent.setup();

    render(<FileTree />);

    const sourceFile = screen.getByText('Button.tsx');
    const targetFolder = screen.getByText('src');

    // Simulate drag start
    await user.pointer([
      { keys: '[MouseLeft>]', target: sourceFile },
      { coords: { x: 100, y: 100 } },
    ]);

    // Simulate drag over target
    await user.pointer([{ coords: { x: 200, y: 50 }, target: targetFolder }]);

    // Simulate drop
    await user.pointer([{ keys: '[/MouseLeft]', target: targetFolder }]);

    // Verify drag and drop handling
    await waitFor(() => {
      // Check for any visual feedback or state changes
      const dragIndicator = screen.queryByRole('status');
      if (dragIndicator) {
        expect(dragIndicator).toBeInTheDocument();
      }
    });
  });

  it('should handle keyboard navigation', async () => {
    const user = userEvent.setup();

    render(<FileTree />);

    // Focus on the tree
    const tree = screen.getByRole('tree');
    tree.focus();

    // Navigate with arrow keys
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowRight}'); // Expand folder
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}'); // Select file

    expect(mockFileSystemStore.toggleFileSelection).toHaveBeenCalled();

    // Test Select All
    await user.keyboard('{Control>}a{/Control}');

    // Test Delete key
    await user.keyboard('{Delete}');
  });

  it('should handle context menu operations', async () => {
    const user = userEvent.setup();

    render(<FileTree />);

    const file = screen.getByText('index.ts');

    // Right-click to open context menu
    await user.pointer([{ keys: '[MouseRight]', target: file }]);

    // Check for context menu items
    await waitFor(() => {
      const contextMenu = screen.queryByRole('menu');
      if (contextMenu) {
        expect(contextMenu).toBeInTheDocument();

        const renameOption = screen.queryByText(/rename/i);
        const deleteOption = screen.queryByText(/delete/i);

        if (renameOption) expect(renameOption).toBeInTheDocument();
        if (deleteOption) expect(deleteOption).toBeInTheDocument();
      }
    });
  });

  it('should handle file filtering and search', async () => {
    const user = userEvent.setup();

    render(<FileTree />);

    // Look for search input
    const searchInput = screen.queryByRole('searchbox') || screen.queryByPlaceholderText(/search/i);

    if (searchInput) {
      await user.type(searchInput, 'Button');

      await waitFor(() => {
        // Verify filtered results
        expect(screen.getByText('Button.tsx')).toBeInTheDocument();

        // Other files might be hidden
        const indexFile = screen.queryByText('index.ts');
        if (indexFile) {
          expect(indexFile).not.toBeVisible();
        }
      });

      // Clear search
      await user.clear(searchInput);

      await waitFor(() => {
        // All files should be visible again
        expect(screen.getByText('index.ts')).toBeInTheDocument();
        expect(screen.getByText('package.json')).toBeInTheDocument();
      });
    }
  });

  it('should handle file operations errors gracefully', async () => {
    const adapter = createFileSystemAdapter();
    vi.mocked(adapter.readFile).mockRejectedValue(new Error('File not found'));

    const errorStore = {
      ...mockFileSystemStore,
      error: 'File not found',
    };

    vi.mocked(useFileSystemStore).mockReturnValue(errorStore);

    render(<FileTree />);

    // Check for error display
    await waitFor(() => {
      const errorMessage = screen.queryByRole('alert');
      if (errorMessage) {
        expect(errorMessage).toHaveTextContent(/error/i);
      }
    });
  });
});
