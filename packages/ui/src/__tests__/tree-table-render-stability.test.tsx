/**
 * Render-stability tests for TreeTable.
 *
 * TreeTableRow is React.memo'd; these tests pin the contract that a TreeTable
 * re-render with unchanged inputs does NOT re-render rows or re-measure them.
 * Unstable per-render identities (row onClick, measure ref) silently defeat
 * the memo and turn every scroll/focus/selection update into a full visible-
 * row re-render across every TreeTable consumer.
 */
import { render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeTable } from '../tree-table/tree-table';
import type { FlattenedRow, TreeNode, TreeTableColumn } from '../tree-table/types';
import { type UseTreeKeyboardOptions, useTreeKeyboard } from '../tree-table/use-tree-keyboard';

const virtualizerMocks = vi.hoisted(() => ({
  measureElement: vi.fn(),
}));

// Mock @tanstack/react-virtual to avoid JSDOM dimension issues. Unlike the
// mock in tree-table.test.tsx this returns a STABLE instance across renders,
// mirroring the real library (useVirtualizer creates one Virtualizer via
// useState and mutates its options) — identity-stability tests would otherwise
// fail against mock churn the real dependency does not have.
vi.mock('@tanstack/react-virtual', () => {
  const state = { count: 0 };
  const instance = {
    getTotalSize: () => state.count * 40,
    getVirtualItems: () =>
      Array.from({ length: state.count }, (_, i) => ({
        end: (i + 1) * 40,
        index: i,
        key: `item-${i}`,
        size: 40,
        start: i * 40,
      })),
    measureElement: virtualizerMocks.measureElement,
    scrollToIndex: vi.fn(),
  };
  return {
    useVirtualizer: vi.fn(({ count }: { count: number }) => {
      state.count = count;
      return instance;
    }),
  };
});

interface TestData {
  name: string;
}

function createTestNode(id: string, name: string): TreeNode<TestData> {
  return {
    data: { name },
    depth: 0,
    hasChildren: false,
    id,
    parentId: null,
    type: 'file',
  };
}

function buildKeyboardOptions(
  overrides: Partial<UseTreeKeyboardOptions<TestData>> = {}
): UseTreeKeyboardOptions<TestData> {
  const nodes = [createTestNode('a', 'A'), createTestNode('b', 'B')];
  const rows: FlattenedRow<TestData>[] = nodes.map((node, index) => ({
    aria: { ariaLevel: 1, ariaPosInSet: index + 1, ariaRowIndex: index + 1, ariaSetSize: 2 },
    index,
    isExpanded: false,
    isHighlighted: false,
    isInContext: false,
    isSelected: false,
    matchesFilter: true,
    node,
  }));
  return {
    expandedIds: new Set<string>(),
    getChildren: () => [],
    nodes,
    onToggleExpand: () => {},
    rowIndexById: new Map(rows.map((row, index) => [row.node.id, index])),
    rows,
    selectionMode: 'single',
    ...overrides,
  };
}

describe('useTreeKeyboard render stability', () => {
  it('returns an identity-stable actions object across re-renders with unchanged options', () => {
    const options = buildKeyboardOptions();
    const { rerender, result } = renderHook(
      (props: UseTreeKeyboardOptions<TestData>) => useTreeKeyboard(props),
      {
        initialProps: options,
      }
    );

    const firstActions = result.current.actions;
    rerender(options);

    expect(result.current.actions).toBe(firstActions);
  });
});

describe('TreeTable row render stability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const nodes: TreeNode<TestData>[] = [
    createTestNode('1', 'File 1'),
    createTestNode('2', 'File 2'),
    createTestNode('3', 'File 3'),
  ];

  it('does not re-render rows when TreeTable re-renders with unchanged props', () => {
    const cellRenders = vi.fn();
    const columns: TreeTableColumn<TestData>[] = [
      {
        cell: ({ node }) => {
          cellRenders(node.id);
          return <span>{node.data.name}</span>;
        },
        header: 'Name',
        id: 'name',
      },
    ];
    const expandedIds = new Set<string>();
    const onToggleExpand = () => {};
    const onSelect = () => {};

    const view = render(
      <TreeTable
        columns={columns}
        expandedIds={expandedIds}
        nodes={nodes}
        onSelect={onSelect}
        onToggleExpand={onToggleExpand}
        rowHeight={40}
        selectionMode="single"
      />
    );
    const rendersAfterMount = cellRenders.mock.calls.length;
    expect(rendersAfterMount).toBeGreaterThan(0);

    // Same element, same prop identities: the memo'd rows must bail out.
    view.rerender(
      <TreeTable
        columns={columns}
        expandedIds={expandedIds}
        nodes={nodes}
        onSelect={onSelect}
        onToggleExpand={onToggleExpand}
        rowHeight={40}
        selectionMode="single"
      />
    );

    expect(cellRenders.mock.calls.length).toBe(rendersAfterMount);
  });

  it('does not re-measure rows on a re-render with unchanged props (variable row height)', () => {
    const columns: TreeTableColumn<TestData>[] = [
      {
        cell: ({ node }) => <span>{node.data.name}</span>,
        header: 'Name',
        id: 'name',
      },
    ];
    const expandedIds = new Set<string>();
    const onToggleExpand = () => {};

    // No fixed rowHeight → rows get the measure callback ref. An unstable ref
    // identity forces React to detach/re-attach it every commit, triggering a
    // synchronous measureElement (layout read) per visible row per render.
    const view = render(
      <TreeTable
        columns={columns}
        expandedIds={expandedIds}
        nodes={nodes}
        onToggleExpand={onToggleExpand}
        windowingStrategy="virtual"
      />
    );
    const measuresAfterMount = virtualizerMocks.measureElement.mock.calls.length;

    view.rerender(
      <TreeTable
        columns={columns}
        expandedIds={expandedIds}
        nodes={nodes}
        onToggleExpand={onToggleExpand}
        windowingStrategy="virtual"
      />
    );

    expect(virtualizerMocks.measureElement.mock.calls.length).toBe(measuresAfterMount);
  });

  it('does not re-render unaffected rows when the multi-selection changes', () => {
    const cellRenders = vi.fn();
    const columns: TreeTableColumn<TestData>[] = [
      {
        cell: ({ node }) => {
          cellRenders(node.id);
          return <span>{node.data.name}</span>;
        },
        header: 'Name',
        id: 'name',
      },
    ];
    const expandedIds = new Set<string>();
    const onToggleExpand = () => {};
    const onMultiSelectChange = () => {};

    const props = {
      columns,
      expandedIds,
      nodes,
      onMultiSelectChange,
      onToggleExpand,
      rowHeight: 40,
      selectionMode: 'multi' as const,
    };

    const view = render(<TreeTable {...props} multiSelectedIds={new Set<string>()} />);
    const row3RendersAfterMount = cellRenders.mock.calls.filter(([id]) => id === '3').length;

    // Selecting row 1 must not re-render row 3.
    view.rerender(<TreeTable {...props} multiSelectedIds={new Set(['1'])} />);

    const row3RendersAfterSelection = cellRenders.mock.calls.filter(([id]) => id === '3').length;
    expect(row3RendersAfterSelection).toBe(row3RendersAfterMount);
    // Row 1 DID re-render (its checkbox state changed).
    expect(cellRenders.mock.calls.filter(([id]) => id === '1').length).toBeGreaterThan(
      row3RendersAfterMount
    );
  });
});
