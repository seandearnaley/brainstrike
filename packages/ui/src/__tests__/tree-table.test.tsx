/**
 * Tests for TreeTable component
 *
 * NOTE: useVirtualizer requires actual DOM dimensions to render items.
 * In JSDOM tests, we mock the virtualizer to return all items for testing.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeTable } from '../tree-table/tree-table';
import type { TreeNode, TreeTableColumn } from '../tree-table/types';

const virtualizerMocks = vi.hoisted(() => ({
  measureElement: vi.fn(),
}));

let virtualizerMode: 'full' | 'empty' | 'stale' = 'full';

// Mock @tanstack/react-virtual to avoid JSDOM dimension issues
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () => {
      if (virtualizerMode === 'empty') {
        return [];
      }
      if (virtualizerMode === 'stale') {
        return [
          {
            end: (count + 6) * 40,
            index: count + 5,
            key: 'stale-item',
            size: 40,
            start: (count + 5) * 40,
          },
        ];
      }
      return Array.from({ length: count }, (_, i) => ({
        end: (i + 1) * 40,
        index: i,
        key: `item-${i}`,
        size: 40,
        start: i * 40,
      }));
    },
    measureElement: virtualizerMocks.measureElement,
    scrollToIndex: vi.fn(),
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
    data: { name },
    depth,
    hasChildren,
    id,
    parentId,
    type: 'file',
  };
}

// Standard test columns
const testColumns: TreeTableColumn<TestData>[] = [
  {
    cell: ({ node }) => <span>{node.data.name}</span>,
    header: 'Name',
    id: 'name',
  },
];

describe('TreeTable', () => {
  beforeEach(() => {
    virtualizerMode = 'full';
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

    it('keeps roving focus semantic without painting the old primary ring', () => {
      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'File 1')]}
          onToggleExpand={() => {}}
        />
      );

      const treegrid = screen.getByRole('treegrid');
      fireEvent.keyDown(treegrid, { key: 'ArrowDown' });

      const row = screen.getByText('File 1').closest('tr');
      expect(row).toHaveAttribute('data-focused', 'true');
      expect(row).not.toHaveClass('ring-2', 'ring-primary', 'ring-inset');
      expect(row).toHaveClass(
        'outline-solid',
        'outline-2',
        'outline-foreground/50',
        '-outline-offset-2',
        'focus-visible:outline-solid',
        'focus-visible:outline-2',
        'focus-visible:outline-foreground/50',
        'focus-visible:-outline-offset-2'
      );
    });

    it('does not paint the roving row outline for pointer focus', () => {
      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'File 1')]}
          onToggleExpand={() => {}}
        />
      );

      const row = screen.getByText('File 1').closest('tr');
      if (!row) {
        throw new Error('Expected tree row to render.');
      }
      fireEvent.pointerDown(row);
      fireEvent.click(row);

      expect(row).toHaveAttribute('data-focused', 'true');
      expect(row).not.toHaveClass(
        'outline-solid',
        'outline-2',
        'outline-foreground/50',
        '-outline-offset-2'
      );
    });

    it('removes the roving row outline when focus leaves the tree', () => {
      render(
        <>
          <TreeTable
            columns={testColumns}
            expandedIds={new Set()}
            nodes={[createTestNode('1', 'File 1')]}
            onToggleExpand={() => {}}
          />
          <button type="button">Outside</button>
        </>
      );

      const treegrid = screen.getByRole('treegrid');
      treegrid.focus();
      fireEvent.keyDown(treegrid, { key: 'ArrowDown' });

      const row = screen.getByText('File 1').closest('tr');
      expect(row).toHaveClass(
        'outline-solid',
        'outline-2',
        'outline-foreground/50',
        '-outline-offset-2'
      );

      const outsideButton = screen.getByRole('button', { name: 'Outside' });
      fireEvent.blur(treegrid, { relatedTarget: outsideButton });
      outsideButton.focus();

      expect(row).not.toHaveClass(
        'outline-solid',
        'outline-2',
        'outline-foreground/50',
        '-outline-offset-2'
      );
    });

    it('keeps the roving row outline when focus moves within the tree', () => {
      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'File 1', null, true)]}
          onToggleExpand={() => {}}
        />
      );

      const treegrid = screen.getByRole('treegrid');
      treegrid.focus();
      fireEvent.keyDown(treegrid, { key: 'ArrowDown' });

      const row = screen.getByText('File 1').closest('tr');
      const expandButton = screen.getByRole('button', { name: 'Expand' });
      fireEvent.blur(treegrid, { relatedTarget: expandButton });

      expect(row).toHaveClass(
        'outline-solid',
        'outline-2',
        'outline-foreground/50',
        '-outline-offset-2'
      );
    });

    it('renders column headers', () => {
      const columns: TreeTableColumn<TestData>[] = [
        {
          cell: ({ node }) => node.data.name,
          header: 'File Name',
          id: 'name',
        },
        {
          cell: ({ node }) => node.data.size ?? 'N/A',
          header: 'Size',
          id: 'size',
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

    it('supports data-driven cell colSpan and skips covered columns', () => {
      const columns: TreeTableColumn<TestData>[] = [
        {
          cell: ({ node }) => <span>{node.data.name}</span>,
          colSpan: ({ node }) => (node.id === '1' ? 2 : 1),
          header: 'Name',
          id: 'name',
        },
        {
          cell: () => <span>Size cell</span>,
          header: 'Size',
          id: 'size',
        },
      ];

      render(
        <TreeTable
          columns={columns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Spanning row'), createTestNode('2', 'Normal row')]}
          onToggleExpand={() => {}}
          windowingStrategy="none"
        />
      );

      const spanningRow = screen.getByText('Spanning row').closest('tr');
      const normalRow = screen.getByText('Normal row').closest('tr');

      expect(spanningRow?.querySelectorAll('td')).toHaveLength(1);
      expect(spanningRow?.querySelector('td')).toHaveAttribute('colspan', '2');
      expect(normalRow?.querySelectorAll('td')).toHaveLength(2);
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

    it('supports grid role for flat table mode', () => {
      render(
        <TreeTable
          ariaRole="grid"
          columns={testColumns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByRole('grid')).toBeInTheDocument();
      const row = screen.getByText('Test').closest('tr');
      expect(row).not.toHaveAttribute('aria-level');
      expect(row).not.toHaveAttribute('aria-setsize');
      expect(row).not.toHaveAttribute('aria-posinset');
    });

    it('can hide column headers when showHeader is false', () => {
      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onToggleExpand={() => {}}
          showHeader={false}
        />
      );

      expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
      expect(screen.getByText('Test')).toBeInTheDocument();
    });

    it('uses a column id as the resize label when the header is custom content', () => {
      const columns: TreeTableColumn<TestData>[] = [
        {
          cell: ({ node }) => node.data.name,
          defaultWidth: 180,
          header: <span>Custom Header</span>,
          id: 'custom-name',
          maxWidth: 260,
          minWidth: 120,
        },
      ];

      render(
        <TreeTable
          columnSizes={{ 'custom-name': 180 }}
          columns={columns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onColumnSizesChange={() => {}}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByLabelText('Resize custom-name column')).toBeInTheDocument();
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

  describe('windowing strategy', () => {
    it('renders paged rows and page controls when paged strategy is active', () => {
      const handlePageChange = vi.fn();
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
        createTestNode('3', 'File 3'),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          pagination={{ onPageChange: handlePageChange, pageSize: 2 }}
          windowingStrategy="paged"
        />
      );

      expect(screen.getByText('File 1')).toBeInTheDocument();
      expect(screen.getByText('File 2')).toBeInTheDocument();
      expect(screen.queryByText('File 3')).not.toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Go to next page'));

      expect(handlePageChange).toHaveBeenCalledWith(1);
      expect(screen.getByText('File 3')).toBeInTheDocument();
      expect(screen.queryByText('File 1')).not.toBeInTheDocument();
    });

    it('applies controlled pagination page size updates without effect lag', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
        createTestNode('3', 'File 3'),
      ];

      const { rerender } = render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          pagination={{ pageSize: 2 }}
          windowingStrategy="paged"
        />
      );

      expect(screen.getByText('File 1')).toBeInTheDocument();
      expect(screen.getByText('File 2')).toBeInTheDocument();
      expect(screen.queryByText('File 3')).not.toBeInTheDocument();

      rerender(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          pagination={{ pageSize: 1 }}
          windowingStrategy="paged"
        />
      );

      expect(screen.getByText('File 1')).toBeInTheDocument();
      expect(screen.queryByText('File 2')).not.toBeInTheDocument();
      expect(screen.queryByText('File 3')).not.toBeInTheDocument();
    });

    it('keeps paged row slicing when pagination controls are hidden', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
        createTestNode('3', 'File 3'),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          pagination={{ pageSize: 2, showControls: false }}
          windowingStrategy="paged"
        />
      );

      expect(screen.getByText('File 1')).toBeInTheDocument();
      expect(screen.getByText('File 2')).toBeInTheDocument();
      expect(screen.queryByText('File 3')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Go to next page')).not.toBeInTheDocument();
    });

    it('renders all rows without pagination controls when none strategy is active', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
        createTestNode('3', 'File 3'),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          pagination={{ pageSize: 1, showControls: true }}
          windowingStrategy="none"
        />
      );

      expect(screen.getByText('File 1')).toBeInTheDocument();
      expect(screen.getByText('File 2')).toBeInTheDocument();
      expect(screen.getByText('File 3')).toBeInTheDocument();
      expect(screen.queryByLabelText('Go to next page')).not.toBeInTheDocument();
    });

    it('can consume pre-flattened visible rows without recursive expansion gating', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('parent', 'Parent', null, true, 0),
        createTestNode('child', 'Child', 'parent', false, 1),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          nodesArePreFlattened={true}
          onToggleExpand={() => {}}
          windowingStrategy="virtual"
        />
      );

      expect(screen.getByText('Parent')).toBeInTheDocument();
      expect(screen.getByText('Child')).toBeInTheDocument();
    });

    it('renders fallback rows when virtualizer temporarily returns no items', () => {
      virtualizerMode = 'empty';
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
        createTestNode('3', 'File 3'),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          windowingStrategy="virtual"
        />
      );

      expect(screen.getByText('File 1')).toBeInTheDocument();
      expect(screen.getByText('File 2')).toBeInTheDocument();
      expect(screen.getByText('File 3')).toBeInTheDocument();
    });

    it('renders fallback rows when virtualizer returns stale out-of-range indexes', () => {
      virtualizerMode = 'stale';
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
          windowingStrategy="virtual"
        />
      );

      expect(screen.getByText('File 1')).toBeInTheDocument();
      expect(screen.getByText('File 2')).toBeInTheDocument();
    });

    it('does not measure virtual rows when row height is fixed', () => {
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
          rowHeight={32}
          windowingStrategy="virtual"
        />
      );

      expect(virtualizerMocks.measureElement).not.toHaveBeenCalled();
    });

    it('keeps measuring virtual rows when row height is dynamic', async () => {
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
          rowHeight={() => 32}
          windowingStrategy="virtual"
        />
      );

      await waitFor(() => {
        expect(virtualizerMocks.measureElement).toHaveBeenCalled();
      });
    });

    it('keeps focused rows visible after crossing a page boundary', async () => {
      const scrollIntoViewSpy = vi.fn();
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrollIntoViewSpy;

      try {
        const nodes: TreeNode<TestData>[] = [
          createTestNode('1', 'File 1'),
          createTestNode('2', 'File 2'),
          createTestNode('3', 'File 3'),
        ];

        render(
          <TreeTable
            columns={testColumns}
            expandedIds={new Set()}
            nodes={nodes}
            onToggleExpand={() => {}}
            pagination={{ pageSize: 2 }}
            windowingStrategy="paged"
          />
        );

        const tree = screen.getByRole('treegrid');
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // activate -> File 1
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // File 2
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // File 3 (next page)

        await waitFor(() => {
          expect(screen.getByText('File 3')).toBeInTheDocument();
          expect(scrollIntoViewSpy).toHaveBeenCalled();
        });
      } finally {
        Element.prototype.scrollIntoView = originalScrollIntoView;
      }
    });

    it('keeps focused paged rows visible when the target is already on the current page', async () => {
      const scrollIntoViewSpy = vi.fn();
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrollIntoViewSpy;

      try {
        const nodes: TreeNode<TestData>[] = [
          createTestNode('file-one', 'File 1'),
          createTestNode('file-two', 'File 2'),
          createTestNode('file-three', 'File 3'),
        ];

        render(
          <TreeTable
            columns={testColumns}
            expandedIds={new Set()}
            nodes={nodes}
            onToggleExpand={() => {}}
            pagination={{ pageSize: 3 }}
            windowingStrategy="paged"
          />
        );

        const tree = screen.getByRole('treegrid');
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // activate -> File 1
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // File 2 on same page

        await waitFor(() => {
          expect(scrollIntoViewSpy).toHaveBeenCalled();
        });
      } finally {
        Element.prototype.scrollIntoView = originalScrollIntoView;
      }
    });

    it('handles css-special node ids when paged focus crosses boundaries', async () => {
      const scrollIntoViewSpy = vi.fn();
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrollIntoViewSpy;

      try {
        const nodes: TreeNode<TestData>[] = [
          createTestNode('1', 'File 1'),
          createTestNode('2', 'File 2'),
          createTestNode('3[]\'\n"\\\\weird', 'File 3'),
        ];

        render(
          <TreeTable
            columns={testColumns}
            expandedIds={new Set()}
            nodes={nodes}
            onToggleExpand={() => {}}
            pagination={{ pageSize: 2 }}
            windowingStrategy="paged"
          />
        );

        const tree = screen.getByRole('treegrid');
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // activate -> File 1
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // File 2
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // File 3 (next page)

        await waitFor(() => {
          expect(screen.getByText('File 3')).toBeInTheDocument();
          expect(scrollIntoViewSpy).toHaveBeenCalled();
        });
      } finally {
        Element.prototype.scrollIntoView = originalScrollIntoView;
      }
    });

    it('falls back to row-scan lookup when node-id selector misses', async () => {
      const scrollIntoViewSpy = vi.fn();
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrollIntoViewSpy;
      const originalQuerySelector = HTMLElement.prototype.querySelector;
      const querySelectorSpy = vi
        .spyOn(HTMLElement.prototype, 'querySelector')
        .mockImplementation(function querySelectorWithForcedMiss(
          this: HTMLElement,
          selectors: string
        ) {
          if (selectors.startsWith('[data-node-id=')) {
            return null;
          }
          return originalQuerySelector.call(this, selectors);
        });

      try {
        const nodes: TreeNode<TestData>[] = [
          createTestNode('1', 'File 1'),
          createTestNode('2', 'File 2'),
          createTestNode('3', 'File 3'),
        ];

        render(
          <TreeTable
            columns={testColumns}
            expandedIds={new Set()}
            nodes={nodes}
            onToggleExpand={() => {}}
            pagination={{ pageSize: 2 }}
            windowingStrategy="paged"
          />
        );

        const tree = screen.getByRole('treegrid');
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // activate -> File 1
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // File 2
        fireEvent.keyDown(tree, { key: 'ArrowDown' }); // File 3 (next page)

        await waitFor(() => {
          expect(screen.getByText('File 3')).toBeInTheDocument();
          expect(scrollIntoViewSpy).toHaveBeenCalled();
        });
      } finally {
        querySelectorSpy.mockRestore();
        Element.prototype.scrollIntoView = originalScrollIntoView;
      }
    });

    it('keeps auto strategy virtualized in browse mode', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
        createTestNode('3', 'File 3'),
      ];

      render(
        <TreeTable
          autoPagedRowThreshold={2}
          autoWindowingContext="browse"
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          pagination={{ pageSize: 2 }}
          windowingStrategy="auto"
        />
      );

      expect(screen.queryByLabelText('Go to next page')).not.toBeInTheDocument();
      expect(screen.getByText('File 3')).toBeInTheDocument();
    });

    it('switches auto strategy to paged mode for large search result sets', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
        createTestNode('3', 'File 3'),
      ];

      render(
        <TreeTable
          autoPagedRowThreshold={2}
          autoWindowingContext="search"
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          pagination={{ pageSize: 2 }}
          windowingStrategy="auto"
        />
      );

      expect(screen.getByLabelText('Go to next page')).toBeInTheDocument();
      expect(screen.queryByText('File 3')).not.toBeInTheDocument();
    });

    it('falls back to default threshold when autoPagedRowThreshold is NaN', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
        createTestNode('3', 'File 3'),
      ];

      render(
        <TreeTable
          autoPagedRowThreshold={Number.NaN}
          autoWindowingContext="search"
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          pagination={{ pageSize: 2 }}
          windowingStrategy="auto"
        />
      );

      expect(screen.queryByLabelText('Go to next page')).not.toBeInTheDocument();
      expect(screen.getByText('File 3')).toBeInTheDocument();
    });

    it('clamps zero auto paging threshold to search paging for non-empty rows', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
      ];

      render(
        <TreeTable
          autoPagedRowThreshold={0}
          autoWindowingContext="search"
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
          pagination={{ pageSize: 1 }}
          windowingStrategy="auto"
        />
      );

      expect(screen.getByText('File 1')).toBeInTheDocument();
      expect(screen.queryByText('File 2')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Go to next page')).toBeInTheDocument();
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

    it('exposes aria-expanded and icon-xs sizing on row expand buttons', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'Folder', null, true)];
      const { rerender } = render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={() => {}}
        />
      );

      const collapsedButton = screen.getByRole('button', { name: /expand/i });
      expect(collapsedButton).toHaveAttribute('aria-expanded', 'false');
      expect(collapsedButton).toHaveAttribute('data-size', 'icon-xs');

      rerender(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['1'])}
          nodes={nodes}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByRole('button', { name: /collapse/i })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });

    it('does not inset root expand buttons by default', () => {
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
      expect(expandButton.parentElement).not.toHaveClass('pl-1');
    });

    it('insets root expand buttons when tree control inset is enabled', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'Folder', null, true)];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          insetTreeControls
          nodes={nodes}
          onToggleExpand={() => {}}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand/i });
      expect(expandButton.parentElement).toHaveClass('pl-1');
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

    it('disables the expand button while a row is loading and does not toggle', () => {
      const handleToggle = vi.fn();
      const nodes: TreeNode<TestData>[] = [
        {
          ...createTestNode('1', 'Folder', null, true),
          isLoading: true,
        },
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={nodes}
          onToggleExpand={handleToggle}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand/i });
      expect(expandButton).toBeDisabled();

      fireEvent.click(expandButton);
      expect(handleToggle).not.toHaveBeenCalled();
    });

    it('normalizes loading state from loadingNodeIds without preserving stale row loading flags', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('loading-folder', 'Loading folder', null, true),
        {
          ...createTestNode('stale-folder', 'Stale folder', null, true),
          isLoading: true,
        },
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          loadingNodeIds={new Set(['loading-folder'])}
          nodes={nodes}
          onToggleExpand={() => {}}
          windowingStrategy="none"
        />
      );

      const loadingRow = screen.getByRole('row', { name: /Loading folder/i });
      const staleRow = screen.getByRole('row', { name: /Stale folder/i });
      expect(within(loadingRow).getByRole('button', { name: 'Expand' })).toBeDisabled();
      expect(within(staleRow).getByRole('button', { name: 'Expand' })).not.toBeDisabled();
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

  describe('checkbox selection', () => {
    it('selects and deselects a parent with all descendants through row checkboxes', () => {
      const handleMultiSelect = vi.fn();
      const nodes: TreeNode<TestData>[] = [
        createTestNode('parent', 'Parent', null, true, 0),
        createTestNode('child', 'Child', 'parent', false, 1),
      ];

      const { rerender } = render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['parent'])}
          multiSelectedIds={new Set()}
          nodes={nodes}
          onMultiSelectChange={handleMultiSelect}
          onToggleExpand={() => {}}
          selectionMode="multi"
          showCheckbox
          windowingStrategy="none"
        />
      );

      fireEvent.click(screen.getByLabelText('Select parent'));
      const selectedParentCall = handleMultiSelect.mock.calls.at(-1);
      expect(selectedParentCall).toBeDefined();
      const selectedParentIds = selectedParentCall?.[0] as Set<string> | undefined;
      expect(selectedParentIds).toEqual(new Set(['parent', 'child']));

      rerender(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['parent'])}
          multiSelectedIds={new Set(['parent', 'child'])}
          nodes={nodes}
          onMultiSelectChange={handleMultiSelect}
          onToggleExpand={() => {}}
          selectionMode="multi"
          showCheckbox
          windowingStrategy="none"
        />
      );

      expect(screen.getByLabelText('Select parent')).toHaveAttribute('data-state', 'checked');
      fireEvent.click(screen.getByLabelText('Select parent'));
      const deselectedParentCall = handleMultiSelect.mock.calls.at(-1);
      expect(deselectedParentCall).toBeDefined();
      const deselectedParentIds = deselectedParentCall?.[0] as Set<string> | undefined;
      expect(deselectedParentIds).toEqual(new Set());
    });

    it('marks parents indeterminate when only some descendants are selected', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('parent', 'Parent', null, true, 0),
        createTestNode('child-a', 'Child A', 'parent', false, 1),
        createTestNode('child-b', 'Child B', 'parent', false, 1),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['parent'])}
          multiSelectedIds={new Set(['child-a'])}
          nodes={nodes}
          onMultiSelectChange={() => {}}
          onToggleExpand={() => {}}
          selectionMode="multi"
          showCheckbox
          windowingStrategy="none"
        />
      );

      expect(screen.getByLabelText('Select parent')).toHaveAttribute('data-state', 'indeterminate');
    });

    it('uses conservative checkbox state when malformed data contains a cycle', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('cycle-a', 'Cycle A', 'cycle-b', true, 0),
        createTestNode('cycle-b', 'Cycle B', 'cycle-a', true, 1),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['cycle-a', 'cycle-b'])}
          multiSelectedIds={new Set(['cycle-a'])}
          nodes={nodes}
          nodesArePreFlattened={true}
          onMultiSelectChange={() => {}}
          onToggleExpand={() => {}}
          selectionMode="multi"
          showCheckbox
          windowingStrategy="none"
        />
      );

      expect(screen.getByLabelText('Select cycle-a')).toHaveAttribute(
        'data-state',
        'indeterminate'
      );
      expect(screen.getByLabelText('Select cycle-b')).toHaveAttribute(
        'data-state',
        'indeterminate'
      );
    });
  });

  describe('pluggable checkbox API', () => {
    it('renders checkbox state from getCheckboxState, including indeterminate', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('file', 'File', null, true, 0),
        createTestNode('chunk', 'Chunk', 'file', false, 1),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['file'])}
          getCheckboxState={(node) => (node.id === 'file' ? 'indeterminate' : 'checked')}
          nodes={nodes}
          onCheckboxChange={() => {}}
          onToggleExpand={() => {}}
          windowingStrategy="none"
        />
      );

      expect(screen.getByLabelText('Select file')).toHaveAttribute('data-state', 'indeterminate');
      expect(screen.getByLabelText('Select chunk')).toHaveAttribute('data-state', 'checked');
    });

    it('hides the checkbox when getCheckboxState returns hidden or undefined', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('file', 'File', null, true, 0),
        createTestNode('match', 'Match', 'file', false, 1),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['file'])}
          getCheckboxState={(node) => (node.id === 'file' ? 'checked' : 'hidden')}
          nodes={nodes}
          onCheckboxChange={() => {}}
          onToggleExpand={() => {}}
          windowingStrategy="none"
        />
      );

      expect(screen.getByLabelText('Select file')).toBeInTheDocument();
      expect(screen.queryByLabelText('Select match')).not.toBeInTheDocument();
    });

    it('hides the checkbox when getCheckboxState returns undefined', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('file', 'File', null, true, 0),
        createTestNode('match', 'Match', 'file', false, 1),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['file'])}
          getCheckboxState={(node) => (node.id === 'file' ? 'checked' : undefined)}
          nodes={nodes}
          onCheckboxChange={() => {}}
          onToggleExpand={() => {}}
          windowingStrategy="none"
        />
      );

      expect(screen.getByLabelText('Select file')).toBeInTheDocument();
      expect(screen.queryByLabelText('Select match')).not.toBeInTheDocument();
    });

    it('uses getCheckboxAriaLabel when provided, else defaults to Select node.id', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('file', 'File', null, true, 0),
        createTestNode('chunk', 'Chunk', 'file', false, 1),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set(['file'])}
          getCheckboxAriaLabel={(node) => (node.id === 'chunk' ? 'Select lines 8-12' : undefined)}
          getCheckboxState={() => 'unchecked'}
          nodes={nodes}
          onCheckboxChange={() => {}}
          onToggleExpand={() => {}}
          windowingStrategy="none"
        />
      );

      expect(screen.getByLabelText('Select lines 8-12')).toBeInTheDocument();
      expect(screen.getByLabelText('Select file')).toBeInTheDocument();
    });

    it('calls onCheckboxChange with the node and next checked/unchecked state', () => {
      const handleCheckboxChange = vi.fn();
      const nodes: TreeNode<TestData>[] = [
        createTestNode('a', 'A', null, false, 0),
        createTestNode('b', 'B', null, false, 0),
      ];
      const stateById: Record<string, 'checked' | 'unchecked' | 'indeterminate'> = {
        a: 'unchecked',
        b: 'indeterminate',
      };

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          getCheckboxState={(node) => stateById[node.id] ?? 'unchecked'}
          nodes={nodes}
          onCheckboxChange={handleCheckboxChange}
          onToggleExpand={() => {}}
          windowingStrategy="none"
        />
      );

      fireEvent.click(screen.getByLabelText('Select a'));
      expect(handleCheckboxChange).toHaveBeenCalledTimes(1);
      expect(handleCheckboxChange.mock.calls[0]?.[0]).toMatchObject({ id: 'a' });
      expect(handleCheckboxChange.mock.calls[0]?.[1]).toBe('checked');

      fireEvent.click(screen.getByLabelText('Select b'));
      expect(handleCheckboxChange).toHaveBeenCalledTimes(2);
      expect(handleCheckboxChange.mock.calls[1]?.[0]).toMatchObject({ id: 'b' });
      expect(handleCheckboxChange.mock.calls[1]?.[1]).toBe('checked');
    });

    it('toggles checked → unchecked via onCheckboxChange', () => {
      const handleCheckboxChange = vi.fn();
      const nodes: TreeNode<TestData>[] = [createTestNode('a', 'A')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          getCheckboxState={() => 'checked'}
          nodes={nodes}
          onCheckboxChange={handleCheckboxChange}
          onToggleExpand={() => {}}
          windowingStrategy="none"
        />
      );

      fireEvent.click(screen.getByLabelText('Select a'));
      expect(handleCheckboxChange).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a' }),
        'unchecked'
      );
    });

    it('does not fall through to onMultiSelectChange when only getCheckboxState is provided', () => {
      const handleMultiSelect = vi.fn();
      const nodes: TreeNode<TestData>[] = [createTestNode('a', 'A')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          getCheckboxState={() => 'checked'}
          multiSelectedIds={new Set(['a'])}
          nodes={nodes}
          onMultiSelectChange={handleMultiSelect}
          onToggleExpand={() => {}}
          windowingStrategy="none"
        />
      );

      fireEvent.click(screen.getByLabelText('Select a'));
      expect(handleMultiSelect).not.toHaveBeenCalled();
    });

    it('Space does not fall through to onMultiSelectChange in getter-only checkbox mode', () => {
      const handleMultiSelect = vi.fn();
      const nodes: TreeNode<TestData>[] = [createTestNode('a', 'A')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          getCheckboxState={() => 'checked'}
          multiSelectedIds={new Set()}
          nodes={nodes}
          onMultiSelectChange={handleMultiSelect}
          onToggleExpand={() => {}}
          selectionMode="multi"
          windowingStrategy="none"
        />
      );

      const grid = screen.getByRole('treegrid');
      fireEvent.focus(grid);
      fireEvent.keyDown(grid, { key: 'ArrowDown' });
      fireEvent.keyDown(grid, { key: ' ' });
      expect(handleMultiSelect).not.toHaveBeenCalled();
    });

    it('does not call onMultiSelectChange when pluggable onCheckboxChange is provided', () => {
      const handleMultiSelect = vi.fn();
      const handleCheckboxChange = vi.fn();
      const nodes: TreeNode<TestData>[] = [createTestNode('a', 'A')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          getCheckboxState={() => 'unchecked'}
          multiSelectedIds={new Set()}
          nodes={nodes}
          onCheckboxChange={handleCheckboxChange}
          onMultiSelectChange={handleMultiSelect}
          onToggleExpand={() => {}}
          selectionMode="multi"
          showCheckbox
          windowingStrategy="none"
        />
      );

      fireEvent.click(screen.getByLabelText('Select a'));
      expect(handleCheckboxChange).toHaveBeenCalled();
      expect(handleMultiSelect).not.toHaveBeenCalled();
    });

    it('Space on a focused row invokes pluggable onCheckboxChange', () => {
      const handleCheckboxChange = vi.fn();
      const nodes: TreeNode<TestData>[] = [createTestNode('a', 'A')];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          getCheckboxState={() => 'unchecked'}
          nodes={nodes}
          onCheckboxChange={handleCheckboxChange}
          onToggleExpand={() => {}}
          windowingStrategy="none"
        />
      );

      const table = screen.getByRole('treegrid');
      fireEvent.keyDown(table, { key: 'ArrowDown' });
      fireEvent.keyDown(table, { key: ' ' });

      expect(handleCheckboxChange).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a' }),
        'checked'
      );
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

    it('handles shift range selection using lowest selected row as fallback anchor', () => {
      const handleMultiSelect = vi.fn();
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File 1'),
        createTestNode('2', 'File 2'),
        createTestNode('3', 'File 3'),
      ];

      render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          multiSelectedIds={new Set(['3'])}
          nodes={nodes}
          onMultiSelectChange={handleMultiSelect}
          onToggleExpand={() => {}}
          selectedId={null}
          selectionMode="multi"
        />
      );

      const row1 = screen.getByText('File 1').closest('tr');
      if (row1) {
        fireEvent.click(row1, { shiftKey: true });
      }

      const firstCall = handleMultiSelect.mock.calls[0];
      expect(firstCall).toBeDefined();
      const rangeSelection = firstCall?.[0] as Set<string> | undefined;
      expect(rangeSelection?.has('1')).toBe(true);
      expect(rangeSelection?.has('2')).toBe(true);
      expect(rangeSelection?.has('3')).toBe(true);
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
          cell: ({ node }) => node.data.name,
          header: 'Name',
          id: 'name',
          sortable: true,
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

    it('renders descending and unsorted aria states for active sortable headers', () => {
      const columns: TreeTableColumn<TestData>[] = [
        {
          cell: ({ node }) => node.data.name,
          header: 'Name',
          id: 'name',
          sortable: true,
        },
      ];

      const { rerender } = render(
        <TreeTable
          columns={columns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onSortChange={() => {}}
          onToggleExpand={() => {}}
          sortState={{ columnId: 'name', direction: 'desc' }}
        />
      );

      expect(screen.getByText('↓')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: /name/i })).toHaveAttribute(
        'aria-sort',
        'descending'
      );

      rerender(
        <TreeTable
          columns={columns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onSortChange={() => {}}
          onToggleExpand={() => {}}
          sortState={{ columnId: 'name', direction: null }}
        />
      );

      expect(screen.queryByText('↓')).not.toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: /name/i })).toHaveAttribute(
        'aria-sort',
        'none'
      );
    });

    it('calls onSortChange when sortable column header clicked', () => {
      const handleSort = vi.fn();
      const columns: TreeTableColumn<TestData>[] = [
        {
          cell: ({ node }) => node.data.name,
          header: 'Name',
          id: 'name',
          sortable: true,
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
          cell: ({ node }) => node.data.name,
          header: 'Name',
          id: 'name',
          sortable: true,
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
    it('uses one full-height scrollport for table overflow, virtualization, and sticky headers', () => {
      const { container } = render(
        <TreeTable
          columns={testColumns}
          expandedIds={new Set()}
          nodes={[createTestNode('1', 'Test')]}
          onToggleExpand={() => {}}
          viewportClassName="pb-20"
        />
      );

      const root = container.firstElementChild;
      expect(root).toHaveClass('h-full', 'min-h-0', 'min-w-0');

      const scrollport = root?.firstElementChild;
      const treegrid = screen.getByRole('treegrid');
      expect(scrollport).toHaveClass(
        'relative',
        'min-h-0',
        'min-w-0',
        'flex-1',
        'overflow-auto',
        'pb-20'
      );
      expect(scrollport).toHaveStyle({ maxHeight: '600px' });
      expect(treegrid.parentElement).toBe(scrollport);

      const header = treegrid.querySelector('thead');
      expect(header).toHaveClass('sticky', 'top-0', 'z-10', 'bg-background');
      expect(header?.closest('.overflow-auto')).toBe(scrollport);
    });

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

describe('TreeTable — consumer-provided onCheckboxSpace', () => {
  const spaceNodes = [createTestNode('a', 'Alpha'), createTestNode('b', 'Beta')];

  function renderWithSpaceHandler(overrides: {
    onCheckboxSpace?: (nodeId: string) => boolean;
    onSelect?: (id: string | null) => void;
  }) {
    render(
      <TreeTable
        ariaLabel="Space grid"
        columns={testColumns}
        expandedIds={new Set()}
        nodes={spaceNodes}
        onToggleExpand={vi.fn()}
        selectedId={null}
        selectionMode="single"
        {...(overrides.onSelect ? { onSelect: overrides.onSelect } : {})}
        {...(overrides.onCheckboxSpace ? { onCheckboxSpace: overrides.onCheckboxSpace } : {})}
      />
    );
    const grid = screen.getByRole('treegrid', { name: 'Space grid' });
    grid.focus();
    // Activate roving focus and land on the first row.
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    return grid;
  }

  it('routes Space to a consumer onCheckboxSpace (checkbox toggle), not row selection', () => {
    // Even in single-select mode with a custom in-cell checkbox, Space must
    // toggle selection via the consumer handler instead of activating the row
    // (which would open the file) — APG: Space toggles, Enter activates.
    const onCheckboxSpace = vi.fn().mockReturnValue(true);
    const onSelect = vi.fn();
    const grid = renderWithSpaceHandler({ onCheckboxSpace, onSelect });

    fireEvent.keyDown(grid, { key: ' ' });

    expect(onCheckboxSpace).toHaveBeenCalledWith('a');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Enter still activates the row (open) while Space toggles', () => {
    const onCheckboxSpace = vi.fn().mockReturnValue(true);
    const onSelect = vi.fn();
    const grid = renderWithSpaceHandler({ onCheckboxSpace, onSelect });

    fireEvent.keyDown(grid, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('a');
    expect(onCheckboxSpace).not.toHaveBeenCalled();
  });
});
