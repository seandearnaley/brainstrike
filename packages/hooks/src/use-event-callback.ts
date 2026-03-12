import { useCallback, useRef } from 'react';

/**
 * Returns a callback that always has access to the latest state and props,
 * without triggering effect dependency arrays.
 *
 * Intended for event handlers only.
 * Do not invoke this callback during render and do not use it to bypass effect dependencies.
 */
export function useEventCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  // Store latest callback in a ref so the stable wrapper always calls it.
  // Direct assignment during render is safe because the ref is only read
  // from event handlers, never during render itself.
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((...args: Parameters<T>) => callbackRef.current(...args), []) as T;
}
