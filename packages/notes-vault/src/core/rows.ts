import type { TreeNode } from '@brainstrike/ui';
import { sortVaultTree } from './sort';
import type {
  VaultDirectoryHandleLike,
  VaultFolderNode,
  VaultNoteNode,
  VaultRootId,
  VaultSortMode,
  VaultTreeNode,
} from './types';

export type VaultRootStatus = 'scanning' | 'ready' | 'error' | 'permission-required';

export interface VaultRootState {
  readonly error?: string | undefined;
  readonly handle: VaultDirectoryHandleLike;
  readonly name: string;
  readonly nodes: readonly VaultTreeNode[];
  readonly noteCount: number;
  readonly rootId: VaultRootId;
  readonly status: VaultRootStatus;
}

export type VaultRowData =
  | { kind: 'root'; root: VaultRootState }
  | { kind: 'folder'; node: VaultFolderNode }
  | { kind: 'note'; node: VaultNoteNode };

export type VaultTreeRow = TreeNode<VaultRowData>;

export const VAULT_ROOT_ROW_TYPE = 'vault-root';

function appendNodeRows(
  rows: VaultTreeRow[],
  nodes: readonly VaultTreeNode[],
  parentId: string,
  depth: number
): void {
  for (const node of nodes) {
    if (node.type === 'folder') {
      rows.push({
        childCount: node.children.length,
        data: { kind: 'folder', node },
        depth,
        hasChildren: node.children.length > 0,
        id: node.id,
        parentId,
        type: 'folder',
      });
      appendNodeRows(rows, node.children, node.id, depth + 1);
    } else {
      rows.push({
        data: { kind: 'note', node },
        depth,
        hasChildren: false,
        id: node.id,
        parentId,
        type: 'note',
      });
    }
  }
}

/**
 * Converts vault roots into the flat, DFS-ordered TreeNode row array the
 * shared TreeTable consumes (it derives expand/collapse visibility itself
 * from parentId links + expandedIds). Sibling order is the sorted order, so
 * sorting is applied here — TreeTable's sort props are presentation-only by
 * contract.
 */
export function buildVaultTreeRows(
  roots: readonly VaultRootState[],
  sortMode: VaultSortMode
): VaultTreeRow[] {
  const rows: VaultTreeRow[] = [];
  for (const root of roots) {
    const sorted = sortVaultTree(root.nodes, sortMode);
    rows.push({
      childCount: sorted.length,
      data: { kind: 'root', root },
      depth: 0,
      hasChildren: sorted.length > 0,
      id: root.rootId,
      isLoading: root.status === 'scanning',
      parentId: null,
      type: VAULT_ROOT_ROW_TYPE,
    });
    appendNodeRows(rows, sorted, root.rootId, 1);
  }
  return rows;
}
