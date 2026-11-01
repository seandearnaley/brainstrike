/**
 * Persisted global sort preference for the Explorer tree grid (BST-1209).
 *
 * One singleton is shared by single-root and forest layouts, so every section
 * projects the same sibling order. `null` preserves the loader's default
 * directories-first, name-ascending order.
 */
import { persistDurable } from '@brainstrike/storage';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge.ts';

export const EXPLORER_SORT_FIELDS = ['name', 'type', 'tokens', 'size'] as const;

export type ExplorerSortField = (typeof EXPLORER_SORT_FIELDS)[number];
export type ExplorerSortDirection = 'asc' | 'desc';

export interface ExplorerSortState {
  direction: ExplorerSortDirection;
  field: ExplorerSortField;
}

interface PersistedExplorerSortState {
  sortState: ExplorerSortState | null;
}

export interface ExplorerSortStateStoreState extends PersistedExplorerSortState {
  reset: () => void;
  setSortState: (sortState: ExplorerSortState | null) => void;
}

const DEFAULT_SORT_STATE = null;
const STORE_NAME = 'brainstrike:explorer-sort-state.v1' as const;
const STORE_VERSION = 1 as const;

export function isExplorerSortField(value: unknown): value is ExplorerSortField {
  return typeof value === 'string' && EXPLORER_SORT_FIELDS.includes(value as ExplorerSortField);
}

/**
 * Fields whose ordering can only come from the file-row metadata seam. `name`
 * is the exception: it orders from the tree node alone, so it works on every
 * surface. Surfaces without the seam must not OFFER the rest — capability
 * gating is the repo rule — and a persisted one there resets to default order.
 */
export function isExplorerMetadataSortField(field: ExplorerSortField): boolean {
  return field !== 'name';
}

function parseSortState(value: unknown): ExplorerSortState | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('Malformed Explorer sort state: expected an object or null');
  }
  const candidate = value as Record<string, unknown>;
  if (!isExplorerSortField(candidate['field'])) {
    throw new Error(`Malformed Explorer sort field: ${String(candidate['field'])}`);
  }
  if (candidate['direction'] !== 'asc' && candidate['direction'] !== 'desc') {
    throw new Error(`Malformed Explorer sort direction: ${String(candidate['direction'])}`);
  }
  return { direction: candidate['direction'], field: candidate['field'] };
}

/** Validate hydrated data loudly; malformed persisted ordering never degrades silently. */
export function sanitizeExplorerSortState(persisted: unknown): PersistedExplorerSortState {
  if (typeof persisted !== 'object' || persisted === null) {
    throw new Error('Malformed persisted Explorer sort state: expected an object');
  }
  const candidate = persisted as Record<string, unknown>;
  return { sortState: parseSortState(candidate['sortState']) };
}

export const useExplorerSortStateStore = create<ExplorerSortStateStoreState>()(
  persistDurable(
    STORE_NAME,
    (set) => ({
      reset: () => set({ sortState: DEFAULT_SORT_STATE }),
      setSortState: (sortState) => set({ sortState: parseSortState(sortState) }),
      sortState: DEFAULT_SORT_STATE,
    }),
    {
      merge: createSanitizedPersistMerge<ExplorerSortStateStoreState, PersistedExplorerSortState>(
        sanitizeExplorerSortState
      ),
      migrate: (persisted) => sanitizeExplorerSortState(persisted),
      partialize: (state): PersistedExplorerSortState => ({ sortState: state.sortState }),
      version: STORE_VERSION,
    }
  )
);
