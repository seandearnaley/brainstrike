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
      initialProps: { isLoaded: stableIsLoaded, keys: stableKeys, loadFn: stableLoadFn },
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
        initialProps: { isLoaded: stableIsLoaded, keys: stableKeys, loadFn: stableLoadFn },
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
        initialProps: { isLoaded: stableIsLoaded, keys: stableKeys, loadFn: stableLoadFn },
      }
    );
    expect(stableLoadFn).not.toHaveBeenCalled();
    expect(result.current.loading.size).toBe(0);
    expect(stableIsLoaded).not.toHaveBeenCalled();
  });

  it('ignores duplicate keys while already loading', async () => {
    const def = deferred<void>();
    const stableLoadFn = vi.fn(() => def.promise);
    const stableIsLoaded = vi.fn(() => false);

    const { result, rerender } = renderHook(
      ({ keys }) => useLoadingManager<string>(keys, stableIsLoaded, stableLoadFn),
      {
        initialProps: { keys: ['dup'] },
      }
    );

    await waitFor(() => expect(result.current.loading.has('dup')).toBe(true));
    expect(stableLoadFn).toHaveBeenCalledTimes(1);

    rerender({ keys: ['dup', 'dup'] });

    await act(async () => {
      await Promise.resolve();
    });

    expect(stableLoadFn).toHaveBeenCalledTimes(1);
    expect(result.current.loading.size).toBe(1);

    await act(async () => {
      def.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.loading.size).toBe(0));
  });
});
