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
  name: { defaultWidth: 320, minWidth: 150, maxWidth: 800 },
  // Pinned utility column — bounds collapsed so the resize handle is hidden
  // and persisted values never drift.
  status: { defaultWidth: 44, minWidth: 44, maxWidth: 44 },
  score: { defaultWidth: 160, minWidth: 100, maxWidth: 320 },
  size: { defaultWidth: 120, minWidth: 72, maxWidth: 240 },
  meta: { defaultWidth: 220, minWidth: 100, maxWidth: 600 },
} as const;

const STORE_NAME = 'collection-browser-column-sizes.v1' as const;
const STORE_VERSION = 1 as const;
const GLOBAL_KEY = '__brainstrike_collection_browser_column_sizes_store__' as const;

export const useCollectionBrowserColumnSizesStore = createSingletonColumnSizesStore(GLOBAL_KEY, {
  storeName: STORE_NAME,
  version: STORE_VERSION,
  columnBounds: COLLECTION_BROWSER_COLUMN_BOUNDS,
});

export type { TreeTableColumnSizesStoreState };
