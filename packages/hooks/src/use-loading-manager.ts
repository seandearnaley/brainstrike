import { useCallback, useEffect, useState } from 'react';

/**
 * A generic hook to manage asynchronous loading state for a set of keys.
 * For each key in `keys` that is not yet loaded (`isLoaded` returns false),
 * `loadFn` is invoked. While loading, the key is tracked in the `loading` set.
 *
 * @template K Type of the keys
 * @param keys An iterable of keys to manage loading for
 * @param isLoaded Function to determine if a key is already loaded
 * @param loadFn Async function that loads the given key
 * @returns An object containing `loading`, the set of keys currently loading
 */
export function useLoadingManager<K>(
  keys: Iterable<K>,
  isLoaded: (key: K) => boolean,
  loadFn: (key: K) => Promise<void>
): { loading: Set<K> } {
  const [loading, setLoading] = useState<Set<K>>(new Set());

  const handleLoad = useCallback(
    async (key: K) => {
      let shouldInitiateLoad = false;
      setLoading((prevLoading) => {
        if (prevLoading.has(key)) {
          // Already loading or load initiated in a concurrent call, no state change needed.
          return prevLoading;
        }
        shouldInitiateLoad = true;
        const newLoading = new Set(prevLoading);
        newLoading.add(key);
        return newLoading;
      });

      if (!shouldInitiateLoad) {
        // If the key was already in the loading set, don't re-execute loadFn.
        return;
      }

      try {
        await loadFn(key);
      } finally {
        setLoading((prevLoading) => {
          const newLoading = new Set(prevLoading);
          newLoading.delete(key);
          return newLoading;
        });
      }
    },
    [loadFn] // setLoading is stable and not needed as a dep for useCallback
  );

  useEffect(() => {
    for (const key of keys) {
      // The guard against re-initiating an already active load is now within handleLoad.
      if (!isLoaded(key)) {
        handleLoad(key);
      }
    }
    // Dependencies: keys, isLoaded, and handleLoad (which depends on loadFn).
    // `loading` state is managed internally by handleLoad and doesn't need to be a dependency here
    // to trigger the initiation of loads.
  }, [keys, isLoaded, handleLoad]);

  return { loading };
}
