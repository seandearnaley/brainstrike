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
  ariaPosInSet: 1,
  ariaRowIndex: 1,
  ariaSetSize: 1,
};

/**
 * Computes ARIA sibling metadata (setSize and posInSet) for a list of sibling nodes.
 * Returns a Map from node ID to { setSize, posInSet }.
 */
function computeSiblingAria<T>(
  siblings: TreeNode<T>[]
): Map<string, { setSize: number; posInSet: number }> {
  const result = new Map<string, { setSize: number; posInSet: number }>();
  const setSize = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const sibling = siblings[i];
    if (sibling) {
      result.set(sibling.id, { posInSet: i + 1, setSize });
    }
  }
  return result;
}

/**
 * Resolved flatten options with defaults applied.
 */
interface ResolvedFlattenOptions {
  contextNodeIds: Set<string>;
  expandedIds: Set<string>;
  filterFn?: (node: TreeNode<unknown>) => boolean;
  highlightedIds: Set<string>;
  multiSelectedIds: Set<string>;
  rowIndexOffset: number;
  selectedId: string | null;
}

function resolveOptions(options: FlattenOptions): ResolvedFlattenOptions {
  const resolved: ResolvedFlattenOptions = {
    contextNodeIds: options.contextNodeIds ?? new Set<string>(),
    expandedIds: options.expandedIds,
    highlightedIds: options.highlightedIds ?? new Set<string>(),
    multiSelectedIds: options.multiSelectedIds ?? new Set<string>(),
    rowIndexOffset: options.rowIndexOffset ?? 2,
    selectedId: options.selectedId ?? null,
  };
  if (options.filterFn) {
    resolved.filterFn = options.filterFn;
  }
  return resolved;
}

/**
 * Appends a single FlattenedRow to the accumulator arrays (rows + indexMap).
 */
function appendRow<T>(
  node: TreeNode<T>,
  siblingAria: Map<string, { setSize: number; posInSet: number }>,
  opts: ResolvedFlattenOptions,
  rows: FlattenedRow<T>[],
  indexMap: Map<string, number>
): FlattenedRow<T> {
  const matchesFilter = opts.filterFn ? opts.filterFn(node as TreeNode<unknown>) : true;
  const isExpanded = opts.expandedIds.has(node.id);
  const isSelected = opts.selectedId === node.id || opts.multiSelectedIds.has(node.id);
  const isHighlighted = opts.highlightedIds.has(node.id);
  const isInContext = opts.contextNodeIds.has(node.id);

  const siblingInfo = siblingAria.get(node.id);
  const rowIndex = rows.length;
  const aria: TreeRowAriaAttributes = {
    ariaLevel: node.depth + 1,
    ariaPosInSet: siblingInfo?.posInSet ?? 1,
    ariaRowIndex: rowIndex + opts.rowIndexOffset,
    ariaSetSize: siblingInfo?.setSize ?? 1,
  };

  const row: FlattenedRow<T> = {
    aria,
    index: rowIndex,
    isExpanded,
    isHighlighted,
    isInContext,
    isSelected,
    matchesFilter,
    node,
  };

  indexMap.set(node.id, rows.length);
  rows.push(row);
  return row;
}

function buildResult<T>(rows: FlattenedRow<T>[], indexMap: Map<string, number>): FlattenResult<T> {
  return { indexMap, rows, visibleCount: rows.length };
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
  const opts = resolveOptions(options);
  const rows: FlattenedRow<T>[] = [];
  const indexMap = new Map<string, number>();
  // flattenTree is intentionally non-recursive and only used for a single sibling level.
  // Nested trees should use flattenTreeRecursive, which computes sibling ARIA per depth.
  const rootSiblingAria = computeSiblingAria(nodes);

  function traverse(nodeList: TreeNode<T>[], parentExpanded: boolean): void {
    for (const node of nodeList) {
      if (!parentExpanded) {
        continue;
      }
      appendRow(node, rootSiblingAria, opts, rows, indexMap);
    }
  }

  traverse(nodes, true);
  return buildResult(rows, indexMap);
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
  const opts = resolveOptions(options);
  const rows: FlattenedRow<T>[] = [];
  const indexMap = new Map<string, number>();

  function traverse(nodeList: TreeNode<T>[]): void {
    const siblingAria = computeSiblingAria(nodeList);

    for (const node of nodeList) {
      const row = appendRow(node, siblingAria, opts, rows, indexMap);

      if (node.hasChildren && row.isExpanded) {
        traverse(getChildren(node));
      }
    }
  }

  traverse(nodes);
  return buildResult(rows, indexMap);
}

/**
 * Converts a caller-supplied flat list of already-visible rows into TreeTable's
 * row model without recursively walking children or applying expansion gates.
 *
 * Use this when an adapter has already done tree expansion and flattening
 * upstream, such as large file trees backed by a worker or normalized index.
 */
export function flattenPreFlattenedTreeRows<T>(
  nodes: TreeNode<T>[],
  options: FlattenOptions
): FlattenResult<T> {
  const opts = resolveOptions(options);
  const rows: FlattenedRow<T>[] = [];
  const indexMap = new Map<string, number>();
  const siblingsByParentId = new Map<string | null, TreeNode<T>[]>();

  for (const node of nodes) {
    const siblings = siblingsByParentId.get(node.parentId);
    if (siblings) {
      siblings.push(node);
      continue;
    }
    siblingsByParentId.set(node.parentId, [node]);
  }

  const siblingAriaByParentId = new Map<
    string | null,
    Map<string, { setSize: number; posInSet: number }>
  >();
  for (const [parentId, siblings] of siblingsByParentId) {
    siblingAriaByParentId.set(parentId, computeSiblingAria(siblings));
  }

  for (const node of nodes) {
    appendRow(
      node,
      siblingAriaByParentId.get(node.parentId) ??
        new Map<string, { setSize: number; posInSet: number }>(),
      opts,
      rows,
      indexMap
    );
  }

  return buildResult(rows, indexMap);
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

  let childHasMatch = false;
  if (node.hasChildren) {
    ancestors.push(node.id);
    childHasMatch = traverseFn(getChildren(node), ancestors);
    ancestors.pop();
  }

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
  return { ancestorIds, matchingIds };
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
 * Computes checkbox state from a precomputed descendant set.
 *
 * This is a standalone utility for call sites that only have descendant IDs.
 * TreeTable runtime rendering uses its own memoized tree traversal in
 * `tree-table.tsx` for cycle-aware state aggregation across the full tree.
 *
 * @param nodeId - The node ID to compute state for
 * @param multiSelectedIds - Currently selected node IDs
 * @param getDescendants - Function to get all descendant IDs for a node
 * @returns Leaf nodes: checked when selected, unchecked otherwise.
 * Parents: checked when all descendants selected, indeterminate when some descendants
 * are selected (including explicit parent selection with incomplete descendants),
 * unchecked when none are selected.
 */
export function computeCheckboxState(
  nodeId: string,
  multiSelectedIds: Set<string>,
  getDescendants: (nodeId: string) => Set<string>
): 'checked' | 'unchecked' | 'indeterminate' {
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
    return multiSelectedIds.has(nodeId) ? 'indeterminate' : 'unchecked';
  }
  if (selectedCount === descendants.size) {
    return 'checked';
  }
  return 'indeterminate';
}

// Re-export DEFAULT_ARIA for use in tests
export { DEFAULT_ARIA };
