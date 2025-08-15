import type { FilterSpec, TreeNode, VisibleRow } from './lazy-tree-protocol';

export function matchesFilter(node: TreeNode, filter?: FilterSpec): boolean {
  if (!filter) return true;
  const { include, exclude, allowList } = filter;
  if (allowList?.length) return allowList.includes(node.path);
  const hay = `${node.name}|${node.path}`.toLowerCase();
  if (include?.length && !include.some((s) => hay.includes(s.toLowerCase()))) return false;
  if (exclude?.length && exclude.some((s) => hay.includes(s.toLowerCase()))) return false;
  return true;
}

function initializeStack(tree: TreeNode[]): Array<{ node: TreeNode; depth: number }> {
  const stack: Array<{ node: TreeNode; depth: number }> = [];
  for (let i = tree.length - 1; i >= 0; i--) {
    const node = tree[i];
    if (node) stack.push({ node, depth: 0 });
  }
  return stack;
}

function includeIfEligible(
  node: TreeNode,
  depth: number,
  filter: FilterSpec | undefined,
  out: VisibleRow[]
) {
  if (node.type === 'directory' || matchesFilter(node, filter)) {
    out.push({ path: node.path, name: node.name, type: node.type, depth });
  }
}

function pushChildrenIfExpanded(
  node: TreeNode,
  depth: number,
  expanded: Set<string>,
  stack: Array<{ node: TreeNode; depth: number }>
) {
  if (node.type !== 'directory' || !expanded.has(node.path)) return;
  const kids = node.children ?? [];
  for (let i = kids.length - 1; i >= 0; i--) {
    const kid = kids[i];
    if (kid) stack.push({ node: kid, depth: depth + 1 });
  }
}

/** DFS flatten honoring expanded + filter. Used by worker and main-thread fallback. */
export function computeVisibleRows(
  tree: TreeNode[],
  expanded: Set<string>,
  filter?: FilterSpec
): VisibleRow[] {
  const out: VisibleRow[] = [];
  const stack = initializeStack(tree);

  while (stack.length) {
    const popped = stack.pop();
    if (!popped) continue;
    const { node, depth } = popped;
    includeIfEligible(node, depth, filter, out);
    pushChildrenIfExpanded(node, depth, expanded, stack);
  }
  return out;
}
