import type { TreeNode } from '@brainstrike/ui';
import type { CatalogRow } from './catalog-projection';

export type CatalogNodeData =
  | { readonly kind: 'detail'; readonly row: CatalogRow }
  | { readonly kind: 'model'; readonly row: CatalogRow };

export interface CatalogRowNodes {
  readonly detail: TreeNode<CatalogNodeData>;
  readonly model: TreeNode<CatalogNodeData>;
}

/**
 * Identity-stable TreeNodes per CatalogRow identity. TreeTable's flatten-level
 * reuse requires `a.node === b.node` (TreeGrid row-identity contract), so a
 * toggle rebuilds exactly one row's nodes and nothing else.
 */
export function createCatalogNodeCache(): (row: CatalogRow) => CatalogRowNodes {
  const cache = new WeakMap<CatalogRow, CatalogRowNodes>();
  return (row) => {
    const cached = cache.get(row);
    if (cached) {
      return cached;
    }
    const nodes: CatalogRowNodes = {
      detail: {
        data: { kind: 'detail', row },
        depth: 1,
        hasChildren: false,
        id: `${row.id}::details`,
        parentId: row.id,
        type: 'detail',
      },
      model: {
        data: { kind: 'model', row },
        depth: 0,
        hasChildren: true,
        id: row.id,
        parentId: null,
        type: 'model',
      },
    };
    cache.set(row, nodes);
    return nodes;
  };
}

export function buildSectionNodes(
  rows: readonly CatalogRow[],
  getNodes: (row: CatalogRow) => CatalogRowNodes
): TreeNode<CatalogNodeData>[] {
  return rows.flatMap((row) => {
    const nodes = getNodes(row);
    return [nodes.model, nodes.detail];
  });
}
