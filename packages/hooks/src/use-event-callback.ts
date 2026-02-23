import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Returns a stable callback identity that always invokes the latest callback.
 *
 * - Safe for SSR: falls back to `useEffect` when `window` is unavailable.
 * - Safe for concurrent rendering: callback ref updates happen in an effect,
 *   never during render.
 *
 * Intended for event handlers only.
 * Do not invoke this callback during render and do not use it to bypass effect dependencies.
 *
 * TODO(BST-320): Replace with React's native `useEffectEvent` once adopted.
 */
export function useEventCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  const callbackRef = useRef(callback);

  useIsomorphicLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback((...args: TArgs) => callbackRef.current(...args), []);
}
