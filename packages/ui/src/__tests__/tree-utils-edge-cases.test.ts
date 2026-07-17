/**
 * Edge case tests for tree-utils functions.
 *
 * Validates boundary conditions, ARIA correctness, and robustness
 * of tree utility functions under unusual inputs.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTreeFromFlatNodes,
  computeCheckboxState,
  createChildrenGetter,
  expandToNode,
  filterTreeNodes,
  findNodeById,
  flattenTree,
  flattenTreeRecursive,
  getAncestorIds,
  getDescendantIds,
  getFirstChildNodeId,
  getNextVisibleNodeId,
  getNodePath,
  getParentNodeId,
  getRangeSelection,
  getVisibleNodeCount,
} from '../tree-table/tree-utils';
import type { FlattenedRow, TreeNode } from '../tree-table/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestData {
  name: string;
}

function node(
  id: string,
  name: string,
  parentId: string | null = null,
  hasChildren = false,
  depth = 0
): TreeNode<TestData> {
  return { data: { name }, depth, hasChildren, id, parentId, type: 'file' };
}

function row<T>(n: TreeNode<T>, index: number): FlattenedRow<T> {
  return {
    aria: {
      ariaLevel: n.depth + 1,
      ariaPosInSet: 1,
      ariaRowIndex: index + 2,
      ariaSetSize: 1,
    },
    index,
    isExpanded: false,
    isHighlighted: false,
    isInContext: false,
    isSelected: false,
    matchesFilter: true,
    node: n,
  };
}

// ---------------------------------------------------------------------------
// computeCheckboxState edge cases
// ---------------------------------------------------------------------------

describe('computeCheckboxState — edge cases', () => {
  it('returns "indeterminate" when parent is selected without full descendant selection', () => {
    const selected = new Set(['parent']);
    const getDesc = (id: string): Set<string> => {
      if (id === 'parent') {
        return new Set(['child1', 'child2']);
      }
      return new Set();
    };

    expect(computeCheckboxState('parent', selected, getDesc)).toBe('indeterminate');
  });

  it('returns "unchecked" for leaf with no descendants and not selected', () => {
    expect(computeCheckboxState('leaf', new Set(), () => new Set())).toBe('unchecked');
  });

  it('returns "checked" when all descendants are selected', () => {
    const selected = new Set(['c1', 'c2', 'c3']);
    const getDesc = (): Set<string> => new Set(['c1', 'c2', 'c3']);

    expect(computeCheckboxState('p', selected, getDesc)).toBe('checked');
  });

  it('returns "indeterminate" when some descendants are selected', () => {
    const selected = new Set(['c1']);
    const getDesc = (): Set<string> => new Set(['c1', 'c2', 'c3']);

    expect(computeCheckboxState('p', selected, getDesc)).toBe('indeterminate');
  });

  it('returns "unchecked" when no descendants are selected', () => {
    const selected = new Set<string>();
    const getDesc = (): Set<string> => new Set(['c1', 'c2']);

    expect(computeCheckboxState('p', selected, getDesc)).toBe('unchecked');
  });

  it('returns "unchecked" for a leaf with no descendants and no selection', () => {
    const selected = new Set<string>();
    const getDesc = (): Set<string> => new Set<string>();

    expect(computeCheckboxState('orphan', selected, getDesc)).toBe('unchecked');
  });

  it('handles very large descendant set without error', () => {
    const descendantIds = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      descendantIds.add(`d-${i}`);
    }

    // Select first half
    const selected = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      selected.add(`d-${i}`);
    }

    expect(computeCheckboxState('root', selected, () => descendantIds)).toBe('indeterminate');
  });
});

// ---------------------------------------------------------------------------
// flattenTreeRecursive edge cases
// ---------------------------------------------------------------------------

describe('flattenTreeRecursive — edge cases', () => {
  it('handles empty node list', () => {
    const result = flattenTreeRecursive([], { expandedIds: new Set() }, () => []);

    expect(result.rows).toHaveLength(0);
    expect(result.visibleCount).toBe(0);
  });

  it('handles single node with no children', () => {
    const nodes = [node('only', 'Only')];

    const result = flattenTreeRecursive(nodes, { expandedIds: new Set() }, () => []);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.aria.ariaSetSize).toBe(1);
    expect(result.rows[0]!.aria.ariaPosInSet).toBe(1);
  });

  it('handles deep nesting (5+ levels) with correct ARIA levels', () => {
    const allNodes: TreeNode<TestData>[] = [
      node('l0', 'Level 0', null, true, 0),
      node('l1', 'Level 1', 'l0', true, 1),
      node('l2', 'Level 2', 'l1', true, 2),
      node('l3', 'Level 3', 'l2', true, 3),
      node('l4', 'Level 4', 'l3', true, 4),
      node('l5', 'Level 5', 'l4', false, 5),
    ];
    const getChildren = createChildrenGetter(allNodes);
    const roots = buildTreeFromFlatNodes(allNodes);

    const result = flattenTreeRecursive(
      roots,
      { expandedIds: new Set(['l0', 'l1', 'l2', 'l3', 'l4']) },
      getChildren
    );

    expect(result.rows).toHaveLength(6);

    // Verify ARIA levels are sequential 1..6
    for (let i = 0; i < 6; i++) {
      expect(result.rows[i]!.aria.ariaLevel).toBe(i + 1);
    }
  });

  it('all collapsed: only root nodes visible', () => {
    const allNodes: TreeNode<TestData>[] = [
      node('r1', 'Root 1', null, true, 0),
      node('c1', 'Child 1', 'r1', false, 1),
      node('r2', 'Root 2', null, true, 0),
      node('c2', 'Child 2', 'r2', false, 1),
    ];
    const getChildren = createChildrenGetter(allNodes);
    const roots = buildTreeFromFlatNodes(allNodes);

    const result = flattenTreeRecursive(roots, { expandedIds: new Set() }, getChildren);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.node.id)).toEqual(['r1', 'r2']);
  });

  it('all expanded: every node visible', () => {
    const allNodes: TreeNode<TestData>[] = [
      node('r', 'Root', null, true, 0),
      node('a', 'A', 'r', true, 1),
      node('a1', 'A1', 'a', false, 2),
      node('b', 'B', 'r', false, 1),
    ];
    const getChildren = createChildrenGetter(allNodes);
    const roots = buildTreeFromFlatNodes(allNodes);

    const result = flattenTreeRecursive(roots, { expandedIds: new Set(['r', 'a']) }, getChildren);

    expect(result.rows).toHaveLength(4);
    expect(result.rows.map((r) => r.node.id)).toEqual(['r', 'a', 'a1', 'b']);
  });

  it('ARIA: ariaRowIndex is sequential starting at 2', () => {
    const allNodes: TreeNode<TestData>[] = [
      node('r', 'Root', null, true, 0),
      node('c1', 'C1', 'r', false, 1),
      node('c2', 'C2', 'r', false, 1),
    ];
    const getChildren = createChildrenGetter(allNodes);
    const roots = buildTreeFromFlatNodes(allNodes);

    const result = flattenTreeRecursive(roots, { expandedIds: new Set(['r']) }, getChildren);

    expect(result.rows[0]!.aria.ariaRowIndex).toBe(2);
    expect(result.rows[1]!.aria.ariaRowIndex).toBe(3);
    expect(result.rows[2]!.aria.ariaRowIndex).toBe(4);
  });

  it('ARIA: sibling setSize and posInSet at each level', () => {
    const allNodes: TreeNode<TestData>[] = [
      node('r1', 'Root 1', null, true, 0),
      node('r2', 'Root 2', null, false, 0),
      node('r1c1', 'R1 C1', 'r1', false, 1),
      node('r1c2', 'R1 C2', 'r1', false, 1),
      node('r1c3', 'R1 C3', 'r1', false, 1),
    ];
    const getChildren = createChildrenGetter(allNodes);
    const roots = buildTreeFromFlatNodes(allNodes);

    const result = flattenTreeRecursive(roots, { expandedIds: new Set(['r1']) }, getChildren);

    // Root siblings: 2 roots
    expect(result.rows[0]!.aria.ariaSetSize).toBe(2);
    expect(result.rows[0]!.aria.ariaPosInSet).toBe(1);

    // Children of r1: 3 siblings
    expect(result.rows[1]!.aria.ariaSetSize).toBe(3);
    expect(result.rows[1]!.aria.ariaPosInSet).toBe(1);
    expect(result.rows[2]!.aria.ariaSetSize).toBe(3);
    expect(result.rows[2]!.aria.ariaPosInSet).toBe(2);
    expect(result.rows[3]!.aria.ariaSetSize).toBe(3);
    expect(result.rows[3]!.aria.ariaPosInSet).toBe(3);

    // Second root
    expect(result.rows[4]!.aria.ariaSetSize).toBe(2);
    expect(result.rows[4]!.aria.ariaPosInSet).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getNextVisibleNodeId edge cases
// ---------------------------------------------------------------------------

describe('getNextVisibleNodeId — edge cases', () => {
  it('returns null for empty rows', () => {
    expect(getNextVisibleNodeId([], '1', 'down')).toBeNull();
    expect(getNextVisibleNodeId([], '1', 'up')).toBeNull();
    expect(getNextVisibleNodeId([], null, 'down')).toBeNull();
  });

  it('returns null when navigating up from first row', () => {
    const rows = [row(node('a', 'A'), 0)];
    expect(getNextVisibleNodeId(rows, 'a', 'up')).toBeNull();
  });

  it('returns null when navigating down from last row', () => {
    const rows = [row(node('a', 'A'), 0)];
    expect(getNextVisibleNodeId(rows, 'a', 'down')).toBeNull();
  });

  it('navigates through expanded/collapsed boundary', () => {
    const n1 = node('1', 'Parent', null, true, 0);
    const n2 = node('2', 'Child', '1', false, 1);
    const n3 = node('3', 'Next', null, false, 0);
    const rows = [row(n1, 0), row(n2, 1), row(n3, 2)];

    // Down from parent -> child
    expect(getNextVisibleNodeId(rows, '1', 'down')).toBe('2');
    // Down from child -> next sibling
    expect(getNextVisibleNodeId(rows, '2', 'down')).toBe('3');
    // Up from next -> child
    expect(getNextVisibleNodeId(rows, '3', 'up')).toBe('2');
  });

  it('returns first row when current ID is not found', () => {
    const rows = [row(node('a', 'A'), 0), row(node('b', 'B'), 1)];
    expect(getNextVisibleNodeId(rows, 'nonexistent', 'down')).toBe('a');
  });

  it('returns first row on null focus down, last on null focus up', () => {
    const rows = [row(node('a', 'A'), 0), row(node('b', 'B'), 1), row(node('c', 'C'), 2)];
    expect(getNextVisibleNodeId(rows, null, 'down')).toBe('a');
    expect(getNextVisibleNodeId(rows, null, 'up')).toBe('c');
  });
});

// ---------------------------------------------------------------------------
// getRangeSelection edge cases
// ---------------------------------------------------------------------------

describe('getRangeSelection — edge cases', () => {
  it('returns full range from first to last', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node(`n${i}`, `Node ${i}`));
    const rows = nodes.map((n, i) => row(n, i));

    const sel = getRangeSelection(rows, 'n0', 'n4');
    expect(sel.size).toBe(5);
  });

  it('returns full range in reverse order', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node(`n${i}`, `Node ${i}`));
    const rows = nodes.map((n, i) => row(n, i));

    const sel = getRangeSelection(rows, 'n4', 'n0');
    expect(sel.size).toBe(5);
  });

  it('single item range', () => {
    const rows = [row(node('a', 'A'), 0)];
    const sel = getRangeSelection(rows, 'a', 'a');
    expect(sel.size).toBe(1);
    expect(sel.has('a')).toBe(true);
  });

  it('returns empty set when fromId is invalid', () => {
    const rows = [row(node('a', 'A'), 0)];
    expect(getRangeSelection(rows, 'invalid', 'a').size).toBe(0);
  });

  it('returns empty set when toId is invalid', () => {
    const rows = [row(node('a', 'A'), 0)];
    expect(getRangeSelection(rows, 'a', 'invalid').size).toBe(0);
  });

  it('returns empty set when both IDs are invalid', () => {
    const rows = [row(node('a', 'A'), 0)];
    expect(getRangeSelection(rows, 'x', 'y').size).toBe(0);
  });

  it('handles empty rows', () => {
    expect(getRangeSelection([], 'a', 'b').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// flattenTree edge cases
// ---------------------------------------------------------------------------

describe('flattenTree — edge cases', () => {
  it('handles empty array', () => {
    const result = flattenTree([], { expandedIds: new Set() });
    expect(result.rows).toHaveLength(0);
    expect(result.visibleCount).toBe(0);
  });

  it('multi-select marks nodes correctly', () => {
    const nodes = [node('a', 'A'), node('b', 'B'), node('c', 'C')];
    const result = flattenTree(nodes, {
      expandedIds: new Set(),
      multiSelectedIds: new Set(['a', 'c']),
    });

    expect(result.rows[0]!.isSelected).toBe(true);
    expect(result.rows[1]!.isSelected).toBe(false);
    expect(result.rows[2]!.isSelected).toBe(true);
  });

  it('applies filterFn correctly', () => {
    const nodes = [node('a', 'Alpha'), node('b', 'Beta'), node('c', 'Alpha-2')];
    const result = flattenTree(nodes, {
      expandedIds: new Set(),
      filterFn: (n) => (n.data as TestData).name.startsWith('Alpha'),
    });

    // filterFn sets matchesFilter, but doesn't skip nodes in flattenTree
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.matchesFilter).toBe(true);
    expect(result.rows[1]!.matchesFilter).toBe(false);
    expect(result.rows[2]!.matchesFilter).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findNodeById, getNodePath, getAncestorIds, getDescendantIds edge cases
// ---------------------------------------------------------------------------

describe('tree navigation — edge cases', () => {
  it('findNodeById returns null for empty tree', () => {
    expect(findNodeById([], 'x', () => [])).toBeNull();
  });

  it('getNodePath returns empty for non-existent node', () => {
    const nodes = [node('1', 'A')];
    expect(getNodePath(nodes, 'nonexistent', () => [])).toHaveLength(0);
  });

  it('getAncestorIds returns empty set for root node', () => {
    const nodes: TreeNode<TestData>[] = [node('1', 'Root')];
    const getChildren = createChildrenGetter(nodes);
    const ids = getAncestorIds(nodes, '1', getChildren);
    expect(ids.size).toBe(0);
  });

  it('getDescendantIds returns empty set for leaf', () => {
    const leaf = node('leaf', 'Leaf');
    const ids = getDescendantIds(leaf, () => []);
    expect(ids.size).toBe(0);
  });

  it('getParentNodeId returns null for non-existent node', () => {
    const nodes = [node('1', 'A')];
    const getChildren = createChildrenGetter(nodes);
    expect(getParentNodeId(nodes, 'missing', getChildren)).toBeNull();
  });

  it('getFirstChildNodeId returns null for node with hasChildren=false', () => {
    const leaf = node('1', 'Leaf', null, false);
    expect(getFirstChildNodeId(leaf, () => [])).toBeNull();
  });

  it('expandToNode on root returns same expandedIds', () => {
    const nodes = [node('root', 'Root')];
    const getChildren = createChildrenGetter(nodes);
    const expanded = expandToNode(nodes, 'root', new Set(['other']), getChildren);
    expect(expanded.has('other')).toBe(true);
    // Root has no ancestors, so no new IDs added
    expect(expanded.size).toBe(1);
  });

  it('getVisibleNodeCount returns 0 for empty tree', () => {
    expect(getVisibleNodeCount([], new Set(), () => [])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// filterTreeNodes edge cases
// ---------------------------------------------------------------------------

describe('filterTreeNodes — edge cases', () => {
  it('returns empty sets when no nodes match', () => {
    const allNodes: TreeNode<TestData>[] = [
      node('1', 'Alpha', null, true, 0),
      node('2', 'Beta', '1', false, 1),
    ];
    const getChildren = createChildrenGetter(allNodes);
    const roots = buildTreeFromFlatNodes(allNodes);

    const result = filterTreeNodes(roots, () => false, getChildren);
    expect(result.matchingIds.size).toBe(0);
    expect(result.ancestorIds.size).toBe(0);
  });

  it('marks ancestors when deep child matches', () => {
    const allNodes: TreeNode<TestData>[] = [
      node('a', 'A', null, true, 0),
      node('b', 'B', 'a', true, 1),
      node('c', 'C', 'b', true, 2),
      node('d', 'Match', 'c', false, 3),
    ];
    const getChildren = createChildrenGetter(allNodes);
    const roots = buildTreeFromFlatNodes(allNodes);

    const result = filterTreeNodes(
      roots,
      (n) => (n.data as TestData).name === 'Match',
      getChildren
    );

    expect(result.matchingIds.has('d')).toBe(true);
    expect(result.ancestorIds.has('a')).toBe(true);
    expect(result.ancestorIds.has('b')).toBe(true);
    expect(result.ancestorIds.has('c')).toBe(true);
  });

  it('handles all nodes matching', () => {
    const allNodes: TreeNode<TestData>[] = [
      node('1', 'A', null, true, 0),
      node('2', 'B', '1', false, 1),
    ];
    const getChildren = createChildrenGetter(allNodes);
    const roots = buildTreeFromFlatNodes(allNodes);

    const result = filterTreeNodes(roots, () => true, getChildren);
    expect(result.matchingIds.size).toBe(2);
  });
});
