import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// Avoid React warnings during SSR: useLayoutEffect fires a warning when
// executed on the server.  Fall back to useEffect in non-browser environments.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Returns a stable-identity callback that always invokes the latest version of
 * the provided function, without invalidating effect or memo dependency arrays.
 *
 * Implementation: stores the callback in a ref, updates the ref via
 * `useIsomorphicLayoutEffect` (commit-phase, SSR-safe), and returns a
 * memoised wrapper with a fixed identity (`useCallback(…, [])`).
 *
 * Intended for event handlers only.
 * Do not invoke this callback during render and do not use it to bypass effect
 * dependencies.
 */
export function useEventCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  // Writing to the ref during render is intentional for this pattern.
  // The ref is only *read* from event handlers (which execute after commit),
  // so even if React re-invokes the render function in concurrent mode the
  // final committed value will be correct.  This is a well-known technique
  // used by usehooks-ts, SWR, and similar libraries.
  const callbackRef = useRef(callback);

  // Update the ref in a layout effect (commit phase) so it is always current
  // before any event handlers fire.  useIsomorphicLayoutEffect falls back to
  // useEffect on the server to avoid SSR warnings.
  //
  // The dependency array is intentionally omitted: the effect runs after every
  // render, guaranteeing the ref is fresh regardless of whether the callback's
  // identity changed.  The cost is a single ref assignment per render, which is
  // negligible compared to the alternative of a stale ref if callback identity
  // is unstable.
  useIsomorphicLayoutEffect(() => {
    callbackRef.current = callback;
  });

  // Stable identity: the empty dependency array is intentional — the returned
  // function never changes, and always delegates to the latest callback via ref.
  //
  // The `as T` cast is standard practice for this pattern: useCallback infers
  // `(...args: Parameters<T>) => ReturnType<T>` which is not structurally
  // identical to T (T could carry extra properties or a `this` type).  For an
  // internal hook scoped to plain event handlers this is safe.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((...args: Parameters<T>) => callbackRef.current(...args), []) as T;
}
