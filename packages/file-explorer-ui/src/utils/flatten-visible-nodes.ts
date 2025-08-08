import type { IFileNode } from '@brainstrike/types';

export interface VisibleNodeEntry {
  node: IFileNode;
  depth: number;
}

// Cache flattened visible nodes by (tree identity, expanded set identity)
const treeCache = new WeakMap<IFileNode[], WeakMap<ReadonlySet<string>, VisibleNodeEntry[]>>();

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
  expanded: ReadonlySet<string>
): VisibleNodeEntry[] {
  let expandedMap = treeCache.get(fileTree);
  if (!expandedMap) {
    expandedMap = new WeakMap<ReadonlySet<string>, VisibleNodeEntry[]>();
    treeCache.set(fileTree, expandedMap);
  }

  const cached = expandedMap.get(expanded);
  if (cached) return cached;

  const flattened = computeVisibleNodes(fileTree, expanded);
  expandedMap.set(expanded, flattened);
  return flattened;
}

export function invalidateVisibleNodesCache(fileTree: IFileNode[]): void {
  treeCache.delete(fileTree);
}
