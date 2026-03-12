import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Returns a callback that always has access to the latest state and props,
 * without triggering effect dependency arrays.
 *
 * Intended for event handlers only.
 * Do not invoke this callback during render and do not use it to bypass effect dependencies.
 */
export function useEventCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);

  // Update ref in useLayoutEffect (commit phase) rather than during render
  // to comply with React concurrent-mode rules. useLayoutEffect fires
  // synchronously after DOM mutations but before paint, so the ref is
  // always up-to-date before any event handlers can fire.
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });

  // Cast required: useCallback returns (...args) => ReturnType<T>, not T itself.
  // This is standard for callback-wrapping hooks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((...args: Parameters<T>) => callbackRef.current(...args), []) as T;
}
