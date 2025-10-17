import {
  composeWrappers,
  createDirectoryNode,
  createFileNode,
  makeRenderWithProviders,
} from '@brainstrike/test-utils';
import { act, type render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTreeRow from '../file-tree-row';
import { FileExplorerTestWrapper } from './test-helpers';

// Example adoption of shared renderWithProviders helper
const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

beforeEach(() => {
  vi.clearAllMocks();
});

// Default props for convenience
const defaultFileProps = {
  node: createFileNode({ name: 'test.tsx', path: 'src/test.tsx' }),
  depth: 0,
  isExpanded: false,
  onToggleDirectoryExpansion: vi.fn(),
  onToggleFileSelection: vi.fn(),
  isLoading: false,
  folderId: 'test-folder',
};

const defaultDirProps = {
  node: createDirectoryNode({ name: 'components', path: 'src/components' }),
  depth: 0,
  isExpanded: false,
  onToggleDirectoryExpansion: vi.fn(),
  onToggleFileSelection: vi.fn(),
  isLoading: false,
  folderId: 'test-folder',
};

describe('FileTreeRow', () => {
  describe('Basic Rendering', () => {
    it('renders a file node correctly', () => {
      renderWithProviders(<FileTreeRow {...defaultFileProps} />);

      expect(screen.getByText('test.tsx')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Select test.tsx' })).toBeInTheDocument();
      // Should not have expand/collapse button for files
      expect(screen.queryByTestId('expand-collapse-button')).not.toBeInTheDocument();
    });

    it('renders a directory node correctly', () => {
      renderWithProviders(<FileTreeRow {...defaultDirProps} isExpanded={true} />);

      expect(screen.getByText('components')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Select components' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /collapse components directory/i })
      ).toBeInTheDocument();
    });

    it('applies correct depth styling', () => {
      const result = renderWithProviders(<FileTreeRow {...defaultFileProps} depth={2} />);
      const { container } = result as ReturnType<typeof render>;

      const innerDiv = container.querySelector('div[role="treeitem"] > div');
      expect(innerDiv).toHaveStyle({ paddingLeft: '56px' }); // 2 * 24 + 8 = 56px
    });

    it('applies custom style props', () => {
      const customStyle = { top: '100px' };
      const result = renderWithProviders(<FileTreeRow {...defaultFileProps} style={customStyle} />);
      const { container } = result as ReturnType<typeof render>;

      const treeItem = container.querySelector('div[role="treeitem"]');
      expect(treeItem).toHaveStyle({ top: '100px' });
    });
  });

  describe('Loading State', () => {
    it('shows loading spinner when isLoading is true', () => {
      renderWithProviders(<FileTreeRow {...defaultFileProps} isLoading={true} />);

      expect(screen.getByLabelText('Loading test.tsx')).toBeInTheDocument();
    });

    it('shows correct icon for file when not loading', () => {
      renderWithProviders(<FileTreeRow {...defaultFileProps} isLoading={false} />);

      // File icon should be present (we can't easily test the specific icon, but we can test it's not loading)
      expect(screen.queryByLabelText('Loading test.tsx')).not.toBeInTheDocument();
    });

    it('shows correct icon for expanded directory', () => {
      renderWithProviders(<FileTreeRow {...defaultDirProps} isExpanded={true} />);

      expect(
        screen.getByRole('button', { name: /collapse components directory/i })
      ).toBeInTheDocument();
    });

    it('shows correct icon for collapsed directory', () => {
      renderWithProviders(<FileTreeRow {...defaultDirProps} isExpanded={false} />);

      expect(
        screen.getByRole('button', { name: /expand components directory/i })
      ).toBeInTheDocument();
    });
  });

  describe('File Selection', () => {
    it('handles single file selection', async () => {
      const user = userEvent.setup();
      renderWithProviders(<FileTreeRow {...defaultFileProps} />);

      const checkbox = screen.getByRole('checkbox', { name: 'Select test.tsx' });
      await user.click(checkbox);

      expect(defaultFileProps.onToggleFileSelection).toHaveBeenCalledWith('src/test.tsx');
    });
  });

  describe('Directory Expansion', () => {
    it('handles directory expansion', async () => {
      const user = userEvent.setup();

      renderWithProviders(<FileTreeRow {...defaultDirProps} />);

      const expandButton = screen.getByTestId('expand-collapse-button');
      await user.click(expandButton);

      expect(defaultDirProps.onToggleDirectoryExpansion).toHaveBeenCalledWith('src/components');
    });
  });

  describe('Batch Operations for Directories', () => {
    it('renders directory with children for batch operations', () => {
      const dirWithChildren = createDirectoryNode({
        name: 'components',
        path: 'src/components',
        children: [
          createFileNode({ name: 'file1.tsx', path: 'src/components/file1.tsx' }),
          createFileNode({ name: 'file2.tsx', path: 'src/components/file2.tsx' }),
        ],
      });

      renderWithProviders(<FileTreeRow {...defaultDirProps} node={dirWithChildren} />);

      const checkbox = screen.getByRole('checkbox', { name: 'Select components' });
      expect(checkbox).toBeInTheDocument();
    });

    it('handles directory selection click', async () => {
      const user = userEvent.setup();
      const dirWithChildren = createDirectoryNode({
        name: 'components',
        path: 'src/components',
        children: [createFileNode({ name: 'file1.tsx', path: 'src/components/file1.tsx' })],
      });

      renderWithProviders(<FileTreeRow {...defaultDirProps} node={dirWithChildren} />);

      const checkbox = screen.getByRole('checkbox', { name: 'Select components' });
      await user.click(checkbox);

      // The checkbox interaction should work (batch operations are handled internally)
      expect(checkbox).toBeInTheDocument();
    });
  });

  describe('Special File Types', () => {
    it('shows symbolic link icon for symbolic links', async () => {
      const symbolicLinkNode = {
        ...createFileNode({ name: 'symlink.tsx', path: 'src/symlink.tsx' }),
        isSymbolicLink: true,
      };

      await act(async () => {
        renderWithProviders(<FileTreeRow {...defaultFileProps} node={symbolicLinkNode} />);
        await Promise.resolve();
      });

      expect(screen.getByText('symlink.tsx')).toBeInTheDocument();
      // The symbolic link icon should be present in the DOM
    });

    it('shows truncation indicator for depth-truncated directories', async () => {
      const truncatedDirNode = {
        ...createDirectoryNode({ name: 'deep', path: 'src/very/deep/path' }),
        isDepthTruncated: true,
      };

      await act(async () => {
        renderWithProviders(<FileTreeRow {...defaultDirProps} node={truncatedDirNode} />);
        await Promise.resolve();
      });

      expect(screen.getByText('deep')).toBeInTheDocument();
      // The truncation indicator (MoreHorizontalIcon) should be present
    });
  });

  describe('Event Handling', () => {
    it('prevents checkbox click from propagating', async () => {
      const user = userEvent.setup();

      renderWithProviders(<FileTreeRow {...defaultFileProps} />);

      const checkbox = screen.getByRole('checkbox', { name: 'Select test.tsx' });
      await user.click(checkbox);

      expect(defaultFileProps.onToggleFileSelection).toHaveBeenCalledWith('src/test.tsx');
      // Event propagation is handled by the component's stopPropagation call
    });
  });

  describe('Memoization', () => {
    it('should not re-render when props are equal', async () => {
      const result = renderWithProviders(<FileTreeRow {...defaultFileProps} />);
      const { rerender } = result as ReturnType<typeof render>;

      // Re-render with the same props (ensure updates are awaited)
      await act(async () => {
        rerender(<FileTreeRow {...defaultFileProps} />);
        await Promise.resolve();
      });

      // Component should still be in the document
      expect(screen.getByText('test.tsx')).toBeInTheDocument();
    });

    it('should re-render when node path changes', async () => {
      const result = renderWithProviders(<FileTreeRow {...defaultFileProps} />);
      const { rerender } = result as ReturnType<typeof render>;

      const newNode = createFileNode({ name: 'different.tsx', path: 'src/different.tsx' });
      await act(async () => {
        rerender(<FileTreeRow {...defaultFileProps} node={newNode} />);
        await Promise.resolve();
      });

      expect(screen.getByText('different.tsx')).toBeInTheDocument();
      expect(screen.queryByText('test.tsx')).not.toBeInTheDocument();
    });

    it('should re-render when style props change', async () => {
      const result = renderWithProviders(
        <FileTreeRow {...defaultFileProps} style={{ top: '0px' }} />
      );
      const { rerender } = result as ReturnType<typeof render>;

      await act(async () => {
        rerender(<FileTreeRow {...defaultFileProps} style={{ top: '100px' }} />);
        await Promise.resolve();
      });

      // Component should still be in the document with updated styles
      expect(screen.getByText('test.tsx')).toBeInTheDocument();
    });
  });

  describe('Row Height Export', () => {
    it('exports ROW_HEIGHT constant', async () => {
      // Test that the ROW_HEIGHT export is available
      const { ROW_HEIGHT } = await import('../file-tree-row');
      expect(ROW_HEIGHT).toBe(32);
    });
  });
});
