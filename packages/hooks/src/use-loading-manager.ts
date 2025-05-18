import { useEffect, useState, useCallback } from 'react';

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
      setLoading((prev) => new Set(prev).add(key));
      try {
        await loadFn(key);
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [loadFn]
  );

  useEffect(() => {
    for (const key of keys) {
      if (!isLoaded(key)) {
        handleLoad(key);
      }
    }
  }, [keys, isLoaded, handleLoad]);

  return { loading };
}
