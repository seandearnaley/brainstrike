import {
  composeWrappers,
  createDirectoryNode,
  createFileNode,
  makeRenderWithProviders,
} from '@brainstrike/test-utils';
import { EXPAND_COLLAPSE_TEST_ID } from '@brainstrike/types';
import { act, type render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTreeNode from '../tree/file-tree-node';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

beforeEach(() => {
  vi.clearAllMocks();
});

// Default props for convenience
const defaultFileProps = {
  folderId: 'test-folder',
  isExpanded: false,
  isLoading: false,
  node: createFileNode({ name: 'test.tsx', path: 'src/test.tsx' }),
  onToggleDirectoryExpansion: vi.fn(),
  onToggleFileSelection: vi.fn(),
};

const defaultDirProps = {
  folderId: 'test-folder',
  isExpanded: false,
  isLoading: false,
  node: createDirectoryNode({ name: 'components', path: 'src/components' }),
  onToggleDirectoryExpansion: vi.fn(),
  onToggleFileSelection: vi.fn(),
};

describe('FileTreeNode', () => {
  it('renders a file node correctly', () => {
    renderWithProviders(<FileTreeNode {...defaultFileProps} />);

    expect(screen.getByText('test.tsx')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select test.tsx' })).toBeInTheDocument();
    // Should not have expand/collapse button for files
    expect(screen.queryByTestId(EXPAND_COLLAPSE_TEST_ID)).not.toBeInTheDocument();
  });

  it('renders a directory node correctly', () => {
    renderWithProviders(
      <FileTreeNode {...defaultDirProps} folderId="test-folder" isExpanded={true} />
    );

    expect(screen.getByText('components')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select components' })).toBeInTheDocument();
  });

  it('shows loading state correctly', () => {
    renderWithProviders(<FileTreeNode {...defaultFileProps} isLoading={true} />);
    expect(screen.getByLabelText('Loading test.tsx')).toBeInTheDocument();
  });

  it('handles file selection', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FileTreeNode {...defaultFileProps} />);

    const checkbox = screen.getByRole('checkbox', { name: 'Select test.tsx' });
    await user.click(checkbox);

    expect(defaultFileProps.onToggleFileSelection).toHaveBeenCalledWith('src/test.tsx');
  });

  it('handles directory expansion', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FileTreeNode {...defaultDirProps} />);

    const expandButton = screen.getByTestId(EXPAND_COLLAPSE_TEST_ID);
    await user.click(expandButton);

    expect(defaultDirProps.onToggleDirectoryExpansion).toHaveBeenCalledWith('src/components');
  });

  it('shows children when directory is expanded', () => {
    // Explicitly define the node with children for this test
    const nodeWithChildren = createDirectoryNode({
      children: [
        createFileNode({
          name: 'Child.tsx',
          path: 'src/components/Child.tsx',
        }),
      ],
      name: 'components',
      path: 'src/components',
    });

    const props = {
      ...defaultDirProps, // Spread defaults first
      isExpanded: true, // Ensure expanded is set
      node: nodeWithChildren, // Override with the node containing children
    };

    renderWithProviders(<FileTreeNode {...props} />);

    expect(screen.getByText('Child.tsx')).toBeInTheDocument();
  });

  it('filters out invisible children', () => {
    const dirWithInvisibleChild = createDirectoryNode({
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
      name: 'components',
      path: 'src/components',
    });

    const props = {
      ...defaultDirProps,
      folderId: 'test-folder',
      isExpanded: true,
      node: dirWithInvisibleChild,
    };

    renderWithProviders(<FileTreeNode {...props} />);
    expect(screen.queryByText('Child.tsx')).not.toBeInTheDocument();
    expect(screen.getByText('Visible.tsx')).toBeInTheDocument();
  });

  it('changes icon when directory is expanded', async () => {
    const result = renderWithProviders(
      <FileTreeNode {...defaultDirProps} folderId="test-folder" />
    );
    const { rerender } = result as ReturnType<typeof render>;

    // Initially collapsed - the button aria-label is just "Expand"
    expect(screen.getByRole('button', { name: 'Expand' })).toBeInTheDocument();

    // Expanded - the button aria-label is just "Collapse"
    await act(async () => {
      rerender(<FileTreeNode {...defaultDirProps} folderId="test-folder" isExpanded={true} />);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
  });

  it('renders an expanded directory node and handles collapse', async () => {
    const user = userEvent.setup();

    // Create a directory node with child files
    const nodeWithChildren = createDirectoryNode({
      children: [
        createFileNode({
          name: 'child-file-1.txt',
          path: 'src/components/child-file-1.txt',
        }),
      ],
      name: 'components',
      path: 'src/components',
    });

    const props = {
      ...defaultDirProps,
      folderId: 'test-folder',
      isExpanded: true,
      node: nodeWithChildren,
    };

    renderWithProviders(<FileTreeNode {...props} />);

    expect(screen.getByText('child-file-1.txt')).toBeInTheDocument();

    // The button should be present for expandable directories
    const expandButton = screen.getByTestId(EXPAND_COLLAPSE_TEST_ID);
    expect(expandButton).toBeInTheDocument();

    // User can collapse the directory
    await user.click(expandButton);
    expect(defaultDirProps.onToggleDirectoryExpansion).toHaveBeenCalledWith('src/components');
  });
});
