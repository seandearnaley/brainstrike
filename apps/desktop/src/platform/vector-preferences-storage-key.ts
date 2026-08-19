/**
 * The canonical persisted-storage key for vector preferences, pinned in main so
 * the scoped `vector-preferences:*` capability never accepts a renderer-supplied
 * key (BST-1380).
 *
 * Deliberately duplicated rather than imported from `@brainstrike/app-state`:
 * main must not pull a renderer store module (and its zustand instantiation)
 * into the main bundle for a string. `vector-preferences-storage-key-contract.test.ts`
 * fails if this literal and the store's exported name ever drift.
 */
export const VECTOR_PREFERENCES_STORAGE_KEY = 'vector-preferences.v1' as const;
