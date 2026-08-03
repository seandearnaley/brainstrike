/**
 * Typed access to zustand's `persist` middleware API.
 *
 * `persist` registers a store mutator, so a store built with
 * `create<T>()(persist(...))` already carries a fully typed `persist` object —
 * `clearStorage` included, and non-optional. The `__reset*ForTests` helpers in
 * this package used to reach for it through
 * `useSomeStore as unknown as { persist?: { clearStorage?: () => void } }`,
 * which erased zustand's own types and made a guaranteed API look optional.
 *
 * Depending on the structural shape below instead means a store that ever loses
 * its `persist` middleware fails to compile at the call site rather than
 * silently no-opping at runtime.
 */

/** The slice of zustand's persist API the reset helpers need. */
export interface StoreWithPersistApi {
  persist: {
    clearStorage: () => void;
  };
}

/**
 * Drop a persisted store's serialized state.
 *
 * Test-only: the callers are the `__reset*ForTests` helpers. A storage failure
 * is swallowed because `localStorage` may be unavailable (jsdom, SSR) and the
 * in-memory reset the caller performs is what the suite actually depends on.
 * Deliberately not a production path — nothing outside a test reset should
 * discard a user's persisted preferences.
 */
export function clearPersistedStorageForTests(store: StoreWithPersistApi): void {
  try {
    store.persist.clearStorage();
  } catch {
    // Storage unavailable — the caller's in-memory reset still stands.
  }
}
