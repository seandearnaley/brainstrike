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
 */
import { persistDurable } from '@brainstrike/storage';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge.ts';

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

const STORE_NAME = 'brainstrike:explorer-column-visibility.v1' as const;
const STORE_VERSION = 1 as const;

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

export const useExplorerColumnVisibilityStore = create<ExplorerColumnVisibilityStoreState>()(
  persistDurable(
    STORE_NAME,
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
      partialize: (state): ExplorerColumnVisibility => ({
        size: state.size,
        thread: state.thread,
        tokens: state.tokens,
        type: state.type,
      }),
      version: STORE_VERSION,
    }
  )
);
