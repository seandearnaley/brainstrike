import type { VaultSortMode, VaultTreeNode } from './types';

// Numeric-aware, case-insensitive collation: "Note2" sorts before "note10".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareWithinKind(a: VaultTreeNode, b: VaultTreeNode, mode: VaultSortMode): number {
  const byName = collator.compare(a.name, b.name);
  switch (mode) {
    case 'name-asc':
      return byName;
    case 'name-desc':
      return -byName;
    case 'modified-desc':
      return b.lastModified - a.lastModified || byName;
    case 'modified-asc':
      return a.lastModified - b.lastModified || byName;
    default: {
      const exhausted: never = mode;
      throw new Error(`Unsupported vault sort mode: ${String(exhausted)}`);
    }
  }
}

export function compareVaultNodes(a: VaultTreeNode, b: VaultTreeNode, mode: VaultSortMode): number {
  if (a.type !== b.type) {
    return a.type === 'folder' ? -1 : 1;
  }
  return compareWithinKind(a, b, mode);
}

/** Returns a recursively sorted copy; folders always group before notes. */
export function sortVaultTree(
  nodes: readonly VaultTreeNode[],
  mode: VaultSortMode
): VaultTreeNode[] {
  return nodes
    .map((node) =>
      node.type === 'folder' ? { ...node, children: sortVaultTree(node.children, mode) } : node
    )
    .sort((a, b) => compareVaultNodes(a, b, mode));
}
