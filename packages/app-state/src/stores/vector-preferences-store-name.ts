/**
 * The persisted-storage key for the vector preferences store.
 *
 * Extracted into its own module so capability owners outside the store can pin
 * the canonical key without importing the store itself. Desktop main pins the
 * same literal for the scoped `vector-preferences:*` IPC capability (BST-1380);
 * `vector-preferences-storage-key-contract.test.ts` fails if the two drift.
 */
export const VECTOR_PREFERENCES_STORE_NAME = 'vector-preferences.v1' as const;
