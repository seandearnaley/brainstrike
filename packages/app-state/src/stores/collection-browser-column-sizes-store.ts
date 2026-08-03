/**
 * Singleton store for collection-browser column widths.
 *
 * Persists `Record<columnId, pixelWidth>` across reloads. The single
 * `score` column is optional; its bound is registered unconditionally so
 * persisted values survive toggling score visibility.
 */
import {
  createSingletonColumnSizesStore,
  type TreeTableColumnSizesStoreState,
} from './tree-table-column-sizes-store';

export const COLLECTION_BROWSER_COLUMN_BOUNDS = {
  meta: { defaultWidth: 220, maxWidth: 600, minWidth: 100 },
  name: { defaultWidth: 320, maxWidth: 800, minWidth: 150 },
  score: { defaultWidth: 160, maxWidth: 320, minWidth: 100 },
  size: { defaultWidth: 120, maxWidth: 240, minWidth: 72 },
  // Pinned utility column — bounds collapsed so the resize handle is hidden
  // and persisted values never drift.
  status: { defaultWidth: 44, maxWidth: 44, minWidth: 44 },
} as const;

const STORE_NAME = 'collection-browser-column-sizes.v1' as const;
const STORE_VERSION = 1 as const;
const GLOBAL_KEY = '__brainstrike_collection_browser_column_sizes_store__' as const;

export const useCollectionBrowserColumnSizesStore = createSingletonColumnSizesStore(GLOBAL_KEY, {
  columnBounds: COLLECTION_BROWSER_COLUMN_BOUNDS,
  storeName: STORE_NAME,
  version: STORE_VERSION,
});

export type { TreeTableColumnSizesStoreState };
