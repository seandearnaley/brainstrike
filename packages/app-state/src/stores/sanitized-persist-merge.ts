/**
 * Creates a Zustand persist `merge` function that sanitizes every hydrated
 * payload, including payloads whose version already matches the current store.
 *
 * The sanitizer must return the complete persisted-data shape, not a sparse
 * patch. Merging it over the current store preserves live actions while
 * preventing persisted action-shaped or unknown keys from entering the store.
 */
export function createSanitizedPersistMerge<
  TStore extends object,
  TPersistedData extends Partial<TStore>,
>(
  sanitize: (persistedState: unknown) => TPersistedData
): (persistedState: unknown, currentState: TStore) => TStore {
  return (persistedState, currentState) => {
    if (persistedState === undefined) {
      return currentState;
    }

    return {
      ...currentState,
      ...sanitize(persistedState),
    };
  };
}
