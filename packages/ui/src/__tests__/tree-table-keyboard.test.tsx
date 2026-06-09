/**
 * Keyboard navigation integration tests for useTreeKeyboard hook.
 *
 * Tests arrow-key navigation, expand/collapse, selection, multi-select,
 * Home/End, Escape, and focus persistence after data changes.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildTreeFromFlatNodes, createChildrenGetter } from '../tree-table/tree-utils';
import type { FlattenedRow, TreeNode } from '../tree-table/types';
import { type UseTreeKeyboardOptions, useTreeKeyboard } from '../tree-table/use-tree-keyboard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestData {
  name: string;
}

function makeNode(
  id: string,
  name: string,
  parentId: string | null = null,
  hasChildren = false,
  depth = 0
): TreeNode<TestData> {
  return { id, type: 'file', depth, data: { name }, parentId, hasChildren };
}

function makeRow(n: TreeNode<TestData>, index: number, isExpanded = false): FlattenedRow<TestData> {
  return {
    node: n,
    index,
    isExpanded,
    isSelected: false,
    isHighlighted: false,
    isInContext: false,
    matchesFilter: true,
    aria: {
      ariaLevel: n.depth + 1,
      ariaSetSize: 1,
      ariaPosInSet: 1,
      ariaRowIndex: index + 2,
    },
  };
}

function keyEvent(key: string, opts: Partial<React.KeyboardEvent> = {}): React.KeyboardEvent {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    target: document.createElement('div'),
    ...opts,
  } as unknown as React.KeyboardEvent;
}

/** Build a simple flat three-node tree for basic navigation tests. */
function buildSimpleTree(): {
  nodes: TreeNode<TestData>[];
  rows: FlattenedRow<TestData>[];
  getChildren: (node: TreeNode<TestData>) => TreeNode<TestData>[];
} {
  const nodes = [makeNode('a', 'Alpha'), makeNode('b', 'Bravo'), makeNode('c', 'Charlie')];
  const rows = nodes.map((n, i) => makeRow(n, i));
  const getChildren = () => [] as TreeNode<TestData>[];
  return { nodes, rows, getChildren };
}

/** Build a parent-child tree for expand/collapse tests. */
function buildParentChildTree(): {
  allNodes: TreeNode<TestData>[];
  expandedRows: FlattenedRow<TestData>[];
  collapsedRows: FlattenedRow<TestData>[];
  getChildren: (node: TreeNode<TestData>) => TreeNode<TestData>[];
} {
  const allNodes = [
    makeNode('parent', 'Parent', null, true, 0),
    makeNode('child1', 'Child 1', 'parent', false, 1),
    makeNode('child2', 'Child 2', 'parent', false, 1),
    makeNode('sibling', 'Sibling', null, false, 0),
  ];
  const getChildren = createChildrenGetter(allNodes);

  const expandedRows = [
    makeRow(allNodes[0]!, 0, true),
    makeRow(allNodes[1]!, 1),
    makeRow(allNodes[2]!, 2),
    makeRow(allNodes[3]!, 3),
  ];

  const collapsedRows = [makeRow(allNodes[0]!, 0, false), makeRow(allNodes[3]!, 1)];

  return { allNodes, expandedRows, collapsedRows, getChildren };
}

function defaultOptions(
  overrides: Partial<UseTreeKeyboardOptions<TestData>> = {}
): UseTreeKeyboardOptions<TestData> {
  const { nodes, rows, getChildren } = buildSimpleTree();
  const rowIndexById = new Map<string, number>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }
    rowIndexById.set(row.node.id, index);
  }

  const options: UseTreeKeyboardOptions<TestData> = {
    rows,
    rowIndexById,
    nodes,
    getChildren,
    expandedIds: new Set<string>(),
    onToggleExpand: vi.fn(),
    selectionMode: 'single',
    onSelect: vi.fn(),
    isTableFocused: true,
    ...overrides,
  };

  if (overrides.rows && !overrides.rowIndexById) {
    const overrideIndexById = new Map<string, number>();
    for (let index = 0; index < overrides.rows.length; index += 1) {
      const row = overrides.rows[index];
      if (!row) {
        continue;
      }
      overrideIndexById.set(row.node.id, index);
    }
    options.rowIndexById = overrideIndexById;
  }

  return options;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTreeKeyboard — arrow navigation', () => {
  it('ArrowDown moves focus to next row', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    // Activate navigation
    act(() => {
      result.current.onKeyDown(keyEvent('ArrowDown'));
    });

    // First press activates and sets focus to first row
    expect(result.current.state.focusedId).toBe('a');

    // Next press moves to second
    act(() => {
      result.current.onKeyDown(keyEvent('ArrowDown'));
    });
    expect(result.current.state.focusedId).toBe('b');
  });

  it('ArrowUp moves focus to previous row', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    // Set focus to last row
    act(() => {
      result.current.actions.setFocus('c');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('ArrowUp'));
    });
    expect(result.current.state.focusedId).toBe('b');
  });

  it('ArrowUp from first row stays on first row', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('a');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('ArrowUp'));
    });
    // Should remain on 'a' (getNextVisibleNodeId returns null at boundary)
    expect(result.current.state.focusedId).toBe('a');
  });

  it('ArrowDown from last row stays on last row', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('c');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('ArrowDown'));
    });
    expect(result.current.state.focusedId).toBe('c');
  });

  it('public move actions choose edge rows when focus is not set', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.moveDown();
    });
    expect(result.current.state.focusedId).toBe('a');

    act(() => {
      result.current.actions.reset();
    });

    act(() => {
      result.current.actions.moveUp();
    });
    expect(result.current.state.focusedId).toBe('c');
  });

  it('moves to the first row when the current focused id is stale', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('missing');
      result.current.actions.moveDown();
    });

    expect(result.current.state.focusedId).toBe('a');
  });

  it('does not move when there are no visible rows', () => {
    const opts = defaultOptions({
      rows: [],
      rowIndexById: new Map(),
    });
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.moveDown();
      result.current.actions.moveUp();
    });

    expect(result.current.state.focusedId).toBeNull();
  });
});

describe('useTreeKeyboard — Home and End', () => {
  it('Home moves to first row', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('c');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('Home'));
    });
    expect(result.current.state.focusedId).toBe('a');
  });

  it('End moves to last row', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('a');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('End'));
    });
    expect(result.current.state.focusedId).toBe('c');
  });
});

describe('useTreeKeyboard — expand/collapse', () => {
  it('ArrowRight on collapsed expandable node calls onToggleExpand', () => {
    const { allNodes, collapsedRows, getChildren } = buildParentChildTree();
    const onToggleExpand = vi.fn();
    const roots = buildTreeFromFlatNodes(allNodes);

    const opts = defaultOptions({
      rows: collapsedRows,
      nodes: roots,
      getChildren,
      onToggleExpand,
    });

    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('parent');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('ArrowRight'));
    });

    expect(onToggleExpand).toHaveBeenCalledWith('parent');
  });

  it('ArrowRight on expanded node moves focus to first child', () => {
    const { allNodes, expandedRows, getChildren } = buildParentChildTree();
    const roots = buildTreeFromFlatNodes(allNodes);

    const opts = defaultOptions({
      rows: expandedRows,
      nodes: roots,
      getChildren,
      expandedIds: new Set(['parent']),
    });

    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('parent');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('ArrowRight'));
    });

    expect(result.current.state.focusedId).toBe('child1');
  });

  it('ArrowLeft on expanded node calls onToggleExpand to collapse', () => {
    const { allNodes, expandedRows, getChildren } = buildParentChildTree();
    const onToggleExpand = vi.fn();
    const roots = buildTreeFromFlatNodes(allNodes);

    const opts = defaultOptions({
      rows: expandedRows,
      nodes: roots,
      getChildren,
      expandedIds: new Set(['parent']),
      onToggleExpand,
    });

    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('parent');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('ArrowLeft'));
    });

    expect(onToggleExpand).toHaveBeenCalledWith('parent');
  });

  it('ArrowLeft on leaf node moves focus to parent', () => {
    const { allNodes, expandedRows, getChildren } = buildParentChildTree();
    const roots = buildTreeFromFlatNodes(allNodes);

    const opts = defaultOptions({
      rows: expandedRows,
      nodes: roots,
      getChildren,
      expandedIds: new Set(['parent']),
    });

    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('child1');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('ArrowLeft'));
    });

    expect(result.current.state.focusedId).toBe('parent');
  });

  it('ignores expand and collapse requests when focus is missing or stale', () => {
    const onToggleExpand = vi.fn();
    const onScrollToNode = vi.fn();
    const opts = defaultOptions({ onScrollToNode, onToggleExpand });
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.expandOrMoveRight();
      result.current.actions.collapseOrMoveLeft();
    });

    act(() => {
      result.current.actions.setFocus('missing');
      result.current.actions.expandOrMoveRight();
      result.current.actions.collapseOrMoveLeft();
    });

    expect(onToggleExpand).not.toHaveBeenCalled();
    expect(onScrollToNode).not.toHaveBeenCalled();
  });
});

describe('useTreeKeyboard — selection', () => {
  it('Enter selects the focused row in single mode', () => {
    const onSelect = vi.fn();
    const opts = defaultOptions({ onSelect });
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('b');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('Enter'));
    });

    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('Space toggles selection in multi-select mode', () => {
    const onMultiSelectChange = vi.fn();
    const opts = defaultOptions({
      selectionMode: 'multi',
      multiSelectedIds: new Set<string>(),
      onMultiSelectChange,
    });

    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('a');
    });

    act(() => {
      result.current.onKeyDown(keyEvent(' '));
    });

    expect(onMultiSelectChange).toHaveBeenCalledWith(new Set(['a']));
  });

  it('Escape clears selection in single mode', () => {
    const onSelect = vi.fn();
    const opts = defaultOptions({ onSelect, selectedId: 'b' });
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('b');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('Escape'));
    });

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('Escape clears selection in multi mode', () => {
    const onMultiSelectChange = vi.fn();
    const opts = defaultOptions({
      selectionMode: 'multi',
      multiSelectedIds: new Set(['a', 'b']),
      onMultiSelectChange,
    });

    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('a');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('Escape'));
    });

    expect(onMultiSelectChange).toHaveBeenCalledWith(new Set());
  });
});

describe('useTreeKeyboard — Shift+Arrow range selection', () => {
  it('Shift+ArrowDown extends multi-selection', () => {
    const onMultiSelectChange = vi.fn();
    const opts = defaultOptions({
      selectionMode: 'multi',
      multiSelectedIds: new Set<string>(),
      onMultiSelectChange,
    });

    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('a');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('ArrowDown', { shiftKey: true }));
    });

    // Should select range from 'a' to 'b'
    expect(onMultiSelectChange).toHaveBeenCalled();
    const lastCall = onMultiSelectChange.mock.lastCall?.[0] as Set<string>;
    expect(lastCall.has('a')).toBe(true);
    expect(lastCall.has('b')).toBe(true);
  });
});

describe('useTreeKeyboard — Ctrl/Cmd+A select all', () => {
  it('selects all visible rows', () => {
    const onMultiSelectChange = vi.fn();
    const opts = defaultOptions({
      selectionMode: 'multi',
      multiSelectedIds: new Set<string>(),
      onMultiSelectChange,
    });

    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('a');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('a', { ctrlKey: true }));
    });

    expect(onMultiSelectChange).toHaveBeenCalledWith(new Set(['a', 'b', 'c']));
  });
});

describe('useTreeKeyboard — focus management', () => {
  it('focus initializes to first row on activation', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    // Not active initially
    expect(result.current.state.isActive).toBe(false);
    expect(result.current.state.focusedId).toBeNull();

    // Press arrow to activate
    act(() => {
      result.current.onKeyDown(keyEvent('ArrowDown'));
    });

    expect(result.current.state.isActive).toBe(true);
    expect(result.current.state.focusedId).toBe('a');
  });

  it('reset clears focus and deactivates', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('b');
    });
    expect(result.current.state.focusedId).toBe('b');

    act(() => {
      result.current.actions.reset();
    });

    expect(result.current.state.focusedId).toBeNull();
    expect(result.current.state.isActive).toBe(false);
  });

  it('ignores key events from input elements', () => {
    const opts = defaultOptions();
    const { result } = renderHook(() => useTreeKeyboard(opts));

    const inputEvent = keyEvent('ArrowDown', {
      target: document.createElement('input'),
    } as unknown as Partial<React.KeyboardEvent>);

    act(() => {
      result.current.onKeyDown(inputEvent);
    });

    // Should not activate
    expect(result.current.state.isActive).toBe(false);
  });

  it('deactivates when table loses focus', () => {
    const opts = defaultOptions({ isTableFocused: true });
    const { result, rerender } = renderHook(
      (props: UseTreeKeyboardOptions<TestData>) => useTreeKeyboard(props),
      { initialProps: opts }
    );

    // Activate
    act(() => {
      result.current.actions.setFocus('a');
    });
    expect(result.current.state.isActive).toBe(true);

    // Lose focus
    rerender({ ...opts, isTableFocused: false });
    expect(result.current.state.isActive).toBe(false);
  });

  it('clears active focus when all visible rows disappear', () => {
    const opts = defaultOptions();
    const { result, rerender } = renderHook(
      (props: UseTreeKeyboardOptions<TestData>) => useTreeKeyboard(props),
      { initialProps: opts }
    );

    act(() => {
      result.current.actions.setFocus('a');
    });

    rerender({
      ...opts,
      rows: [],
      rowIndexById: new Map(),
    });

    expect(result.current.state.focusedId).toBeNull();
  });

  it('does not immediately auto-focus a replacement row after the focused row is filtered out', () => {
    const opts = defaultOptions();
    const replacementRows = opts.rows.filter((row) => row.node.id !== 'b');
    const replacementIndexById = new Map(replacementRows.map((row, index) => [row.node.id, index]));
    const { result, rerender } = renderHook(
      (props: UseTreeKeyboardOptions<TestData>) => useTreeKeyboard(props),
      { initialProps: opts }
    );

    act(() => {
      result.current.actions.setFocus('b');
    });

    rerender({
      ...opts,
      rows: replacementRows,
      rowIndexById: replacementIndexById,
    });

    expect(result.current.state.focusedId).toBeNull();
  });

  it('scrolls to node when navigating', () => {
    const onScrollToNode = vi.fn();
    const opts = defaultOptions({ onScrollToNode });
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('a');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('ArrowDown'));
    });

    expect(onScrollToNode).toHaveBeenCalledWith('b');
  });
});

describe('useTreeKeyboard — no-op on selectionMode none', () => {
  it('Enter does nothing in none mode', () => {
    const onSelect = vi.fn();
    const opts = defaultOptions({ selectionMode: 'none', onSelect });
    const { result } = renderHook(() => useTreeKeyboard(opts));

    act(() => {
      result.current.actions.setFocus('a');
    });

    act(() => {
      result.current.onKeyDown(keyEvent('Enter'));
    });

    expect(onSelect).not.toHaveBeenCalled();
  });
});
