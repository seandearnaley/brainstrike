/**
 * The persisted-storage key for the assistant preferences store.
 *
 * Extracted into its own module to break a circular import: the store imports
 * runtime test-override helpers from `../settings-test-runtime-access`, and that
 * module needs this key to read persisted preferences. Importing the key from a
 * neutral third module (instead of from the store) keeps the dependency edge
 * one-directional. Surfaced by react-doctor `deslop/circular-dependency`.
 */
export const ASSISTANT_PREFERENCES_STORE_NAME = 'assistant-preferences.v1' as const;
