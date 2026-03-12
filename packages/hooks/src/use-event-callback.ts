import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// Avoid React warnings during SSR: useLayoutEffect fires a warning when
// executed on the server.  Fall back to useEffect in non-browser environments.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Returns a callback that always has access to the latest state and props,
 * without triggering effect dependency arrays.
 *
 * Intended for event handlers only.
 * Do not invoke this callback during render and do not use it to bypass effect dependencies.
 */
export function useEventCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);

  // Update ref in a layout effect (commit phase) rather than during render
  // to comply with React concurrent-mode rules. In the browser this fires
  // synchronously after DOM mutations but before paint, so the ref is
  // always up-to-date before any event handlers can fire.
  useIsomorphicLayoutEffect(() => {
    callbackRef.current = callback;
  });

  // Stable identity: the empty dependency array is intentional — the returned
  // function never changes, and always delegates to the latest callback via ref.
  // Cast required: useCallback returns (...args) => ReturnType<T>, not T itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((...args: Parameters<T>) => callbackRef.current(...args), []) as T;
}
