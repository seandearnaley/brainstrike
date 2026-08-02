/**
 * Singleton store for context-explorer preview-table column widths.
 *
 * Used by the grouped-mode TreeTable rendering path. The ungrouped path
 * remains hand-rolled (tracked separately by BST-312); column ids here
 * intentionally match those in the grouped builders so the convergence
 * follow-up can drop directly onto the same persistence layer.
 */
import {
  createSingletonColumnSizesStore,
  type TreeTableColumnSizesStoreState,
} from './tree-table-column-sizes-store';

export const CONTEXT_PREVIEW_COLUMN_BOUNDS = {
  checkbox: { defaultWidth: 32, maxWidth: 32, minWidth: 32 },
  path: { defaultWidth: 360, maxWidth: 900, minWidth: 160 },
  rootFolderId: { defaultWidth: 176, maxWidth: 360, minWidth: 100 },
  size: { defaultWidth: 96, maxWidth: 180, minWidth: 72 },
  tokens: { defaultWidth: 96, maxWidth: 180, minWidth: 72 },
  type: { defaultWidth: 96, maxWidth: 180, minWidth: 72 },
} as const;

const STORE_NAME = 'context-preview-column-sizes.v1' as const;
const STORE_VERSION = 1 as const;
const GLOBAL_KEY = '__brainstrike_context_preview_column_sizes_store__' as const;

export const useContextPreviewColumnSizesStore = createSingletonColumnSizesStore(GLOBAL_KEY, {
  columnBounds: CONTEXT_PREVIEW_COLUMN_BOUNDS,
  storeName: STORE_NAME,
  version: STORE_VERSION,
});

export type { TreeTableColumnSizesStoreState };
