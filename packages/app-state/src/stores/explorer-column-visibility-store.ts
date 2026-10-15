/**
 * Persisted column visibility for the Explorer tree grid (BST-1208).
 *
 * The Explorer panel is the narrowest surface in the app, so it ships with the
 * two columns that always earn their width (decision D1): the Name tree column
 * — which is pinned and has no visibility toggle at all — plus Tokens. Type and
 * Size are opt-in. "This thread" (ADR-0021) ships on, but only renders where a
 * thread's context is available (desktop).
 *
 * This is a preference, not layout: widths live in
 * `explorer-column-sizes-store.ts`. Keeping them apart means a resize never
 * rewrites visibility and a toggle never rewrites widths (the sizes store
 * deliberately preserves entries for columns that are currently hidden).
 *
 * Factory reset is implicit, as for the sizes store: `clearPersistentUiState`
 * performs a `localStorage.clear()`.
 */
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

/** Metadata columns only — `name` is the pinned tree column and never hides. */
export const EXPLORER_METADATA_COLUMN_IDS = ['thread', 'type', 'tokens', 'size'] as const;

export type ExplorerMetadataColumnId = (typeof EXPLORER_METADATA_COLUMN_IDS)[number];

export type ExplorerColumnVisibility = Record<ExplorerMetadataColumnId, boolean>;

export interface ExplorerColumnVisibilityStoreState extends ExplorerColumnVisibility {
  reset: () => void;
  setColumnVisible: (columnId: ExplorerMetadataColumnId, visible: boolean) => void;
}

/** Decision D1: Tokens ships on; Type and Size are opt-in. */
const DEFAULT_VISIBILITY: ExplorerColumnVisibility = {
  size: false,
  thread: true,
  tokens: true,
  type: false,
};

const STORE_NAME = 'explorer-column-visibility.v1' as const;
const STORE_VERSION = 1 as const;
const GLOBAL_KEY = '__brainstrike_explorer_column_visibility_store__' as const;
const BRAND = '__brainstrike_store_brand__';
const BRAND_VERSION = 1 as const;

/**
 * Non-boolean and unknown keys are dropped rather than coerced: a malformed
 * payload falls back to the shipped defaults instead of hiding a column the
 * user never hid.
 */
export function sanitizeExplorerColumnVisibility(persisted: unknown): ExplorerColumnVisibility {
  const source =
    typeof persisted === 'object' && persisted !== null
      ? (persisted as Record<string, unknown>)
      : {};
  const next = { ...DEFAULT_VISIBILITY };
  for (const columnId of EXPLORER_METADATA_COLUMN_IDS) {
    const candidate = source[columnId];
    if (typeof candidate === 'boolean') {
      next[columnId] = candidate;
    }
  }
  return next;
}

function createExplorerColumnVisibilityStore() {
  return create<ExplorerColumnVisibilityStoreState>()(
    persist(
      (set) => ({
        ...DEFAULT_VISIBILITY,
        reset: () => set({ ...DEFAULT_VISIBILITY }),
        setColumnVisible: (columnId, visible) => set({ [columnId]: visible }),
      }),
      {
        merge: createSanitizedPersistMerge<
          ExplorerColumnVisibilityStoreState,
          ExplorerColumnVisibility
        >(sanitizeExplorerColumnVisibility),
        migrate: (persisted) => sanitizeExplorerColumnVisibility(persisted),
        name: STORE_NAME,
        partialize: (state): ExplorerColumnVisibility => ({
          size: state.size,
          thread: state.thread,
          tokens: state.tokens,
          type: state.type,
        }),
        storage: createJSONStorage(createBrowserJsonStorage),
        version: STORE_VERSION,
      }
    )
  );
}

type BoundStore = ReturnType<typeof createExplorerColumnVisibilityStore>;

function isValidStore(candidate: unknown): candidate is BoundStore {
  if (!candidate || typeof candidate !== 'function') {
    return false;
  }
  const fn = candidate as { getState?: unknown; setState?: unknown; [BRAND]?: unknown };
  return (
    typeof fn.getState === 'function' &&
    typeof fn.setState === 'function' &&
    fn[BRAND] === BRAND_VERSION
  );
}

// `typeof globalThis` carries an implicit string index signature, so the
// registry view is a plain annotated assignment — no cast required.
const globalStoreRegistry: Record<string, unknown> = globalThis;
let singleton = globalStoreRegistry[GLOBAL_KEY] as unknown;
if (!isValidStore(singleton)) {
  singleton = createExplorerColumnVisibilityStore();
  (singleton as Record<string, unknown>)[BRAND] = BRAND_VERSION;
  globalStoreRegistry[GLOBAL_KEY] = singleton;
}

export const useExplorerColumnVisibilityStore = singleton as BoundStore;

/**
 * FACTORY RESET CONTRACT. `localStorage.clear()` drops the persisted slice but
 * not the LIVE singleton, and the web reset path does not force a reload — so
 * without this the grid kept whatever columns the user had hidden right through
 * a factory reset (whole-branch review F6).
 */
export function resetExplorerColumnVisibilityStoreToDefault(): void {
  useExplorerColumnVisibilityStore.getState().reset();
}
