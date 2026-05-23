/**
 * Tests for TreeTable column resizing.
 *
 * Red-phase: these tests target the resizable-columns API that
 * `packages/ui/src/tree-table/*` does not yet expose. They are expected to
 * fail until the resize handle component, controlled/uncontrolled sizing
 * props, pointer/keyboard mechanics, and sort isolation are implemented.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeTable } from '../tree-table/tree-table';
import type { TreeNode, TreeTableColumn } from '../tree-table/types';

// Mock @tanstack/react-virtual so all rows render synchronously in JSDOM.
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
  observeElementRect: vi.fn(),
}));

interface RowData {
  name: string;
}

function buildNode(id: string, name: string): TreeNode<RowData> {
  return {
    id,
    type: 'file',
    depth: 0,
    parentId: null,
    hasChildren: false,
    data: { name },
  };
}

const NODES: TreeNode<RowData>[] = [buildNode('1', 'Alpha'), buildNode('2', 'Beta')];

/**
 * Build a column with sensible resize defaults. Override `resizable` to opt
 * out, or fix `width === minWidth === maxWidth` to make a column inherently
 * non-resizable (the utility-column pattern used by collection-browser).
 */
function buildColumns(
  overrides: Partial<TreeTableColumn<RowData>>[] = []
): TreeTableColumn<RowData>[] {
  const defaults: TreeTableColumn<RowData>[] = [
    {
      id: 'name',
      header: 'Name',
      defaultWidth: 200,
      minWidth: 80,
      maxWidth: 400,
      cell: ({ node }) => <span>{node.data.name}</span>,
    },
    {
      id: 'size',
      header: 'Size',
      defaultWidth: 120,
      minWidth: 60,
      maxWidth: 300,
      cell: ({ node }) => <span>{node.data.name.length}</span>,
    },
  ];
  return defaults.map((col, i) => ({ ...col, ...(overrides[i] ?? {}) }));
}

/**
 * Stub getBoundingClientRect for the header `<th>` so pointer-delta math has a
 * stable starting width. JSDOM returns zeros otherwise.
 */
function stubHeaderRect(handle: HTMLElement, leftEdge: number, rightEdge: number): void {
  const header = handle.closest('th');
  if (!header) {
    throw new Error('Resize handle must live inside a <th> element');
  }
  header.getBoundingClientRect = () =>
    ({
      left: leftEdge,
      right: rightEdge,
      top: 0,
      bottom: 40,
      width: rightEdge - leftEdge,
      height: 40,
      x: leftEdge,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe('TreeTable column resize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handle rendering', () => {
    it('renders an accessible resize handle for each resizable column', () => {
      render(
        <TreeTable
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onToggleExpand={() => {}}
        />
      );

      const nameHandle = screen.getByRole('separator', { name: /resize name/i });
      const sizeHandle = screen.getByRole('separator', { name: /resize size/i });
      expect(nameHandle).toHaveAttribute('aria-orientation', 'vertical');
      expect(sizeHandle).toHaveAttribute('aria-orientation', 'vertical');
    });

    it('omits the resize handle when a column opts out via resizable: false', () => {
      render(
        <TreeTable
          columns={buildColumns([{}, { resizable: false }])}
          expandedIds={new Set()}
          nodes={NODES}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.queryByRole('separator', { name: /resize name/i })).toBeInTheDocument();
      expect(screen.queryByRole('separator', { name: /resize size/i })).not.toBeInTheDocument();
    });

    it('omits the resize handle when a utility column is fixed (width = min = max)', () => {
      render(
        <TreeTable
          columns={[
            ...buildColumns(),
            {
              id: 'status',
              header: 'Status',
              width: 44,
              minWidth: 44,
              maxWidth: 44,
              cell: () => <span>•</span>,
            },
          ]}
          expandedIds={new Set()}
          nodes={NODES}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.queryByRole('separator', { name: /resize status/i })).not.toBeInTheDocument();
    });
  });

  describe('controlled sizing API', () => {
    it('renders the supplied columnSizes width on the header cell', () => {
      render(
        <TreeTable
          columnSizes={{ name: 240, size: 96 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onToggleExpand={() => {}}
        />
      );

      // The resize handle's aria-label ("Resize {name} column") also contains
      // the column label, so use an anchored regex to disambiguate from
      // "Resize Name column" / "Resize Size column".
      const nameHeader = screen.getByRole('columnheader', { name: /^Name\b/i });
      const sizeHeader = screen.getByRole('columnheader', { name: /^Size\b/i });
      expect(nameHeader).toHaveStyle({ width: '240px' });
      expect(sizeHeader).toHaveStyle({ width: '96px' });
    });

    it('emits onColumnSizesChange with the next full map after pointer drag', () => {
      const onColumnSizesChange = vi.fn();
      render(
        <TreeTable
          columnSizes={{ name: 200, size: 120 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={onColumnSizesChange}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      stubHeaderRect(handle, 0, 200);

      fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1, button: 0 });
      fireEvent.pointerMove(window, { clientX: 250, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 250, pointerId: 1 });

      expect(onColumnSizesChange).toHaveBeenCalled();
      const lastCall = onColumnSizesChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual(expect.objectContaining({ name: 250, size: 120 }));
    });
  });

  describe('uncontrolled sizing with defaultWidth', () => {
    it('uses defaultWidth when no columnSizes prop is supplied', () => {
      render(
        <TreeTable
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onToggleExpand={() => {}}
        />
      );

      const nameHeader = screen.getByRole('columnheader', { name: /name/i });
      expect(nameHeader).toHaveStyle({ width: '200px' });
    });

    it('updates internal width on pointer drag in uncontrolled mode', () => {
      render(
        <TreeTable
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      stubHeaderRect(handle, 0, 200);

      fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1, button: 0 });
      fireEvent.pointerMove(window, { clientX: 260, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 260, pointerId: 1 });

      const nameHeader = screen.getByRole('columnheader', { name: /name/i });
      expect(nameHeader).toHaveStyle({ width: '260px' });
    });
  });

  describe('clamping', () => {
    it('clamps to minWidth when dragging below the minimum', () => {
      const onColumnSizesChange = vi.fn();
      render(
        <TreeTable
          columnSizes={{ name: 200, size: 120 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={onColumnSizesChange}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      stubHeaderRect(handle, 0, 200);

      fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1, button: 0 });
      fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 0, pointerId: 1 });

      const lastCall = onColumnSizesChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual(expect.objectContaining({ name: 80 }));
    });

    it('clamps to maxWidth when dragging beyond the maximum', () => {
      const onColumnSizesChange = vi.fn();
      render(
        <TreeTable
          columnSizes={{ name: 200, size: 120 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={onColumnSizesChange}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      stubHeaderRect(handle, 0, 200);

      fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1, button: 0 });
      fireEvent.pointerMove(window, { clientX: 10_000, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 10_000, pointerId: 1 });

      const lastCall = onColumnSizesChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual(expect.objectContaining({ name: 400 }));
    });
  });

  describe('keyboard resize', () => {
    it('decreases width by 8px on ArrowLeft', () => {
      const onColumnSizesChange = vi.fn();
      render(
        <TreeTable
          columnSizes={{ name: 200, size: 120 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={onColumnSizesChange}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      act(() => {
        handle.focus();
      });
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });

      const lastCall = onColumnSizesChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual(expect.objectContaining({ name: 192 }));
    });

    it('increases width by 32px on Shift+ArrowRight', () => {
      const onColumnSizesChange = vi.fn();
      render(
        <TreeTable
          columnSizes={{ name: 200, size: 120 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={onColumnSizesChange}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      act(() => {
        handle.focus();
      });
      fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });

      const lastCall = onColumnSizesChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual(expect.objectContaining({ name: 232 }));
    });

    it('jumps to minWidth on Home and maxWidth on End', () => {
      const onColumnSizesChange = vi.fn();
      render(
        <TreeTable
          columnSizes={{ name: 200, size: 120 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={onColumnSizesChange}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      act(() => {
        handle.focus();
      });
      fireEvent.keyDown(handle, { key: 'Home' });
      expect(onColumnSizesChange.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ name: 80 })
      );

      fireEvent.keyDown(handle, { key: 'End' });
      expect(onColumnSizesChange.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ name: 400 })
      );
    });
  });

  describe('sort isolation', () => {
    it('does not trigger sort when the resize handle is activated', () => {
      const onSortChange = vi.fn();
      render(
        <TreeTable
          columns={buildColumns([{ sortable: true }, { sortable: true }])}
          expandedIds={new Set()}
          nodes={NODES}
          onSortChange={onSortChange}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      stubHeaderRect(handle, 0, 200);

      fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1, button: 0 });
      fireEvent.pointerMove(window, { clientX: 230, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 230, pointerId: 1 });
      // Some browsers fire click after pointerup on the same target.
      fireEvent.click(handle);

      expect(onSortChange).not.toHaveBeenCalled();
    });
  });

  describe('ARIA treegrid invariants', () => {
    it('still exposes the treegrid role and column headers when resizing is active', () => {
      render(
        <TreeTable
          columns={buildColumns([{ sortable: true }, { sortable: true }])}
          expandedIds={new Set()}
          nodes={NODES}
          onToggleExpand={() => {}}
        />
      );

      expect(screen.getByRole('treegrid')).toBeInTheDocument();
      expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    });
  });

  describe('double-click reset', () => {
    it('resets the column to defaultWidth on handle double-click', () => {
      const onColumnSizesChange = vi.fn();
      render(
        <TreeTable
          columnSizes={{ name: 350, size: 120 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={onColumnSizesChange}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      fireEvent.doubleClick(handle);

      const lastCall = onColumnSizesChange.mock.calls.at(-1);
      // Name column declares defaultWidth: 200 in buildColumns().
      expect(lastCall?.[0]).toEqual(expect.objectContaining({ name: 200 }));
    });

    it('does not bubble a sort click when the handle is double-clicked', () => {
      const onSortChange = vi.fn();
      const onColumnSizesChange = vi.fn();
      render(
        <TreeTable
          columnSizes={{ name: 350, size: 120 }}
          columns={buildColumns([{ sortable: true }, { sortable: true }])}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={onColumnSizesChange}
          onSortChange={onSortChange}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      fireEvent.doubleClick(handle);

      // Resize fired, but sort did not.
      expect(onColumnSizesChange).toHaveBeenCalled();
      expect(onSortChange).not.toHaveBeenCalled();
    });
  });

  describe('hidden-column width preservation', () => {
    it('preserves persisted widths for columns not currently rendered (Codex P2 regression)', () => {
      const onColumnSizesChange = vi.fn();
      // Simulates the collection-browser case: the user previously resized
      // the optional `score` column (only rendered in semantic search mode),
      // then resizes `name` while in browse mode. The hidden `score` width
      // must survive the emit so the persistence store doesn't drop it.
      render(
        <TreeTable
          columnSizes={{ name: 200, size: 120, score: 250 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={onColumnSizesChange}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      act(() => {
        handle.focus();
      });
      fireEvent.keyDown(handle, { key: 'ArrowRight' });

      const lastCall = onColumnSizesChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual(
        expect.objectContaining({
          name: 208,
          size: 120,
          // The score entry is NOT a rendered column here but must round-trip
          // back to the consumer so the persistence store keeps it.
          score: 250,
        })
      );
    });
  });

  describe('listener lifecycle', () => {
    it('removes window pointer listeners after pointerup', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');

      render(
        <TreeTable
          columnSizes={{ name: 200, size: 120 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={() => {}}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      stubHeaderRect(handle, 0, 200);

      const initialPointerMoveAdds = addSpy.mock.calls.filter(
        (call) => String(call[0]) === 'pointermove'
      ).length;
      fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1, button: 0 });
      fireEvent.pointerUp(window, { clientX: 210, pointerId: 1 });

      const finalPointerMoveAdds = addSpy.mock.calls.filter(
        (call) => String(call[0]) === 'pointermove'
      ).length;
      const finalPointerMoveRemoves = removeSpy.mock.calls.filter(
        (call) => String(call[0]) === 'pointermove'
      ).length;

      // Exactly one add → exactly one remove during the drag lifecycle.
      expect(finalPointerMoveAdds - initialPointerMoveAdds).toBe(1);
      expect(finalPointerMoveRemoves).toBeGreaterThanOrEqual(1);

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('detaches in-flight pointer listeners when the component unmounts mid-drag', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = render(
        <TreeTable
          columnSizes={{ name: 200, size: 120 }}
          columns={buildColumns()}
          expandedIds={new Set()}
          nodes={NODES}
          onColumnSizesChange={() => {}}
          onToggleExpand={() => {}}
        />
      );

      const handle = screen.getByRole('separator', { name: /resize name/i });
      stubHeaderRect(handle, 0, 200);

      // Start drag but do NOT release.
      fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1, button: 0 });
      fireEvent.pointerMove(window, { clientX: 220, pointerId: 1 });

      const removesBeforeUnmount = removeSpy.mock.calls.filter(
        (call) => String(call[0]) === 'pointermove'
      ).length;
      unmount();
      const removesAfterUnmount = removeSpy.mock.calls.filter(
        (call) => String(call[0]) === 'pointermove'
      ).length;

      // Unmount must have torn down the in-flight pointermove listener.
      expect(removesAfterUnmount).toBeGreaterThan(removesBeforeUnmount);

      removeSpy.mockRestore();
    });
  });
});
