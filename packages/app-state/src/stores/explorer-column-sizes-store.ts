/**
 * Singleton store for the Explorer tree-grid column widths (BST-1208).
 *
 * Built from `createSingletonColumnSizesStore` so sanitization, migration and
 * persistence follow the shared TreeTable contract. Since BST-1211 retired the
 * context preview table (and its `context-preview-column-sizes.v1` store) this
 * is the factory's only surface; the factory stays generic because it is the
 * documented seam for the next resizable TreeTable.
 *
 * The `name` column is deliberately ABSENT: it is the tree column, pinned to
 * the remaining space, and has no persisted pixel width. Only the metadata
 * columns are resizable, and the bounds below are the single source of truth
 * for both the persisted values and the `TreeTableColumn` definitions — a
 * mismatch would let the store clamp a width the column renderer would not.
 *
 * Factory reset clears BOTH layers. `clearPersistentUiState`'s
 * `localStorage.clear()` removes the persisted slice, but the live singleton
 * survives a web reset (which does not force a reload), so
 * `resetExplorerColumnSizesStoreToDefault` is wired in alongside it — the same
 * shape the Explorer sort and column-visibility stores use.
 */
import {
  createSingletonColumnSizesStore,
  type TreeTableColumnSizesStoreState,
} from './tree-table-column-sizes-store';

export const EXPLORER_COLUMN_BOUNDS = {
  size: { defaultWidth: 76, maxWidth: 160, minWidth: 52 },
  // The header fits on one line at 88px; 28px keeps all four columns inside the 300px step.
  thread: { defaultWidth: 88, maxWidth: 160, minWidth: 28 },
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

/** FACTORY RESET CONTRACT; see the module comment. */
export function resetExplorerColumnSizesStoreToDefault(): void {
  useExplorerColumnSizesStore.getState().reset();
}

export type { TreeTableColumnSizesStoreState };
