/**
 * Singleton store for collection-browser column widths.
 *
 * Persists `Record<columnId, pixelWidth>` across reloads. The single
 * `score` column is optional; its bound is registered unconditionally so
 * persisted values survive toggling score visibility.
 */
import {
  createTreeTableColumnSizesStore,
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
const BRAND = '__brainstrike_store_brand__';
const BRAND_VERSION = 1 as const;
const g = globalThis as unknown as Record<string, unknown>;

type BoundStore = ReturnType<typeof createTreeTableColumnSizesStore>;

function isValidStore(candidate: unknown): candidate is BoundStore & { [k: string]: unknown } {
  if (!candidate || typeof candidate !== 'function') {
    return false;
  }
  const fn = candidate as unknown as {
    getState?: unknown;
    setState?: unknown;
    [k: string]: unknown;
  };
  const ok = typeof fn.getState === 'function' && typeof fn.setState === 'function';
  return ok && fn[BRAND] === BRAND_VERSION;
}

let singleton = g[GLOBAL_KEY] as unknown;

if (!isValidStore(singleton)) {
  singleton = createTreeTableColumnSizesStore({
    storeName: STORE_NAME,
    version: STORE_VERSION,
    columnBounds: COLLECTION_BROWSER_COLUMN_BOUNDS,
  });
  (singleton as Record<string, unknown>)[BRAND] = BRAND_VERSION;
  g[GLOBAL_KEY] = singleton as unknown;
}

export const useCollectionBrowserColumnSizesStore = singleton as BoundStore;

export type { TreeTableColumnSizesStoreState };
