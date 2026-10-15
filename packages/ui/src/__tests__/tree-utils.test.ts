// @vitest-environment node
/**
 * Tests for tree-table utility functions
 */
import { describe, expect, it } from 'vitest';
import {
  buildTreeFromFlatNodes,
  computeCheckboxState,
  createChildrenGetter,
  DEFAULT_ARIA,
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

// Test data types
interface TestData {
  name: string;
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

// Helper to create a flattened row
function createFlattenedRow<T>(
  node: TreeNode<T>,
  index: number,
  options: Partial<FlattenedRow<T>> = {}
): FlattenedRow<T> {
  return {
    aria: {
      ariaLevel: node.depth + 1,
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
    node,
    ...options,
  };
}

describe('tree-utils', () => {
  describe('createChildrenGetter', () => {
    it('returns children for a parent node', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Parent', null, true, 0),
        createTestNode('2', 'Child 1', '1', false, 1),
        createTestNode('3', 'Child 2', '1', false, 1),
      ];

      const getChildren = createChildrenGetter(nodes);
      const children = getChildren(nodes[0]!);

      expect(children).toHaveLength(2);
      expect(children[0]?.id).toBe('2');
      expect(children[1]?.id).toBe('3');
    });

    it('returns empty array for leaf nodes', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Parent', null, true, 0),
        createTestNode('2', 'Child', '1', false, 1),
      ];

      const getChildren = createChildrenGetter(nodes);
      const children = getChildren(nodes[1]!);

      expect(children).toHaveLength(0);
    });
  });

  describe('buildTreeFromFlatNodes', () => {
    it('returns root nodes', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Root 1', null, true, 0),
        createTestNode('2', 'Child', '1', false, 1),
        createTestNode('3', 'Root 2', null, false, 0),
      ];

      const roots = buildTreeFromFlatNodes(nodes);

      expect(roots).toHaveLength(2);
      expect(roots[0]?.id).toBe('1');
      expect(roots[1]?.id).toBe('3');
    });
  });

  describe('flattenTree', () => {
    it('flattens visible nodes', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Node 1', null, false, 0),
        createTestNode('2', 'Node 2', null, false, 0),
      ];

      const result = flattenTree(nodes, { expandedIds: new Set() });

      expect(result.rows).toHaveLength(2);
      expect(result.visibleCount).toBe(2);
      expect(result.indexMap.get('1')).toBe(0);
      expect(result.indexMap.get('2')).toBe(1);
    });

    it('marks selected and highlighted nodes', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Node 1', null, false, 0),
        createTestNode('2', 'Node 2', null, false, 0),
      ];

      const result = flattenTree(nodes, {
        expandedIds: new Set(),
        highlightedIds: new Set(['2']),
        selectedId: '1',
      });

      expect(result.rows[0]?.isSelected).toBe(true);
      expect(result.rows[1]?.isHighlighted).toBe(true);
    });
  });

  describe('flattenTreeRecursive', () => {
    it('includes children of expanded nodes', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Parent', null, true, 0),
        createTestNode('2', 'Child 1', '1', false, 1),
        createTestNode('3', 'Child 2', '1', false, 1),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const result = flattenTreeRecursive(roots, { expandedIds: new Set(['1']) }, getChildren);

      expect(result.rows).toHaveLength(3);
      expect(result.rows[0]?.node.id).toBe('1');
      expect(result.rows[1]?.node.id).toBe('2');
      expect(result.rows[2]?.node.id).toBe('3');
    });

    it('excludes children of collapsed nodes', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Parent', null, true, 0),
        createTestNode('2', 'Child 1', '1', false, 1),
        createTestNode('3', 'Child 2', '1', false, 1),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const result = flattenTreeRecursive(roots, { expandedIds: new Set() }, getChildren);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.node.id).toBe('1');
    });

    it('handles deeply nested trees', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Root', null, true, 0),
        createTestNode('2', 'Level 1', '1', true, 1),
        createTestNode('3', 'Level 2', '2', true, 2),
        createTestNode('4', 'Level 3', '3', false, 3),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const result = flattenTreeRecursive(
        roots,
        { expandedIds: new Set(['1', '2', '3']) },
        getChildren
      );

      expect(result.rows).toHaveLength(4);
      expect(result.rows[3]?.node.depth).toBe(3);
    });
  });

  describe('getVisibleNodeCount', () => {
    it('counts only visible nodes', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Parent', null, true, 0),
        createTestNode('2', 'Child 1', '1', false, 1),
        createTestNode('3', 'Child 2', '1', false, 1),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      // When collapsed
      expect(getVisibleNodeCount(roots, new Set(), getChildren)).toBe(1);

      // When expanded
      expect(getVisibleNodeCount(roots, new Set(['1']), getChildren)).toBe(3);
    });
  });

  describe('findNodeById', () => {
    it('finds a node by ID', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Parent', null, true, 0),
        createTestNode('2', 'Child', '1', false, 1),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const found = findNodeById(roots, '2', getChildren);

      expect(found?.id).toBe('2');
      expect(found?.data.name).toBe('Child');
    });

    it('returns null for non-existent ID', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'Node', null, false, 0)];
      const getChildren = createChildrenGetter(nodes);

      const found = findNodeById(nodes, 'nonexistent', getChildren);

      expect(found).toBeNull();
    });
  });

  describe('getNodePath', () => {
    it('returns path from root to node', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Root', null, true, 0),
        createTestNode('2', 'Child', '1', true, 1),
        createTestNode('3', 'Grandchild', '2', false, 2),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const path = getNodePath(roots, '3', getChildren);

      expect(path).toHaveLength(3);
      expect(path[0]?.id).toBe('1');
      expect(path[1]?.id).toBe('2');
      expect(path[2]?.id).toBe('3');
    });

    it('returns empty array for non-existent node', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'Node', null, false, 0)];
      const getChildren = createChildrenGetter(nodes);

      const path = getNodePath(nodes, 'nonexistent', getChildren);

      expect(path).toHaveLength(0);
    });
  });

  describe('getAncestorIds', () => {
    it('returns ancestor IDs excluding target', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Root', null, true, 0),
        createTestNode('2', 'Child', '1', true, 1),
        createTestNode('3', 'Grandchild', '2', false, 2),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const ancestors = getAncestorIds(roots, '3', getChildren);

      expect(ancestors.size).toBe(2);
      expect(ancestors.has('1')).toBe(true);
      expect(ancestors.has('2')).toBe(true);
      expect(ancestors.has('3')).toBe(false);
    });
  });

  describe('getDescendantIds', () => {
    it('returns all descendant IDs', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Root', null, true, 0),
        createTestNode('2', 'Child 1', '1', true, 1),
        createTestNode('3', 'Child 2', '1', false, 1),
        createTestNode('4', 'Grandchild', '2', false, 2),
      ];
      const getChildren = createChildrenGetter(nodes);

      const descendants = getDescendantIds(nodes[0]!, getChildren);

      expect(descendants.size).toBe(3);
      expect(descendants.has('2')).toBe(true);
      expect(descendants.has('3')).toBe(true);
      expect(descendants.has('4')).toBe(true);
    });
  });

  describe('expandToNode', () => {
    it('expands ancestors to reveal a node', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Root', null, true, 0),
        createTestNode('2', 'Child', '1', true, 1),
        createTestNode('3', 'Grandchild', '2', false, 2),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const newExpanded = expandToNode(roots, '3', new Set(), getChildren);

      expect(newExpanded.has('1')).toBe(true);
      expect(newExpanded.has('2')).toBe(true);
    });

    it('preserves existing expanded nodes', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Root', null, true, 0),
        createTestNode('2', 'Child', '1', false, 1),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const newExpanded = expandToNode(roots, '2', new Set(['other']), getChildren);

      expect(newExpanded.has('other')).toBe(true);
      expect(newExpanded.has('1')).toBe(true);
    });
  });

  describe('getNextVisibleNodeId', () => {
    it('returns next node when moving down', () => {
      const node1 = createTestNode('1', 'Node 1', null, false, 0);
      const node2 = createTestNode('2', 'Node 2', null, false, 0);
      const rows: FlattenedRow<TestData>[] = [
        createFlattenedRow(node1, 0),
        createFlattenedRow(node2, 1),
      ];

      const next = getNextVisibleNodeId(rows, '1', 'down');

      expect(next).toBe('2');
    });

    it('returns previous node when moving up', () => {
      const node1 = createTestNode('1', 'Node 1', null, false, 0);
      const node2 = createTestNode('2', 'Node 2', null, false, 0);
      const rows: FlattenedRow<TestData>[] = [
        createFlattenedRow(node1, 0),
        createFlattenedRow(node2, 1),
      ];

      const prev = getNextVisibleNodeId(rows, '2', 'up');

      expect(prev).toBe('1');
    });

    it('returns null at boundaries', () => {
      const node1 = createTestNode('1', 'Node 1', null, false, 0);
      const rows: FlattenedRow<TestData>[] = [createFlattenedRow(node1, 0)];

      expect(getNextVisibleNodeId(rows, '1', 'down')).toBeNull();
      expect(getNextVisibleNodeId(rows, '1', 'up')).toBeNull();
    });

    it('returns first/last when current is null', () => {
      const node1 = createTestNode('1', 'Node 1', null, false, 0);
      const node2 = createTestNode('2', 'Node 2', null, false, 0);
      const rows: FlattenedRow<TestData>[] = [
        createFlattenedRow(node1, 0),
        createFlattenedRow(node2, 1),
      ];

      expect(getNextVisibleNodeId(rows, null, 'down')).toBe('1');
      expect(getNextVisibleNodeId(rows, null, 'up')).toBe('2');
    });
  });

  describe('getParentNodeId', () => {
    it('returns parent node ID', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Root', null, true, 0),
        createTestNode('2', 'Child', '1', false, 1),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const parentId = getParentNodeId(roots, '2', getChildren);

      expect(parentId).toBe('1');
    });

    it('returns null for root nodes', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'Root', null, false, 0)];
      const getChildren = createChildrenGetter(nodes);

      const parentId = getParentNodeId(nodes, '1', getChildren);

      expect(parentId).toBeNull();
    });
  });

  describe('getFirstChildNodeId', () => {
    it('returns first child ID', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Parent', null, true, 0),
        createTestNode('2', 'Child 1', '1', false, 1),
        createTestNode('3', 'Child 2', '1', false, 1),
      ];
      const getChildren = createChildrenGetter(nodes);

      const firstChildId = getFirstChildNodeId(nodes[0]!, getChildren);

      expect(firstChildId).toBe('2');
    });

    it('returns null for leaf nodes', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'Leaf', null, false, 0)];
      const getChildren = createChildrenGetter(nodes);

      const firstChildId = getFirstChildNodeId(nodes[0]!, getChildren);

      expect(firstChildId).toBeNull();
    });
  });

  describe('getRangeSelection', () => {
    it('selects range between two nodes', () => {
      const nodes = [
        createTestNode('1', 'Node 1', null, false, 0),
        createTestNode('2', 'Node 2', null, false, 0),
        createTestNode('3', 'Node 3', null, false, 0),
      ];
      const rows: FlattenedRow<TestData>[] = nodes.map((node, i) => createFlattenedRow(node, i));

      const selection = getRangeSelection(rows, '1', '3');

      expect(selection.size).toBe(3);
      expect(selection.has('1')).toBe(true);
      expect(selection.has('2')).toBe(true);
      expect(selection.has('3')).toBe(true);
    });

    it('works in reverse order', () => {
      const nodes = [
        createTestNode('1', 'Node 1', null, false, 0),
        createTestNode('2', 'Node 2', null, false, 0),
        createTestNode('3', 'Node 3', null, false, 0),
      ];
      const rows: FlattenedRow<TestData>[] = nodes.map((node, i) => createFlattenedRow(node, i));

      const selection = getRangeSelection(rows, '3', '1');

      expect(selection.size).toBe(3);
    });

    it('returns empty set for invalid IDs', () => {
      const nodes = [createTestNode('1', 'Node 1', null, false, 0)];
      const rows: FlattenedRow<TestData>[] = [createFlattenedRow(nodes[0]!, 0)];

      const selection = getRangeSelection(rows, '1', 'invalid');

      expect(selection.size).toBe(0);
    });
  });

  describe('filterTreeNodes', () => {
    it('returns matching and ancestor IDs', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'Parent', null, true, 0),
        createTestNode('2', 'Match Child', '1', false, 1),
        createTestNode('3', 'Other', null, false, 0),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const result = filterTreeNodes(
        roots,
        (node) => node.data.name.includes('Match'),
        getChildren
      );

      expect(result.matchingIds.has('2')).toBe(true);
      expect(result.ancestorIds.has('1')).toBe(true);
      expect(result.matchingIds.has('3')).toBe(false);
    });
  });

  describe('ARIA attributes in flattenTree', () => {
    it('computes aria-level from node depth (1-based)', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'Root', null, false, 0)];

      const result = flattenTree(nodes, { expandedIds: new Set() });
      const row = result.rows[0];
      expect(row).toBeDefined();
      expect(row!.aria.ariaLevel).toBe(1); // depth 0 => level 1
    });

    it('computes aria-setsize and aria-posinset for siblings', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('a', 'First', null, false, 0),
        createTestNode('b', 'Second', null, false, 0),
        createTestNode('c', 'Third', null, false, 0),
      ];

      const result = flattenTree(nodes, { expandedIds: new Set() });
      expect(result.rows).toHaveLength(3);

      // All three are siblings at root level
      expect(result.rows[0]!.aria.ariaSetSize).toBe(3);
      expect(result.rows[0]!.aria.ariaPosInSet).toBe(1);
      expect(result.rows[1]!.aria.ariaSetSize).toBe(3);
      expect(result.rows[1]!.aria.ariaPosInSet).toBe(2);
      expect(result.rows[2]!.aria.ariaSetSize).toBe(3);
      expect(result.rows[2]!.aria.ariaPosInSet).toBe(3);
    });

    it('computes aria-rowindex (1-based, accounting for header row)', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('x', 'One', null, false, 0),
        createTestNode('y', 'Two', null, false, 0),
      ];

      const result = flattenTree(nodes, { expandedIds: new Set() });
      // Header row is row 1, so first data row is 2
      expect(result.rows[0]!.aria.ariaRowIndex).toBe(2);
      expect(result.rows[1]!.aria.ariaRowIndex).toBe(3);
    });

    it('provides default ARIA attributes', () => {
      expect(DEFAULT_ARIA).toEqual({
        ariaLevel: 1,
        ariaPosInSet: 1,
        ariaRowIndex: 1,
        ariaSetSize: 1,
      });
    });
  });

  describe('ARIA attributes in flattenTreeRecursive', () => {
    it('computes correct aria-setsize for child nodes', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('parent', 'Parent', null, true, 0),
        createTestNode('child1', 'Child 1', 'parent', false, 1),
        createTestNode('child2', 'Child 2', 'parent', false, 1),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const result = flattenTreeRecursive(roots, { expandedIds: new Set(['parent']) }, getChildren);

      expect(result.rows).toHaveLength(3);
      // Parent: setSize=1, posInSet=1 (only root)
      expect(result.rows[0]!.aria.ariaSetSize).toBe(1);
      expect(result.rows[0]!.aria.ariaPosInSet).toBe(1);
      expect(result.rows[0]!.aria.ariaLevel).toBe(1);

      // Children: setSize=2, posInSet 1 and 2
      expect(result.rows[1]!.aria.ariaSetSize).toBe(2);
      expect(result.rows[1]!.aria.ariaPosInSet).toBe(1);
      expect(result.rows[1]!.aria.ariaLevel).toBe(2);

      expect(result.rows[2]!.aria.ariaSetSize).toBe(2);
      expect(result.rows[2]!.aria.ariaPosInSet).toBe(2);
      expect(result.rows[2]!.aria.ariaLevel).toBe(2);
    });
  });

  describe('context awareness in flattenTree', () => {
    it('marks nodes as in-context when contextNodeIds is provided', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('1', 'File A', null, false, 0),
        createTestNode('2', 'File B', null, false, 0),
        createTestNode('3', 'File C', null, false, 0),
      ];

      const result = flattenTree(nodes, {
        contextNodeIds: new Set(['1', '3']),
        expandedIds: new Set(),
      });

      expect(result.rows[0]!.isInContext).toBe(true);
      expect(result.rows[1]!.isInContext).toBe(false);
      expect(result.rows[2]!.isInContext).toBe(true);
    });

    it('defaults isInContext to false when no contextNodeIds provided', () => {
      const nodes: TreeNode<TestData>[] = [createTestNode('1', 'File A', null, false, 0)];

      const result = flattenTree(nodes, { expandedIds: new Set() });
      expect(result.rows[0]!.isInContext).toBe(false);
    });
  });

  describe('context awareness in flattenTreeRecursive', () => {
    it('marks nodes as in-context recursively', () => {
      const nodes: TreeNode<TestData>[] = [
        createTestNode('parent', 'Parent', null, true, 0),
        createTestNode('child1', 'Child 1', 'parent', false, 1),
        createTestNode('child2', 'Child 2', 'parent', false, 1),
      ];
      const getChildren = createChildrenGetter(nodes);
      const roots = buildTreeFromFlatNodes(nodes);

      const result = flattenTreeRecursive(
        roots,
        {
          contextNodeIds: new Set(['child2']),
          expandedIds: new Set(['parent']),
        },
        getChildren
      );

      expect(result.rows[0]!.isInContext).toBe(false); // parent
      expect(result.rows[1]!.isInContext).toBe(false); // child1
      expect(result.rows[2]!.isInContext).toBe(true); // child2
    });
  });

  describe('computeCheckboxState', () => {
    it('returns checked when node itself is selected', () => {
      const selected = new Set(['node1']);
      const result = computeCheckboxState('node1', selected, () => new Set());
      expect(result).toBe('checked');
    });

    it('returns unchecked when node has no descendants and is not selected', () => {
      const selected = new Set<string>();
      const result = computeCheckboxState('leaf', selected, () => new Set());
      expect(result).toBe('unchecked');
    });

    it('returns indeterminate when a parent is selected but descendants are not fully selected', () => {
      const selected = new Set(['parent', 'child1']);
      const getDescendants = (id: string): Set<string> => {
        if (id === 'parent') {
          return new Set(['child1', 'child2']);
        }
        return new Set();
      };
      const result = computeCheckboxState('parent', selected, getDescendants);
      expect(result).toBe('indeterminate');
    });

    it('returns checked when all descendants are selected', () => {
      const selected = new Set(['child1', 'child2']);
      const getDescendants = (id: string): Set<string> => {
        if (id === 'parent') {
          return new Set(['child1', 'child2']);
        }
        return new Set();
      };
      const result = computeCheckboxState('parent', selected, getDescendants);
      expect(result).toBe('checked');
    });

    it('returns indeterminate when some descendants are selected', () => {
      const selected = new Set(['child1']);
      const getDescendants = (id: string): Set<string> => {
        if (id === 'parent') {
          return new Set(['child1', 'child2', 'child3']);
        }
        return new Set();
      };
      const result = computeCheckboxState('parent', selected, getDescendants);
      expect(result).toBe('indeterminate');
    });

    it('returns unchecked when no descendants are selected', () => {
      const selected = new Set<string>();
      const getDescendants = (id: string): Set<string> => {
        if (id === 'parent') {
          return new Set(['child1', 'child2']);
        }
        return new Set();
      };
      const result = computeCheckboxState('parent', selected, getDescendants);
      expect(result).toBe('unchecked');
    });
  });
});
