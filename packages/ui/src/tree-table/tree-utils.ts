/**
 * Tree Utilities
 *
 * Functions for flattening tree structures, managing expansion state,
 * and navigating hierarchical data for the TreeTable component.
 */

import type {
  FlattenedRow,
  FlattenOptions,
  FlattenResult,
  TreeNode,
  TreeRowAriaAttributes,
} from './types';

/**
 * Default ARIA attributes for rows where structure info is unavailable.
 */
const DEFAULT_ARIA: TreeRowAriaAttributes = {
  ariaLevel: 1,
  ariaSetSize: 1,
  ariaPosInSet: 1,
  ariaRowIndex: 1,
};

/**
 * Computes ARIA sibling metadata (setSize and posInSet) for a list of sibling nodes.
 * Returns a Map from node ID to { setSize, posInSet }.
 */
function computeSiblingAria(
  siblings: TreeNode<unknown>[]
): Map<string, { setSize: number; posInSet: number }> {
  const result = new Map<string, { setSize: number; posInSet: number }>();
  const setSize = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const sibling = siblings[i];
    if (sibling) {
      result.set(sibling.id, { setSize, posInSet: i + 1 });
    }
  }
  return result;
}

/**
 * Flattens a tree structure into a linear array suitable for virtualized rendering.
 * Only includes nodes whose ancestors are all expanded.
 *
 * @param nodes - Root-level tree nodes
 * @param options - Flatten options including expansion state and selection
 * @returns FlattenResult with flattened rows and lookup map
 */
export function flattenTree<T>(nodes: TreeNode<T>[], options: FlattenOptions): FlattenResult<T> {
  const {
    expandedIds,
    selectedId = null,
    multiSelectedIds = new Set<string>(),
    highlightedIds = new Set<string>(),
    contextNodeIds = new Set<string>(),
    filterFn,
  } = options;

  const rows: FlattenedRow<T>[] = [];
  const indexMap = new Map<string, number>();
  const rootSiblingAria = computeSiblingAria(nodes as TreeNode<unknown>[]);

  function traverse(nodeList: TreeNode<T>[], parentExpanded: boolean): void {
    for (const node of nodeList) {
      // Skip if filter is provided and node doesn't match
      const matchesFilter = filterFn ? filterFn(node as TreeNode<unknown>) : true;

      if (!parentExpanded) {
        // Parent is collapsed, skip this node
        continue;
      }

      const isExpanded = expandedIds.has(node.id);
      const isSelected = selectedId === node.id || multiSelectedIds.has(node.id);
      const isHighlighted = highlightedIds.has(node.id);
      const isInContext = contextNodeIds.has(node.id);

      const siblingInfo = rootSiblingAria.get(node.id);
      const rowIndex = rows.length;
      const aria: TreeRowAriaAttributes = {
        ariaLevel: node.depth + 1,
        ariaSetSize: siblingInfo?.setSize ?? 1,
        ariaPosInSet: siblingInfo?.posInSet ?? 1,
        ariaRowIndex: rowIndex + 2, // +2: 1-based + header row
      };

      const row: FlattenedRow<T> = {
        node,
        index: rowIndex,
        isExpanded,
        isSelected,
        isHighlighted,
        matchesFilter,
        isInContext,
        aria,
      };

      indexMap.set(node.id, rows.length);
      rows.push(row);

      // If this node has children and is expanded, traverse children
      // Children are traversed by the parent component providing nested nodes
    }
  }

  traverse(nodes, true);

  return {
    rows,
    indexMap,
    visibleCount: rows.length,
  };
}

/**
 * Recursively flattens a tree with nested children structure.
 * This is for trees where children are embedded in the node structure.
 *
 * @param nodes - Root-level tree nodes with optional children property
 * @param options - Flatten options
 * @param getChildren - Function to get children of a node
 * @returns FlattenResult with flattened rows
 */
export function flattenTreeRecursive<T>(
  nodes: TreeNode<T>[],
  options: FlattenOptions,
  getChildren: (node: TreeNode<T>) => TreeNode<T>[]
): FlattenResult<T> {
  const {
    expandedIds,
    selectedId = null,
    multiSelectedIds = new Set<string>(),
    highlightedIds = new Set<string>(),
    contextNodeIds = new Set<string>(),
    filterFn,
  } = options;

  const rows: FlattenedRow<T>[] = [];
  const indexMap = new Map<string, number>();

  function traverse(nodeList: TreeNode<T>[]): void {
    const siblingAria = computeSiblingAria(nodeList as TreeNode<unknown>[]);

    for (const node of nodeList) {
      const matchesFilter = filterFn ? filterFn(node as TreeNode<unknown>) : true;
      const isExpanded = expandedIds.has(node.id);
      const isSelected = selectedId === node.id || multiSelectedIds.has(node.id);
      const isHighlighted = highlightedIds.has(node.id);
      const isInContext = contextNodeIds.has(node.id);

      const siblingInfo = siblingAria.get(node.id);
      const rowIndex = rows.length;
      const aria: TreeRowAriaAttributes = {
        ariaLevel: node.depth + 1,
        ariaSetSize: siblingInfo?.setSize ?? 1,
        ariaPosInSet: siblingInfo?.posInSet ?? 1,
        ariaRowIndex: rowIndex + 2, // +2: 1-based + header row
      };

      const row: FlattenedRow<T> = {
        node,
        index: rowIndex,
        isExpanded,
        isSelected,
        isHighlighted,
        matchesFilter,
        isInContext,
        aria,
      };

      indexMap.set(node.id, rows.length);
      rows.push(row);

      // Recursively process children if expanded
      if (node.hasChildren && isExpanded) {
        const children = getChildren(node);
        traverse(children);
      }
    }
  }

  traverse(nodes);

  return {
    rows,
    indexMap,
    visibleCount: rows.length,
  };
}

/**
 * Gets the count of visible nodes (nodes whose ancestors are all expanded).
 *
 * @param nodes - Root-level tree nodes
 * @param expandedIds - Set of expanded node IDs
 * @param getChildren - Function to get children of a node
 * @returns Count of visible nodes
 */
export function getVisibleNodeCount<T>(
  nodes: TreeNode<T>[],
  expandedIds: Set<string>,
  getChildren: (node: TreeNode<T>) => TreeNode<T>[]
): number {
  let count = 0;

  function traverse(nodeList: TreeNode<T>[]): void {
    for (const node of nodeList) {
      count++;
      if (node.hasChildren && expandedIds.has(node.id)) {
        traverse(getChildren(node));
      }
    }
  }

  traverse(nodes);
  return count;
}

/**
 * Finds a node by ID in the tree structure.
 *
 * @param nodes - Root-level tree nodes
 * @param id - Node ID to find
 * @param getChildren - Function to get children of a node
 * @returns The found node or null
 */
export function findNodeById<T>(
  nodes: TreeNode<T>[],
  id: string,
  _getChildren: (node: TreeNode<T>) => TreeNode<T>[]
): TreeNode<T> | null {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    if (node.hasChildren) {
      const found = findNodeById(_getChildren(node), id, _getChildren);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Gets the path from root to a specific node.
 *
 * @param nodes - Root-level tree nodes
 * @param nodeId - Target node ID
 * @param getChildren - Function to get children of a node
 * @returns Array of nodes from root to target, or empty array if not found
 */
export function getNodePath<T>(
  nodes: TreeNode<T>[],
  nodeId: string,
  getChildren: (node: TreeNode<T>) => TreeNode<T>[]
): TreeNode<T>[] {
  const path: TreeNode<T>[] = [];

  function traverse(nodeList: TreeNode<T>[]): boolean {
    for (const node of nodeList) {
      path.push(node);
      if (node.id === nodeId) {
        return true;
      }
      if (node.hasChildren && traverse(getChildren(node))) {
        return true;
      }
      path.pop();
    }
    return false;
  }

  traverse(nodes);
  return path;
}

/**
 * Gets all ancestor IDs for a given node.
 *
 * @param nodes - Root-level tree nodes
 * @param nodeId - Target node ID
 * @param getChildren - Function to get children of a node
 * @returns Set of ancestor node IDs (excluding the node itself)
 */
export function getAncestorIds<T>(
  nodes: TreeNode<T>[],
  nodeId: string,
  getChildren: (node: TreeNode<T>) => TreeNode<T>[]
): Set<string> {
  const path = getNodePath(nodes, nodeId, getChildren);
  const ancestorIds = new Set<string>();

  // Exclude the last node (the target node itself)
  for (let i = 0; i < path.length - 1; i++) {
    const pathNode = path[i];
    if (pathNode) {
      ancestorIds.add(pathNode.id);
    }
  }

  return ancestorIds;
}

/**
 * Gets all descendant IDs for a given node.
 *
 * @param node - Starting node
 * @param getChildren - Function to get children of a node
 * @returns Set of all descendant node IDs
 */
export function getDescendantIds<T>(
  node: TreeNode<T>,
  getChildren: (node: TreeNode<T>) => TreeNode<T>[]
): Set<string> {
  const descendantIds = new Set<string>();

  function traverse(currentNode: TreeNode<T>): void {
    if (currentNode.hasChildren) {
      for (const child of getChildren(currentNode)) {
        descendantIds.add(child.id);
        traverse(child);
      }
    }
  }

  traverse(node);
  return descendantIds;
}

/**
 * Expands all ancestors of a node to make it visible.
 *
 * @param nodes - Root-level tree nodes
 * @param nodeId - Target node ID to reveal
 * @param expandedIds - Current set of expanded IDs
 * @param getChildren - Function to get children of a node
 * @returns New set of expanded IDs including all ancestors
 */
export function expandToNode<T>(
  nodes: TreeNode<T>[],
  nodeId: string,
  expandedIds: Set<string>,
  getChildren: (node: TreeNode<T>) => TreeNode<T>[]
): Set<string> {
  const ancestorIds = getAncestorIds(nodes, nodeId, getChildren);
  return new Set([...expandedIds, ...ancestorIds]);
}

/**
 * Gets the next visible node ID for keyboard navigation.
 *
 * @param rows - Flattened rows
 * @param currentId - Current focused node ID
 * @param direction - Navigation direction ('up' | 'down')
 * @returns Next node ID or null if at boundary
 */
export function getNextVisibleNodeId<T>(
  rows: FlattenedRow<T>[],
  currentId: string | null,
  direction: 'up' | 'down'
): string | null {
  if (rows.length === 0) {
    return null;
  }

  if (currentId === null) {
    // If nothing focused, return first or last based on direction
    const firstRow = rows[0];
    const lastRow = rows.at(-1);
    return direction === 'down' ? (firstRow?.node.id ?? null) : (lastRow?.node.id ?? null);
  }

  const currentIndex = rows.findIndex((row) => row.node.id === currentId);
  if (currentIndex === -1) {
    const firstRow = rows[0];
    return firstRow?.node.id ?? null;
  }

  const nextIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1;

  if (nextIndex < 0 || nextIndex >= rows.length) {
    return null;
  }

  const nextRow = rows[nextIndex];
  return nextRow?.node.id ?? null;
}

/**
 * Gets the parent node ID for a given node.
 *
 * @param nodes - Root-level tree nodes
 * @param nodeId - Target node ID
 * @param getChildren - Function to get children of a node
 * @returns Parent node ID or null if at root
 */
export function getParentNodeId<T>(
  nodes: TreeNode<T>[],
  nodeId: string,
  getChildren: (node: TreeNode<T>) => TreeNode<T>[]
): string | null {
  const path = getNodePath(nodes, nodeId, getChildren);
  if (path.length <= 1) {
    return null;
  }
  const parentNode = path.at(-2);
  return parentNode?.id ?? null;
}

/**
 * Gets the first child node ID for a given node.
 *
 * @param node - Parent node
 * @param getChildren - Function to get children of a node
 * @returns First child node ID or null if no children
 */
export function getFirstChildNodeId<T>(
  node: TreeNode<T>,
  getChildren: (node: TreeNode<T>) => TreeNode<T>[]
): string | null {
  if (!node.hasChildren) {
    return null;
  }
  const children = getChildren(node);
  const firstChild = children[0];
  return firstChild?.id ?? null;
}

/**
 * Calculates range selection between two node IDs.
 *
 * @param rows - Flattened rows
 * @param fromId - Start node ID
 * @param toId - End node ID
 * @returns Set of node IDs in the range (inclusive)
 */
export function getRangeSelection<T>(
  rows: FlattenedRow<T>[],
  fromId: string,
  toId: string
): Set<string> {
  const fromIndex = rows.findIndex((row) => row.node.id === fromId);
  const toIndex = rows.findIndex((row) => row.node.id === toId);

  if (fromIndex === -1 || toIndex === -1) {
    return new Set<string>();
  }

  const startIndex = Math.min(fromIndex, toIndex);
  const endIndex = Math.max(fromIndex, toIndex);

  const selectedIds = new Set<string>();
  for (let i = startIndex; i <= endIndex; i++) {
    const row = rows[i];
    if (row) {
      selectedIds.add(row.node.id);
    }
  }

  return selectedIds;
}

/**
 * Filters tree nodes based on a predicate, keeping ancestors of matching nodes visible.
 *
 * @param nodes - Root-level tree nodes
 * @param predicate - Filter predicate
 * @param getChildren - Function to get children of a node
 * @returns Object with matching node IDs and their ancestor IDs
 */
/**
 * Helper to add all ancestor IDs to a set
 */
function addAncestors(ancestors: string[], ancestorIds: Set<string>): void {
  for (const ancestorId of ancestors) {
    ancestorIds.add(ancestorId);
  }
}

/**
 * Process a single node during tree traversal for filtering
 */
function processNodeForFilter<T>(
  node: TreeNode<T>,
  ancestors: string[],
  predicate: (node: TreeNode<T>) => boolean,
  getChildren: (node: TreeNode<T>) => TreeNode<T>[],
  matchingIds: Set<string>,
  ancestorIds: Set<string>,
  traverseFn: (nodeList: TreeNode<T>[], ancestors: string[]) => boolean
): boolean {
  const nodeMatches = predicate(node);
  const childHasMatch = node.hasChildren
    ? traverseFn(getChildren(node), [...ancestors, node.id])
    : false;

  if (nodeMatches || childHasMatch) {
    if (nodeMatches) {
      matchingIds.add(node.id);
    }
    addAncestors(ancestors, ancestorIds);
    return true;
  }
  return false;
}

export function filterTreeNodes<T>(
  nodes: TreeNode<T>[],
  predicate: (node: TreeNode<T>) => boolean,
  getChildren: (node: TreeNode<T>) => TreeNode<T>[]
): { matchingIds: Set<string>; ancestorIds: Set<string> } {
  const matchingIds = new Set<string>();
  const ancestorIds = new Set<string>();

  function traverse(nodeList: TreeNode<T>[], ancestors: string[]): boolean {
    let hasMatchingDescendant = false;
    for (const node of nodeList) {
      const matched = processNodeForFilter(
        node,
        ancestors,
        predicate,
        getChildren,
        matchingIds,
        ancestorIds,
        traverse
      );
      if (matched) {
        hasMatchingDescendant = true;
      }
    }
    return hasMatchingDescendant;
  }

  traverse(nodes, []);
  return { matchingIds, ancestorIds };
}

/**
 * Creates a simple children getter for flat node arrays with parentId references.
 *
 * @param allNodes - All nodes in the tree
 * @returns Function that returns children for a given node
 */
export function createChildrenGetter<T>(
  allNodes: TreeNode<T>[]
): (node: TreeNode<T>) => TreeNode<T>[] {
  // Build a map of parentId -> children for efficient lookup
  const childrenMap = new Map<string | null, TreeNode<T>[]>();

  for (const node of allNodes) {
    const parentId = node.parentId;
    if (!childrenMap.has(parentId)) {
      childrenMap.set(parentId, []);
    }
    childrenMap.get(parentId)?.push(node);
  }

  return (node: TreeNode<T>) => childrenMap.get(node.id) ?? [];
}

/**
 * Builds a tree structure from a flat array of nodes with parentId references.
 *
 * @param nodes - Flat array of nodes
 * @returns Root-level nodes with children accessible via parentId
 */
export function buildTreeFromFlatNodes<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  return nodes.filter((node) => node.parentId === null);
}

/**
 * Computes the checkbox state for a parent node based on its descendants' selection state.
 *
 * @param nodeId - The node ID to compute state for
 * @param multiSelectedIds - Currently selected node IDs
 * @param getDescendants - Function to get all descendant IDs for a node
 * @returns 'checked' if all descendants selected, 'indeterminate' if some, 'unchecked' if none
 */
export function computeCheckboxState(
  nodeId: string,
  multiSelectedIds: Set<string>,
  getDescendants: (nodeId: string) => Set<string>
): 'checked' | 'unchecked' | 'indeterminate' {
  if (multiSelectedIds.has(nodeId)) {
    return 'checked';
  }

  const descendants = getDescendants(nodeId);
  if (descendants.size === 0) {
    return multiSelectedIds.has(nodeId) ? 'checked' : 'unchecked';
  }

  let selectedCount = 0;
  for (const descId of descendants) {
    if (multiSelectedIds.has(descId)) {
      selectedCount++;
    }
  }

  if (selectedCount === 0) {
    return 'unchecked';
  }
  if (selectedCount === descendants.size) {
    return 'checked';
  }
  return 'indeterminate';
}

// Re-export DEFAULT_ARIA for use in tests
export { DEFAULT_ARIA };
