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
  it('does not load already loaded keys', async () => {
    const stableLoadFn = vi.fn();
    const stableKeys = ['a', 'b'];
    const stableIsLoaded = vi.fn((k: string) => k === 'a');

    renderHook(({ keys, isLoaded, loadFn }) => useLoadingManager<string>(keys, isLoaded, loadFn), {
      initialProps: { keys: stableKeys, isLoaded: stableIsLoaded, loadFn: stableLoadFn },
    });

    await waitFor(() => {
      expect(stableLoadFn).toHaveBeenCalledTimes(1);
      expect(stableLoadFn).toHaveBeenCalledWith('b');
    });
    expect(stableIsLoaded).toHaveBeenCalledWith('a');
    expect(stableIsLoaded).toHaveBeenCalledWith('b');
  });

  it('tracks loading state until resolved', async () => {
    const def = deferred<void>();
    const stableLoadFn = vi.fn(() => def.promise);
    const stableKeys = ['key1'];
    const stableIsLoaded = vi.fn((_k: string) => false);

    const { result } = renderHook(
      ({ keys, isLoaded, loadFn }) => useLoadingManager<string>(keys, isLoaded, loadFn),
      {
        initialProps: { keys: stableKeys, isLoaded: stableIsLoaded, loadFn: stableLoadFn },
      }
    );

    await waitFor(() => expect(result.current.loading.has('key1')).toBe(true));
    expect(stableLoadFn).toHaveBeenCalledWith('key1');
    expect(stableIsLoaded).toHaveBeenCalledWith('key1');

    await act(async () => {
      def.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.loading.has('key1')).toBe(false));
  });

  it('handles empty keys', () => {
    const stableLoadFn = vi.fn();
    const stableKeys: number[] = [];
    const stableIsLoaded = vi.fn((_k: number) => false);

    const { result } = renderHook(
      ({ keys, isLoaded, loadFn }) => useLoadingManager<number>(keys, isLoaded, loadFn),
      {
        initialProps: { keys: stableKeys, isLoaded: stableIsLoaded, loadFn: stableLoadFn },
      }
    );
    expect(stableLoadFn).not.toHaveBeenCalled();
    expect(result.current.loading.size).toBe(0);
    expect(stableIsLoaded).not.toHaveBeenCalled();
  });
});
