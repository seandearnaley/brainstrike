import type { IFileNode } from '@brainstrike/types';

export interface VisibleNodeEntry {
  node: IFileNode;
  depth: number;
}

// Cache flattened visible nodes by (tree identity, expanded set identity)
// Include an expansion version to tolerate in-place Set mutations.
type ExpandedSetCacheEntry = { v: number | undefined; list: VisibleNodeEntry[] };
const treeCache = new WeakMap<IFileNode[], WeakMap<ReadonlySet<string>, ExpandedSetCacheEntry>>();

function computeVisibleNodes(
  fileTree: IFileNode[],
  expanded: ReadonlySet<string>
): VisibleNodeEntry[] {
  const result: VisibleNodeEntry[] = [];

  // Iterative DFS pre-order to match existing behavior
  type StackItem = { node: IFileNode; depth: number };
  const stack: StackItem[] = [];

  // Seed stack in reverse to process in original order
  for (let i = fileTree.length - 1; i >= 0; i--) {
    stack.push({ node: fileTree[i] as IFileNode, depth: 0 });
  }

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const { node, depth } = current;
    result.push({ node, depth });

    if (
      node.type === 'directory' &&
      expanded.has(node.path) &&
      Array.isArray(node.children) &&
      node.children.length > 0
    ) {
      // Filter invisible children and push in reverse to maintain order
      const visibleChildren = node.children.filter((c) => c.isVisible !== false);
      for (let i = visibleChildren.length - 1; i >= 0; i--) {
        stack.push({ node: visibleChildren[i] as IFileNode, depth: depth + 1 });
      }
    }
  }

  return result;
}

export function getVisibleNodes(
  fileTree: IFileNode[],
  expanded: ReadonlySet<string>,
  _expansionVersion?: number
): VisibleNodeEntry[] {
  let expandedMap = treeCache.get(fileTree);
  if (!expandedMap) {
    expandedMap = new WeakMap<ReadonlySet<string>, ExpandedSetCacheEntry>();
    treeCache.set(fileTree, expandedMap);
  }

  // If a version token is provided, only return cache when versions match.
  const cached = expandedMap.get(expanded);
  if (cached && cached.v === _expansionVersion) return cached.list;

  const flattened = computeVisibleNodes(fileTree, expanded);
  expandedMap.set(expanded, { v: _expansionVersion, list: flattened });
  return flattened;
}

export function invalidateVisibleNodesCache(fileTree: IFileNode[]): void {
  treeCache.delete(fileTree);
}
