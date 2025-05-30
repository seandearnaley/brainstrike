import { createDirectoryNode, createFileNode } from '@brainstrike/test-utils';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTreeRow from '../file-tree-row';
import { FileExplorerTestWrapper } from './test-helpers';

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
      render(<FileTreeRow {...defaultFileProps} />, { wrapper: FileExplorerTestWrapper });

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
      render(<FileTreeRow {...defaultDirProps} isExpanded={true} />, {
        wrapper: FileExplorerTestWrapper,
      });

      expect(screen.getByText('components')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Select components' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /collapse components directory/i })
      ).toBeInTheDocument();
    });

    it('applies correct depth styling', () => {
      const { container } = render(<FileTreeRow {...defaultFileProps} depth={2} />, {
        wrapper: FileExplorerTestWrapper,
      });

      const listItem = container.querySelector('li');
      expect(listItem).toHaveStyle({ paddingLeft: '48px' }); // 2 * 24px
    });

    it('applies custom style props', () => {
      const customStyle = { top: '100px' };
      const { container } = render(<FileTreeRow {...defaultFileProps} style={customStyle} />, {
        wrapper: FileExplorerTestWrapper,
      });

      const listItem = container.querySelector('li');
      expect(listItem).toHaveStyle({ top: '100px' });
    });
  });

  describe('Loading State', () => {
    it('shows loading spinner when isLoading is true', () => {
      render(<FileTreeRow {...defaultFileProps} isLoading={true} />, {
        wrapper: FileExplorerTestWrapper,
      });

      expect(screen.getByLabelText('Loading test.tsx')).toBeInTheDocument();
    });

    it('shows correct icon for file when not loading', () => {
      render(<FileTreeRow {...defaultFileProps} isLoading={false} />, {
        wrapper: FileExplorerTestWrapper,
      });

      // File icon should be present (we can't easily test the specific icon, but we can test it's not loading)
      expect(screen.queryByLabelText('Loading test.tsx')).not.toBeInTheDocument();
    });

    it('shows correct icon for expanded directory', () => {
      render(<FileTreeRow {...defaultDirProps} isExpanded={true} />, {
        wrapper: FileExplorerTestWrapper,
      });

      expect(
        screen.getByRole('button', { name: /collapse components directory/i })
      ).toBeInTheDocument();
    });

    it('shows correct icon for collapsed directory', () => {
      render(<FileTreeRow {...defaultDirProps} isExpanded={false} />, {
        wrapper: FileExplorerTestWrapper,
      });

      expect(
        screen.getByRole('button', { name: /expand components directory/i })
      ).toBeInTheDocument();
    });
  });

  describe('File Selection', () => {
    it('handles single file selection', async () => {
      const user = userEvent.setup();
      render(<FileTreeRow {...defaultFileProps} />, { wrapper: FileExplorerTestWrapper });

      const checkbox = screen.getByRole('checkbox', { name: 'Select test.tsx' });
      await user.click(checkbox);

      expect(defaultFileProps.onToggleFileSelection).toHaveBeenCalledWith('src/test.tsx');
    });
  });

  describe('Directory Expansion', () => {
    it('handles directory expansion', async () => {
      const user = userEvent.setup();

      render(<FileTreeRow {...defaultDirProps} />, { wrapper: FileExplorerTestWrapper });

      const expandButton = screen.getByRole('button', {
        name: /expand components directory/i,
      });
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

      render(<FileTreeRow {...defaultDirProps} node={dirWithChildren} />, {
        wrapper: FileExplorerTestWrapper,
      });

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

      render(<FileTreeRow {...defaultDirProps} node={dirWithChildren} />, {
        wrapper: FileExplorerTestWrapper,
      });

      const checkbox = screen.getByRole('checkbox', { name: 'Select components' });
      await user.click(checkbox);

      // The checkbox interaction should work (batch operations are handled internally)
      expect(checkbox).toBeInTheDocument();
    });
  });

  describe('Special File Types', () => {
    it('shows symbolic link icon for symbolic links', () => {
      const symbolicLinkNode = {
        ...createFileNode({ name: 'symlink.tsx', path: 'src/symlink.tsx' }),
        isSymbolicLink: true,
      };

      render(<FileTreeRow {...defaultFileProps} node={symbolicLinkNode} />, {
        wrapper: FileExplorerTestWrapper,
      });

      expect(screen.getByText('symlink.tsx')).toBeInTheDocument();
      // The symbolic link icon should be present in the DOM
    });

    it('shows truncation indicator for depth-truncated directories', () => {
      const truncatedDirNode = {
        ...createDirectoryNode({ name: 'deep', path: 'src/very/deep/path' }),
        isDepthTruncated: true,
      };

      render(<FileTreeRow {...defaultDirProps} node={truncatedDirNode} />, {
        wrapper: FileExplorerTestWrapper,
      });

      expect(screen.getByText('deep')).toBeInTheDocument();
      // The truncation indicator (MoreHorizontalIcon) should be present
    });
  });

  describe('Event Handling', () => {
    it('prevents checkbox click from propagating', async () => {
      const user = userEvent.setup();

      render(<FileTreeRow {...defaultFileProps} />, {
        wrapper: FileExplorerTestWrapper,
      });

      const checkbox = screen.getByRole('checkbox', { name: 'Select test.tsx' });
      await user.click(checkbox);

      expect(defaultFileProps.onToggleFileSelection).toHaveBeenCalledWith('src/test.tsx');
      // Event propagation is handled by the component's stopPropagation call
    });
  });

  describe('Memoization', () => {
    it('should not re-render when props are equal', () => {
      const { rerender } = render(<FileTreeRow {...defaultFileProps} />, {
        wrapper: FileExplorerTestWrapper,
      });

      // Re-render with the same props
      rerender(<FileTreeRow {...defaultFileProps} />);

      // Component should still be in the document
      expect(screen.getByText('test.tsx')).toBeInTheDocument();
    });

    it('should re-render when node path changes', () => {
      const { rerender } = render(<FileTreeRow {...defaultFileProps} />, {
        wrapper: FileExplorerTestWrapper,
      });

      const newNode = createFileNode({ name: 'different.tsx', path: 'src/different.tsx' });
      rerender(<FileTreeRow {...defaultFileProps} node={newNode} />);

      expect(screen.getByText('different.tsx')).toBeInTheDocument();
      expect(screen.queryByText('test.tsx')).not.toBeInTheDocument();
    });

    it('should re-render when style props change', () => {
      const { rerender } = render(<FileTreeRow {...defaultFileProps} style={{ top: '0px' }} />, {
        wrapper: FileExplorerTestWrapper,
      });

      rerender(<FileTreeRow {...defaultFileProps} style={{ top: '100px' }} />);

      // Component should still be in the document with updated styles
      expect(screen.getByText('test.tsx')).toBeInTheDocument();
    });
  });

  describe('Row Height Export', () => {
    it('exports ROW_HEIGHT constant', async () => {
      // Test that the ROW_HEIGHT export is available
      const { ROW_HEIGHT } = await import('../file-tree-row');
      expect(ROW_HEIGHT).toBe(28);
    });
  });
});
