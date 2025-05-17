import { useFileExplorerStore } from '@brainstrike/file-explorer';
import { FileTreeNode } from '@brainstrike/file-explorer-ui';
import type { FileExplorerState } from '@brainstrike/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryNode, createFileNode } from '../../../test/factories/file-node';

// Define initial state fully satisfying FileExplorerState
const initialFullState: FileExplorerState = {
  selectedFilePaths: new Set(),
  maxSelectionCount: 100,
  currentFolderId: null,
  folderStates: {},
  expandedDirectoryPaths: new Set(),
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  includeProjectTree: true,
  folderSummaryThreshold: 5,
  lastActiveTab: 'files',
  setCurrentFolderId: vi.fn(),
  hydrateFolderState: vi.fn(),
  setSelectedFiles: vi.fn(),
  addSelectedFile: vi.fn(),
  removeSelectedFile: vi.fn(),
  toggleSelectedFile: vi.fn(),
  clearSelectedFiles: vi.fn(),
  setExpandedPaths: vi.fn(),
  toggleDirectoryExpansion: vi.fn(),
  setFilters: vi.fn(),
  setUseRegex: vi.fn(),
  setIncludeProjectTree: vi.fn(),
  setFolderSummaryThreshold: vi.fn(),
  setMaxSelectionCount: vi.fn(),
  setLastActiveTab: vi.fn(),
  expandAllDirectories: vi.fn(),
  collapseAllDirectories: vi.fn(),
};

beforeEach(() => {
  // Reset Zustand store to initial state before each test
  useFileExplorerStore.setState(initialFullState, true);
});

// Default props for convenience
const defaultFileProps = {
  node: createFileNode({ name: 'test.tsx', path: 'src/test.tsx' }),
  isExpanded: false,
  onToggleDirectoryExpansion: vi.fn(),
  onToggleFileSelection: vi.fn(),
  isLoading: false,
  folderId: 'test-folder',
};

const defaultDirProps = {
  node: createDirectoryNode({ name: 'components', path: 'src/components' }),
  isExpanded: false,
  onToggleDirectoryExpansion: vi.fn(),
  onToggleFileSelection: vi.fn(),
  isLoading: false,
  folderId: 'test-folder',
};

describe('FileTreeNode', () => {
  it('renders a file node correctly', () => {
    render(<FileTreeNode {...defaultFileProps} />);

    expect(screen.getByText('test.tsx')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select test.tsx' })).toBeInTheDocument();
    // Should not have expand/collapse button for files
    expect(
      screen.queryByRole('button', {
        name: /expand .* directory|collapse .* directory/i,
      })
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

    const expandButton = screen.getByRole('button', {
      name: /expand components directory/i,
    });
    await user.click(expandButton);

    expect(defaultDirProps.onToggleDirectoryExpansion).toHaveBeenCalledWith('src/components');
  });

  it('shows children when directory is expanded', () => {
    // Explicitly define the node with children for this test
    const nodeWithChildren = createDirectoryNode({
      name: 'components',
      path: 'src/components',
      children: [
        createFileNode({
          name: 'Child.tsx',
          path: 'src/components/Child.tsx',
        }),
      ],
    });

    const props = {
      ...defaultDirProps, // Spread defaults first
      node: nodeWithChildren, // Override with the node containing children
      isExpanded: true, // Ensure expanded is set
    };

    render(<FileTreeNode {...props} />);

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

    render(<FileTreeNode {...props} />);
    expect(screen.getByText('Child.tsx')).toBeInTheDocument();
  });

  it('shows correct checkbox state for fully selected directory', async () => {
    const user = userEvent.setup();
    const mockToggleDirectoryExpansion = vi.fn();
    const childFilePath = 'src/components/Child.tsx';
    const childKey = `test-folder|@|${childFilePath}`;

    const props = {
      node: createDirectoryNode({
        name: 'components',
        path: 'src/components',
        rootFolderId: 'test-folder',
        children: [
          createFileNode({
            name: 'Child.tsx',
            path: childFilePath,
            rootFolderId: 'test-folder',
          }),
        ],
      }),
      isExpanded: true,
      onToggleDirectoryExpansion: mockToggleDirectoryExpansion,
      onToggleFileSelection: () => {
        // Simulate selecting all children when parent is clicked
        act(() => {
          useFileExplorerStore.setState({ selectedFilePaths: new Set([childKey]) });
        });
      },
      isLoading: false,
      folderId: 'test-folder',
    };

    render(<FileTreeNode {...props} />);

    const childCheckbox = screen.getByRole('checkbox', { name: 'Select Child.tsx' });
    await user.click(childCheckbox);

    const parentCheckbox = screen.getByRole('checkbox', {
      name: 'Select components',
    });
    await waitFor(() => {
      expect(parentCheckbox).toHaveAttribute('data-state', 'checked');
    });
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
    it('shows indeterminate state when some files are selected', async () => {
      const file1Key = 'test-folder|@|src/test-dir/file1.tsx';
      act(() => {
        useFileExplorerStore.setState({ selectedFilePaths: new Set([file1Key]) });
      });

      const mockToggleFileSelection = vi.fn(() => {
        const key = `test-folder|@|${file1Key}`;
        act(() => {
          const currentSelected = useFileExplorerStore.getState().selectedFilePaths;
          const maxCount = useFileExplorerStore.getState().maxSelectionCount;
          const newSelectedPaths = new Set(currentSelected);
          if (newSelectedPaths.has(key)) {
            newSelectedPaths.delete(key);
          } else if (newSelectedPaths.size < maxCount) {
            newSelectedPaths.add(key);
          }
          useFileExplorerStore.setState({ selectedFilePaths: newSelectedPaths });
        });
      });

      const props = {
        node: createDirectoryNode({
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
        }),
        isExpanded: true,
        onToggleDirectoryExpansion: vi.fn(),
        onToggleFileSelection: mockToggleFileSelection,
        isLoading: false,
        folderId: 'test-folder',
      };

      render(<FileTreeNode {...props} />);

      // No need to click child, state is set initially
      const parentCheckbox = screen.getByRole('checkbox', {
        name: 'Select test-dir',
      });
      await waitFor(() => {
        expect(parentCheckbox).toHaveAttribute('data-state', 'indeterminate');
      });
    });

    it('selects all child files when clicked in indeterminate state', async () => {
      const user = userEvent.setup();
      const file1Key = 'test-folder|@|src/test-dir/file1.tsx';
      const file2Key = 'test-folder|@|src/test-dir/file2.tsx';
      const file3Key = 'test-folder|@|src/test-dir/file3.tsx';
      act(() => {
        useFileExplorerStore.setState({ selectedFilePaths: new Set([file1Key]) });
      });
      const mockToggleFileSelection = vi.fn(() => {
        // Simulate selecting all children when parent is clicked
        act(() => {
          useFileExplorerStore.setState({
            selectedFilePaths: new Set([file1Key, file2Key, file3Key]),
          });
        });
      });
      const props = {
        node: createDirectoryNode({
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
        }),
        isExpanded: true,
        onToggleDirectoryExpansion: vi.fn(),
        onToggleFileSelection: mockToggleFileSelection,
        isLoading: false,
        folderId: 'test-folder',
      };

      render(<FileTreeNode {...props} />);

      const parentCheckbox = screen.getByRole('checkbox', {
        name: 'Select test-dir',
      });

      await waitFor(() => {
        expect(parentCheckbox).toHaveAttribute('data-state', 'indeterminate');
      });

      await user.click(parentCheckbox);

      // Check the final store state after the click triggers updates
      await waitFor(() => {
        const finalSelected = useFileExplorerStore.getState().selectedFilePaths;
        expect(finalSelected).toEqual(new Set([file1Key, file2Key, file3Key]));
        expect(parentCheckbox).toHaveAttribute('data-state', 'checked');
      });
    });

    it('handles nested directory selection correctly', async () => {
      const user = userEvent.setup();
      const nestedFileKey = 'test-folder|@|src/parent/child/nested.tsx';
      const mockToggleFileSelection = vi.fn(() => {
        // Simulate selecting all descendant files for nested directory
        act(() => {
          useFileExplorerStore.setState({ selectedFilePaths: new Set([nestedFileKey]) });
        });
      });
      const props = {
        node: createDirectoryNode({
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
        }),
        isExpanded: true,
        onToggleDirectoryExpansion: vi.fn(),
        onToggleFileSelection: mockToggleFileSelection,
        isLoading: false,
        folderId: 'test-folder',
      };

      render(<FileTreeNode {...props} />);

      const parentCheckbox = screen.getByRole('checkbox', {
        name: 'Select parent',
      });
      await user.click(parentCheckbox);

      await waitFor(() => {
        const finalSelected = useFileExplorerStore.getState().selectedFilePaths;
        expect(finalSelected).toContain(nestedFileKey);
        expect(parentCheckbox).toHaveAttribute('data-state', 'checked');
      });
    });
  });
});
