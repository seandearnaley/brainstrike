import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useLoadingManager } from '../use-loading-manager';

function deferred<T>() {
  let resolveFn!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

describe('useLoadingManager', () => {
  it('does not load already loaded keys', () => {
    const loadFn = vi.fn();
    renderHook(() => useLoadingManager<string>(['a', 'b'], (k) => k === 'a', loadFn));
    expect(loadFn).toHaveBeenCalledTimes(1);
    expect(loadFn).toHaveBeenCalledWith('b');
  });

  it('tracks loading state until resolved', async () => {
    const def = deferred<void>();
    const loadFn = vi.fn(() => def.promise);
    const { result } = renderHook(() => useLoadingManager<string>(['key1'], () => false, loadFn));

    // Initially loading contains 'key1'
    expect(loadFn).toHaveBeenCalledWith('key1');
    expect(result.current.loading.has('key1')).toBe(true);

    // Resolve the promise
    act(() => {
      def.resolve();
    });

    // Wait for key to be removed from loading set
    await waitFor(() => expect(result.current.loading.has('key1')).toBe(false));
  });

  it('handles empty keys', () => {
    const loadFn = vi.fn();
    const { result } = renderHook(() => useLoadingManager<number>([], () => false, loadFn));
    expect(loadFn).not.toHaveBeenCalled();
    expect(result.current.loading.size).toBe(0);
  });
});
