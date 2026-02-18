import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_MAX_CONCURRENT = 5;

/**
 * A generic hook to manage asynchronous loading state for a set of keys.
 * For each key in `keys` that is not yet loaded (`isLoaded` returns false),
 * `loadFn` is invoked. While loading, the key is tracked in the `loading` set.
 * At most `maxConcurrent` loads will run simultaneously.
 *
 * @template K Type of the keys
 * @param keys An iterable of keys to manage loading for
 * @param isLoaded Function to determine if a key is already loaded
 * @param loadFn Async function that loads the given key
 * @param maxConcurrent Maximum number of concurrent loads (default: 5)
 * @returns An object containing `loading`, the set of keys currently loading
 */
export function useLoadingManager<K>(
  keys: Iterable<K>,
  isLoaded: (key: K) => boolean,
  loadFn: (key: K) => Promise<void>,
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT
): { loading: ReadonlySet<K> } {
  const [loading, setLoading] = useState<Set<K>>(new Set());
  const shouldInitiateLoadRef = useRef(false);
  const activeCountRef = useRef(0);
  const queueRef = useRef<K[]>([]);

  const processQueue = useCallback(() => {
    while (queueRef.current.length > 0 && activeCountRef.current < maxConcurrent) {
      const key = queueRef.current.shift();
      if (key === undefined) {
        break;
      }

      shouldInitiateLoadRef.current = false;
      setLoading((prevLoading) => {
        if (prevLoading.has(key)) {
          return prevLoading;
        }
        shouldInitiateLoadRef.current = true;
        const newLoading = new Set(prevLoading);
        newLoading.add(key);
        return newLoading;
      });

      if (!shouldInitiateLoadRef.current) {
        continue;
      }

      activeCountRef.current += 1;

      void Promise.resolve(loadFn(key)).finally(() => {
        activeCountRef.current -= 1;
        setLoading((prevLoading) => {
          const newLoading = new Set(prevLoading);
          newLoading.delete(key);
          return newLoading;
        });
        processQueue();
      });
    }
  }, [loadFn, maxConcurrent]);

  // biome-ignore lint/plugin: Trigger loading for unloaded keys - reactive data loading
  useEffect(() => {
    const pending: K[] = [];
    for (const key of keys) {
      if (!isLoaded(key)) {
        pending.push(key);
      }
    }

    if (pending.length > 0) {
      queueRef.current = pending;
      processQueue();
    }
  }, [keys, isLoaded, processQueue]);

  return { loading };
}
