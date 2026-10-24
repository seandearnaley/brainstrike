/**
 * The persisted-storage schema version for the assistant preferences store.
 *
 * Extracted into its own module for the same reason as
 * `assistant-preferences-store-name.ts`: it lets consumers that only need the
 * version number (e.g. e2e test helpers) avoid importing the full store
 * module, which pulls in `@brainstrike/logging` and its `createLogger()`
 * side-effect call at module-eval time.
 */
export const ASSISTANT_PREFERENCES_STORE_VERSION = 11;
