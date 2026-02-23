import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Ref-backed callback wrapper for event handlers that need stable identity.
 * Ref writes are committed in a layout effect to avoid render-time ref mutation
 * hazards under concurrent rendering.
 * Do not invoke the returned callback during render.
 * Do not use this as an effect dependency shortcut.
 * TODO(BST-312): Replace with React's stable useEffectEvent once adopted in this codebase.
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
