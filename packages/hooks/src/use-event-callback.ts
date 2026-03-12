import { useEffectEvent } from 'react';

/**
 * Returns a callback that always has access to the latest state and props,
 * without triggering effect dependency arrays.
 *
 * - Safe for SSR: falls back to `useEffect` when `window` is unavailable.
 * - Safe for concurrent rendering: callback ref updates happen in an effect,
 *   never during render.
 *
 * Intended for event handlers only.
 * Do not invoke this callback during render and do not use it to bypass effect dependencies.
 */
export function useEventCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  return useEffectEvent(callback);
}
