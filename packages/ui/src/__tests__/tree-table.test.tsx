/**
 * Tests for TreeTable component
 *
 * NOTE: useVirtualizer requires actual DOM dimensions to render items.
 * In JSDOM tests, we mock the virtualizer to return all items for testing.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeTable } from '../tree-table/tree-table';
import type { TreeNode, TreeTableColumn } from '../tree-table/types';

// Mock @tanstack/react-virtual to avoid JSDOM dimension issues
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * 40,
        end: (i + 1) * 40,
        size: 40,
        key: `item-${i}`,
      })),
    getTotalSize: () => count * 40,
    scrollToIndex: vi.fn(),
    measureElement: vi.fn(),
  })),
}));

// Test data types
interface TestData {
  name: string;
  size?: number;
}

// Helper to create test nodes
function createTestNode(
  id: string,
  name: string,
  parentId: string | null = null,
  hasChildren = false,
  depth = 0
): TreeNode<TestData> {
  return {
    id,
    type: 'file',
    depth,
    data: { name },
    parentId,
    hasChildren,
  };
}

// Standard test columns
const testColumns: TreeTableColumn<TestData>[] = [
  {
    id: 'name',
    header: 'Name',
    cell: ({ node }) => <span>{node.data.name}</span>,
  },
];

describe('TreeTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders empty state when no nodes', () => {
      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={[]}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByText('No data available')).toBeInTheDocument();
    });

    it('renders custom empty state', () => {
      render(
        <TreeTable
          columns={testColumns}
          emptyState={<div>No files found</div>}
          expandedIds={new Set()}
          nodes={[]}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByText('No files found')).toBeInTheDocument();
    });

    it('renders nodes', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByText('File 1')).toBeInTheDocument();
      expect(screen.getByText('File 2')).toBeInTheDocument();
    });

    it('renders column headers', () => {
      const columns: TreeTableColumn<TestData>[] = [
        {
          id: 'name',
          header: 'File Name',
          cell: ({ node }) => node.data.name,
        },
        {
          id: 'size',
          header: 'Size',
          cell: ({ node }) => node.data.size ?? 'N/A',
        },
      ];

      render(
        <TreeTable
          columns={columns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByText('File Name')).toBeInTheDocument();
      expect(screen.getByText('Size')).toBeInTheDocument();
    });

    it('applies treegrid role', () => {
      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByRole('treegrid')).toBeInTheDocument();
    });

    it('renders with custom aria-label', () => {
      render(
        <TreeTable
          ariaLabel="Custom tree table"
          columns={testColumns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByLabelText('Custom tree table')).toBeInTheDocument();
    });
  });

  describe('expansion', () => {
    it('shows expand icon for nodes with children', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'Folder', null, true)];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand/i });
      expect(expandButton).toBeInTheDocument();
    });

    it('shows collapse icon for expanded nodes', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'Folder', null, true)];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['1'])}
          nodes={nodes}
          onToggleExpand={() => {}}
        />
      );

      const collapseButton = screen.getByRole('button', { name: /collapse/i });
      expect(collapseButton).toBeInTheDocument();
    });

    it('calls onToggleExpand when expand button clicked', () => {
      const handleToggle = vi.fn();
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'Folder', null, true)];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={handleToggle}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand/i });
      fireEvent.click(expandButton);

      expect(handleToggle).toHaveBeenCalledWith('1');
    });

    it('shows children when parent is expanded', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Parent', null, true, 0),
        createTestNode('2', 'Child', '1', false, 1),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['1'])}
          nodes={nodes}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByText('Parent')).toBeInTheDocument();
      expect(screen.getByText('Child')).toBeInTheDocument();
    });

    it('hides children when parent is collapsed', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Parent', null, true, 0),
        createTestNode('2', 'Child', '1', false, 1),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByText('Parent')).toBeInTheDocument();
      expect(screen.queryByText('Child')).not.toBeInTheDocument();
    });
  });

  describe('selection', () => {
    it('calls onSelect when row clicked in single mode', () => {
      const handleSelect = vi.fn();
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'File 1')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onSelect={handleSelect}
          onToggleExpand={() => {}}
          selectionMode="single"
        />
      );

      const row = screen.getByText('File 1').closest('tr');
      if (row) {
        fireEvent.click(row);
      }

      expect(handleSelect).toHaveBeenCalledWith('1');
    });

    it('does not call onSelect in none mode', () => {
      const handleSelect = vi.fn();
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'File 1')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onSelect={handleSelect}
          onToggleExpand={() => {}}
          selectionMode="none"
        />
      );

      const row = screen.getByText('File 1').closest('tr');
      if (row) {
        fireEvent.click(row);
      }

      expect(handleSelect).not.toHaveBeenCalled();
    });

    it('applies selected styling to selected row', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'File 1')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          selectedId="1"
        />
      );

      const row = screen.getByText('File 1').closest('tr');
      expect(row).toHaveAttribute('data-selected', 'true');
    });

    it('handles multi-select with ctrl/cmd click', () => {
      const handleMultiSelect = vi.fn();
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          multiSelectedIds={new Set(['1'])}
          nodes={nodes}
          onMultiSelectChange={handleMultiSelect}
          onToggleExpand={() => {}}
          selectionMode="multi"
        />
      );

      const row2 = screen.getByText('File 2').closest('tr');
      if (row2) {
        fireEvent.click(row2, { ctrlKey: true });
      }

      expect(handleMultiSelect).toHaveBeenCalled();
      const firstCall = handleMultiSelect.mock.calls[0];
      expect(firstCall).toBeDefined();
      const newSelection = firstCall?.[0] as Set<string> | undefined;
      expect(newSelection?.has('1')).toBe(true);
      expect(newSelection?.has('2')).toBe(true);
    });
  });

  describe('highlighting', () => {
    it('applies highlighted styling to highlighted row', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'File 1')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          highlightedIds={new Set(['1'])}
          nodes={nodes}
          onToggleExpand={() => {}}
        />
      );

      const row = screen.getByText('File 1').closest('tr');
      expect(row).toHaveAttribute('data-highlighted', 'true');
    });
  });

  describe('sorting', () => {
    it('shows sort indicator for sorted column', () => {
      const columns: TreeTableColumn<TestData>[] = [
        {
          id: 'name',
          header: 'Name',
          sortable: true,
          cell: ({ node }) => node.data.name,
        },
      ];

      render(
        <TreeTable
          columns={columns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onSortChange={() => {}}
          onToggleExpand={() => {}}
          sortState={{ columnId: 'name', direction: 'asc' }}
        />
      );

      expect(screen.getByText('↑')).toBeInTheDocument();
    });

    it('calls onSortChange when sortable column header clicked', () => {
      const handleSort = vi.fn();
      const columns: TreeTableColumn<TestData>[] = [
        {
          id: 'name',
          header: 'Name',
          sortable: true,
          cell: ({ node }) => node.data.name,
        },
      ];

      render(
        <TreeTable
          columns={columns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onSortChange={handleSort}
          onToggleExpand={() => {}}
        />
      );

      const header = screen.getByText('Name');
      fireEvent.click(header);

      expect(handleSort).toHaveBeenCalledWith('name', 'asc');
    });

    it('cycles sort direction on repeated clicks', () => {
      const handleSort = vi.fn();
      const columns: TreeTableColumn<TestData>[] = [
        {
          id: 'name',
          header: 'Name',
          sortable: true,
          cell: ({ node }) => node.data.name,
        },
      ];

      const { rerender } = render(
        <TreeTable
          columns={columns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onSortChange={handleSort}
          onToggleExpand={() => {}}
          sortState={{ columnId: 'name', direction: 'asc' }}
        />
      );

      const header = screen.getByText('Name');
      fireEvent.click(header);

      expect(handleSort).toHaveBeenCalledWith('name', 'desc');

      // Rerender with desc to test next cycle
      rerender(
        <TreeTable
          columns={columns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onSortChange={handleSort}
          onToggleExpand={() => {}}
          sortState={{ columnId: 'name', direction: 'desc' }}
        />
      );

      fireEvent.click(header);
      expect(handleSort).toHaveBeenCalledWith('name', null);
    });
  });

  describe('callbacks', () => {
    it('calls onRowDoubleClick on double click', () => {
      const handleDoubleClick = vi.fn();
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'File 1')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onRowDoubleClick={handleDoubleClick}
          onToggleExpand={() => {}}
        />
      );

      const row = screen.getByText('File 1').closest('tr');
      if (row) {
        fireEvent.doubleClick(row);
      }

      expect(handleDoubleClick).toHaveBeenCalledWith('1', expect.objectContaining({ id: '1' }));
    });

    it('calls onRowContextMenu on right click', () => {
      const handleContextMenu = vi.fn();
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'File 1')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onRowContextMenu={handleContextMenu}
          onToggleExpand={() => {}}
        />
      );

      const row = screen.getByText('File 1').closest('tr');
      if (row) {
        fireEvent.contextMenu(row);
      }

      expect(handleContextMenu).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ id: '1' }),
        expect.any(Object)
      );
    });
  });

  describe('styling', () => {
    it('applies className to container', () => {
      render(
        <TreeTable
          className="custom-class"
          columns={testColumns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onToggleExpand={() => {}}
        />
      );

      const container = screen.getByRole('treegrid');
      expect(container).toHaveClass('custom-class');
    });

    it('applies rowClassName to rows', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'File 1')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          rowClassName="custom-row"
        />
      );

      const row = screen.getByText('File 1').closest('tr');
      expect(row).toHaveClass('custom-row');
    });

    it('supports rowClassName as function', () => {
      const nodes: TreeNode<TestData>[] = [
        { ...createTestNode('1', 'File 1'), type: 'file' },
        { ...createTestNode('2', 'Folder 1'), type: 'folder' },
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          rowClassName={(node) => `row-${node.type}`}
        />
      );

      const fileRow = screen.getByText('File 1').closest('tr');
      const folderRow = screen.getByText('Folder 1').closest('tr');

      expect(fileRow).toHaveClass('row-file');
      expect(folderRow).toHaveClass('row-folder');
    });
  });
});
