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
  /** True for the app-provisioned default vault: derived each boot, never
   * persisted, and not removable from the tree. */
  readonly builtIn?: boolean | undefined;
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

const VAULT_ROOT_ROW_TYPE = 'vault-root';

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

// Per-root descendant-row cache keyed by the root's immutable nodes array
// (a rescan replaces the array; status-only patches keep it). Reusing the
// exact row objects lets TreeTable's reuseEqualFlattenedRows (a.node === b.node)
// bail out of re-rendering untouched rows — the pinned TREEGRID
// render-stability contract ("avoid full-tree rematerialization").
const descendantRowsCache = new WeakMap<
  readonly VaultTreeNode[],
  Map<VaultSortMode, VaultTreeRow[]>
>();

function descendantRowsFor(root: VaultRootState, sortMode: VaultSortMode): VaultTreeRow[] {
  let bySort = descendantRowsCache.get(root.nodes);
  if (!bySort) {
    bySort = new Map();
    descendantRowsCache.set(root.nodes, bySort);
  }
  let rows = bySort.get(sortMode);
  if (!rows) {
    rows = [];
    appendNodeRows(rows, sortVaultTree(root.nodes, sortMode), root.rootId, 1);
    bySort.set(sortMode, rows);
  }
  return rows;
}

/**
 * Converts vault roots into the flat, DFS-ordered TreeNode row array the
 * shared TreeTable consumes (it derives expand/collapse visibility itself
 * from parentId links + expandedIds). Sibling order is the sorted order, so
 * sorting is applied here — TreeTable's sort props are presentation-only by
 * contract. Descendant rows are cached per (nodes, sortMode) so one root's
 * rescan never rematerializes the other roots' rows.
 */
export function buildVaultTreeRows(
  roots: readonly VaultRootState[],
  sortMode: VaultSortMode
): VaultTreeRow[] {
  const rows: VaultTreeRow[] = [];
  for (const root of roots) {
    const descendants = descendantRowsFor(root, sortMode);
    const childCount = descendants.filter((row) => row.parentId === root.rootId).length;
    rows.push({
      childCount,
      data: { kind: 'root', root },
      depth: 0,
      hasChildren: childCount > 0,
      id: root.rootId,
      isLoading: root.status === 'scanning',
      parentId: null,
      type: VAULT_ROOT_ROW_TYPE,
    });
    rows.push(...descendants);
  }
  return rows;
}
