import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorerStore } from '../../../stores/use-file-explorer-store';
import { createDirectoryNode, createFileNode } from '../../../test/factories/file-node';
import FileTreeNode from '../file-tree-node';

// Create a mock store instance
const createMockStore = () => ({
  selectedFilePaths: new Set<string>(),
  expandedDirectoryPaths: new Set<string>(),
  maxSelectionCount: 100,
});

let mockStore = createMockStore();

// Mock the store module
vi.mock('@/stores/use-file-explorer-store', () => ({
  useFileExplorerStore: vi.fn(() => mockStore),
}));

// Helper to update store state
const setStoreState = (newState: Partial<ReturnType<typeof createMockStore>>) => {
  mockStore = {
    ...mockStore,
    ...newState,
  };
};

describe('FileTreeNode', () => {
  const defaultFileProps = {
    node: createFileNode({
      name: 'test.tsx',
      path: 'src/test.tsx',
      rootFolderId: 'test-folder',
    }),
    isExpanded: false,
    onToggleDirectoryExpansion: vi.fn(),
    onToggleFileSelection: vi.fn(),
    isLoading: false,
    folderId: 'test-folder',
  };

  const defaultDirProps = {
    node: createDirectoryNode({
      name: 'components',
      path: 'src/components',
      rootFolderId: 'test-folder',
      children: [
        createFileNode({
          name: 'Child.tsx',
          path: 'src/components/Child.tsx',
          rootFolderId: 'test-folder',
        }),
      ],
    }),
    isExpanded: false,
    onToggleDirectoryExpansion: vi.fn(),
    onToggleFileSelection: vi.fn(),
    isLoading: false,
    folderId: 'test-folder',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = createMockStore();
  });

  it('renders a file node correctly', () => {
    render(<FileTreeNode {...defaultFileProps} />);

    expect(screen.getByText('test.tsx')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select test.tsx' })).toBeInTheDocument();
    // Should not have expand/collapse button for files
    expect(
      screen.queryByRole('button', { name: /expand .* directory|collapse .* directory/i })
    ).not.toBeInTheDocument();
  });

  it('renders a directory node correctly', () => {
    render(<FileTreeNode {...defaultDirProps} isExpanded={true} folderId="test-folder" />);

    expect(screen.getByText('components')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select components' })).toBeInTheDocument();
  });

  it('shows loading state correctly', () => {
    render(<FileTreeNode {...defaultFileProps} isLoading={true} />);
    expect(screen.getByLabelText('Loading test.tsx')).toBeInTheDocument();
  });

  it('handles file selection', async () => {
    const user = userEvent.setup();
    render(<FileTreeNode {...defaultFileProps} />);

    const checkbox = screen.getByRole('checkbox', { name: 'Select test.tsx' });
    await user.click(checkbox);

    expect(defaultFileProps.onToggleFileSelection).toHaveBeenCalledWith('src/test.tsx');
  });

  it('handles directory expansion', async () => {
    const user = userEvent.setup();
    render(<FileTreeNode {...defaultDirProps} />);

    const expandButton = screen.getByRole('button', { name: /expand components directory/i });
    await user.click(expandButton);

    expect(defaultDirProps.onToggleDirectoryExpansion).toHaveBeenCalledWith('src/components');
  });

  it('shows children when directory is expanded', () => {
    render(<FileTreeNode {...defaultDirProps} isExpanded={true} />);

    expect(screen.getByText('Child.tsx')).toBeInTheDocument();
  });

  it('renders directory node correctly', () => {
    render(<FileTreeNode {...defaultDirProps} isExpanded={true} folderId="test-folder" />);

    expect(screen.getByText('components')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select components' })).toBeInTheDocument();
  });

  it('shows expanded directory contents', () => {
    const mockToggleDirectoryExpansion = vi.fn();
    const mockToggleFileSelection = vi.fn();

    const props = {
      node: createDirectoryNode({
        name: 'components',
        path: 'src/components',
        children: [
          createFileNode({
            name: 'Child.tsx',
            path: 'src/components/Child.tsx',
          }),
        ],
      }),
      isExpanded: true,
      onToggleDirectoryExpansion: mockToggleDirectoryExpansion,
      onToggleFileSelection: mockToggleFileSelection,
      isLoading: false,
      folderId: 'test-folder',
    };

    setStoreState({
      selectedFilePaths: new Set(),
    });

    render(<FileTreeNode {...props} />);
    expect(screen.getByText('Child.tsx')).toBeInTheDocument();
  });

  it('shows correct checkbox state for fully selected directory', () => {
    const mockToggleDirectoryExpansion = vi.fn();
    const mockToggleFileSelection = vi.fn();

    const props = {
      node: createDirectoryNode({
        name: 'components',
        path: 'src/components',
        children: [
          createFileNode({
            name: 'Child.tsx',
            path: 'src/components/Child.tsx',
          }),
        ],
      }),
      isExpanded: true,
      onToggleDirectoryExpansion: mockToggleDirectoryExpansion,
      onToggleFileSelection: mockToggleFileSelection,
      isLoading: false,
      folderId: 'test-folder',
    };

    setStoreState({
      selectedFilePaths: new Set(['test-folder|@|src/components/Child.tsx']),
    });

    render(<FileTreeNode {...props} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Select components' });
    expect(checkbox).toHaveAttribute('data-state', 'checked');
  });

  it('filters out invisible children', () => {
    const dirWithInvisibleChild = createDirectoryNode({
      name: 'components',
      path: 'src/components',
      children: [
        {
          ...createFileNode({
            name: 'Child.tsx',
            path: 'src/components/Child.tsx',
          }),
          isVisible: false,
        },
        {
          ...createFileNode({
            name: 'Visible.tsx',
            path: 'src/components/Visible.tsx',
          }),
          isVisible: true,
        },
      ],
    });

    const props = {
      ...defaultDirProps,
      isExpanded: true,
      node: dirWithInvisibleChild,
      folderId: 'test-folder',
    };

    render(<FileTreeNode {...props} />);
    expect(screen.queryByText('Child.tsx')).not.toBeInTheDocument();
    expect(screen.getByText('Visible.tsx')).toBeInTheDocument();
  });

  it('changes icon when directory is expanded', () => {
    const { rerender } = render(<FileTreeNode {...defaultDirProps} folderId="test-folder" />);

    // Initially collapsed
    expect(
      screen.getByRole('button', { name: /expand components directory/i })
    ).toBeInTheDocument();

    // Expanded
    rerender(<FileTreeNode {...defaultDirProps} isExpanded={true} folderId="test-folder" />);
    expect(
      screen.getByRole('button', { name: /collapse components directory/i })
    ).toBeInTheDocument();
  });

  describe('Directory Selection Behavior', () => {
    const setupDirTest = (selectedPaths: string[] = []) => {
      const mockToggleFileSelection = vi.fn();
      const dirNode = createDirectoryNode({
        name: 'test-dir',
        path: 'src/test-dir',
        rootFolderId: 'test-folder',
        children: [
          createFileNode({
            name: 'file1.tsx',
            path: 'src/test-dir/file1.tsx',
            rootFolderId: 'test-folder',
          }),
          createFileNode({
            name: 'file2.tsx',
            path: 'src/test-dir/file2.tsx',
            rootFolderId: 'test-folder',
          }),
          createFileNode({
            name: 'file3.tsx',
            path: 'src/test-dir/file3.tsx',
            rootFolderId: 'test-folder',
          }),
        ],
      });

      setStoreState({
        selectedFilePaths: new Set(selectedPaths.map((path) => `test-folder|@|${path}`)),
        maxSelectionCount: 100,
      });

      const props = {
        node: dirNode,
        isExpanded: true,
        onToggleDirectoryExpansion: vi.fn(),
        onToggleFileSelection: mockToggleFileSelection,
        isLoading: false,
        folderId: 'test-folder',
      };

      return { props, mockToggleFileSelection };
    };

    it('shows indeterminate state when some files are selected', async () => {
      const { props } = setupDirTest(['src/test-dir/file1.tsx']);
      render(<FileTreeNode {...props} />);

      const checkbox = screen.getByRole('checkbox', { name: 'Select test-dir' });
      expect(checkbox).toHaveAttribute('data-state', 'indeterminate');
    });

    it('selects all child files when clicked in indeterminate state', async () => {
      const { props, mockToggleFileSelection } = setupDirTest(['src/test-dir/file1.tsx']);
      const user = userEvent.setup();
      render(<FileTreeNode {...props} />);

      const checkbox = screen.getByRole('checkbox', { name: 'Select test-dir' });
      await user.click(checkbox);

      // Should select the remaining unselected files
      expect(mockToggleFileSelection.mock.calls.map((call) => call[0])).toEqual(
        expect.arrayContaining(['src/test-dir/file2.tsx', 'src/test-dir/file3.tsx'])
      );
    });

    it('handles nested directory selection correctly', async () => {
      const nestedDir = createDirectoryNode({
        name: 'parent',
        path: 'src/parent',
        children: [
          createDirectoryNode({
            name: 'child',
            path: 'src/parent/child',
            children: [
              createFileNode({
                name: 'nested.tsx',
                path: 'src/parent/child/nested.tsx',
              }),
            ],
          }),
        ],
      });

      const mockToggleFileSelection = vi.fn();
      setStoreState({
        selectedFilePaths: new Set(),
        maxSelectionCount: 100,
      });

      const props = {
        node: nestedDir,
        isExpanded: true,
        onToggleDirectoryExpansion: vi.fn(),
        onToggleFileSelection: mockToggleFileSelection,
        isLoading: false,
        folderId: 'test-folder',
      };

      const user = userEvent.setup();
      render(<FileTreeNode {...props} />);

      const parentCheckbox = screen.getByRole('checkbox', { name: 'Select parent' });
      await user.click(parentCheckbox);

      // Should select the nested file
      expect(mockToggleFileSelection.mock.calls.map((call) => call[0])).toContain(
        'src/parent/child/nested.tsx'
      );
    });
  });
});
