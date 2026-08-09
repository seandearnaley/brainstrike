/**
 * Singleton store for the Explorer tree-grid column widths (BST-1208).
 *
 * Third sibling of `context-preview-column-sizes-store.ts` and
 * `collection-browser-column-sizes-store.ts`, built from the same factory, so
 * sanitization, migration and persistence behave identically across every
 * TreeTable surface.
 *
 * The `name` column is deliberately ABSENT: it is the tree column, pinned to
 * the remaining space, and has no persisted pixel width. Only the metadata
 * columns are resizable, and the bounds below are the single source of truth
 * for both the persisted values and the `TreeTableColumn` definitions — a
 * mismatch would let the store clamp a width the column renderer would not.
 *
 * Factory reset is implicit, exactly as for the two siblings:
 * `clearPersistentUiState` performs a `localStorage.clear()`, which removes
 * every versioned store created by this factory.
 */
import {
  createSingletonColumnSizesStore,
  type TreeTableColumnSizesStoreState,
} from './tree-table-column-sizes-store';

export const EXPLORER_COLUMN_BOUNDS = {
  size: { defaultWidth: 76, maxWidth: 160, minWidth: 52 },
  tokens: { defaultWidth: 76, maxWidth: 160, minWidth: 52 },
  type: { defaultWidth: 72, maxWidth: 160, minWidth: 48 },
} as const;

const STORE_NAME = 'explorer-column-sizes.v1' as const;
const STORE_VERSION = 1 as const;
const GLOBAL_KEY = '__brainstrike_explorer_column_sizes_store__' as const;

export const useExplorerColumnSizesStore = createSingletonColumnSizesStore(GLOBAL_KEY, {
  columnBounds: EXPLORER_COLUMN_BOUNDS,
  storeName: STORE_NAME,
  version: STORE_VERSION,
});

export type { TreeTableColumnSizesStoreState };
