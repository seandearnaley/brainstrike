import { createDirectoryNode, createFileNode } from '@brainstrike/test-utils';
import { EXPAND_COLLAPSE_TEST_ID } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTreeNode from '../file-tree-node';
import { FileExplorerTestWrapper } from './test-helpers';

beforeEach(() => {
  vi.clearAllMocks();
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
    render(<FileTreeNode {...defaultFileProps} />, { wrapper: FileExplorerTestWrapper });

    expect(screen.getByText('test.tsx')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select test.tsx' })).toBeInTheDocument();
    // Should not have expand/collapse button for files
    expect(screen.queryByTestId(EXPAND_COLLAPSE_TEST_ID)).not.toBeInTheDocument();
  });

  it('renders a directory node correctly', () => {
    render(<FileTreeNode {...defaultDirProps} isExpanded={true} folderId="test-folder" />, {
      wrapper: FileExplorerTestWrapper,
    });

    expect(screen.getByText('components')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select components' })).toBeInTheDocument();
  });

  it('shows loading state correctly', () => {
    render(<FileTreeNode {...defaultFileProps} isLoading={true} />, {
      wrapper: FileExplorerTestWrapper,
    });
    expect(screen.getByLabelText('Loading test.tsx')).toBeInTheDocument();
  });

  it('handles file selection', async () => {
    const user = userEvent.setup();
    render(<FileTreeNode {...defaultFileProps} />, { wrapper: FileExplorerTestWrapper });

    const checkbox = screen.getByRole('checkbox', { name: 'Select test.tsx' });
    await user.click(checkbox);

    expect(defaultFileProps.onToggleFileSelection).toHaveBeenCalledWith('src/test.tsx');
  });

  it('handles directory expansion', async () => {
    const user = userEvent.setup();
    render(<FileTreeNode {...defaultDirProps} />, { wrapper: FileExplorerTestWrapper });

    const expandButton = screen.getByTestId(EXPAND_COLLAPSE_TEST_ID);
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

    render(<FileTreeNode {...props} />, { wrapper: FileExplorerTestWrapper });

    expect(screen.getByText('Child.tsx')).toBeInTheDocument();
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

    render(<FileTreeNode {...props} />, { wrapper: FileExplorerTestWrapper });
    expect(screen.queryByText('Child.tsx')).not.toBeInTheDocument();
    expect(screen.getByText('Visible.tsx')).toBeInTheDocument();
  });

  it('changes icon when directory is expanded', () => {
    const { rerender } = render(<FileTreeNode {...defaultDirProps} folderId="test-folder" />, {
      wrapper: FileExplorerTestWrapper,
    });

    // Initially collapsed - the button aria-label is just "Expand"
    expect(screen.getByRole('button', { name: 'Expand' })).toBeInTheDocument();

    // Expanded - the button aria-label is just "Collapse"
    rerender(<FileTreeNode {...defaultDirProps} isExpanded={true} folderId="test-folder" />);
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
  });

  it('renders an expanded directory node and handles collapse', async () => {
    const user = userEvent.setup();

    // Create a directory node with child files
    const nodeWithChildren = createDirectoryNode({
      name: 'components',
      path: 'src/components',
      children: [
        createFileNode({
          name: 'child-file-1.txt',
          path: 'src/components/child-file-1.txt',
        }),
      ],
    });

    const props = {
      ...defaultDirProps,
      node: nodeWithChildren,
      isExpanded: true,
      folderId: 'test-folder',
    };

    render(<FileTreeNode {...props} />, {
      wrapper: FileExplorerTestWrapper,
    });

    expect(screen.getByText('child-file-1.txt')).toBeInTheDocument();

    // The button should be present for expandable directories
    const expandButton = screen.getByTestId(EXPAND_COLLAPSE_TEST_ID);
    expect(expandButton).toBeInTheDocument();

    // User can collapse the directory
    await user.click(expandButton);
    expect(defaultDirProps.onToggleDirectoryExpansion).toHaveBeenCalledWith('src/components');
  });
});
