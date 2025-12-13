import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCacheContextValue } from '../token-cache-context';

const tokenCacheMocks = vi.hoisted(() => ({
  useOptionalTokenCacheContext: vi.fn<() => TokenCacheContextValue | null>(),
}));

vi.mock('../token-cache-context', async () => {
  const actual =
    await vi.importActual<typeof import('../token-cache-context')>('../token-cache-context');

  return {
    ...actual,
    useOptionalTokenCacheContext: tokenCacheMocks.useOptionalTokenCacheContext,
  };
});

const { useTextTokenCount } = await import('../hooks/use-text-token-count');

describe('useTextTokenCount', () => {
  beforeEach(() => {
    tokenCacheMocks.useOptionalTokenCacheContext.mockReset();
  });

  it('counts using heuristic fallback until the worker is ready, then re-counts', async () => {
    let workerReady = false;
    const countTextTokens = vi.fn(async (input: string) =>
      workerReady ? input.length : Math.ceil(input.length / 4)
    );

    tokenCacheMocks.useOptionalTokenCacheContext.mockImplementation(
      () =>
        ({
          countTextTokens,
          countingMode: 'accurate',
          isWorkerReady: workerReady,
        }) as unknown as TokenCacheContextValue
    );

    const text = 'x'.repeat(40);
    const { result, rerender } = renderHook(
      (props: { text: string; enabled: boolean }) => useTextTokenCount(props),
      { initialProps: { text, enabled: true } }
    );

    await waitFor(() => expect(result.current.tokenCount).toBe(10));
    expect(result.current.loading).toBe(false);
    expect(countTextTokens).toHaveBeenCalledTimes(1);

    workerReady = true;
    rerender({ text, enabled: true });

    await waitFor(() => expect(result.current.tokenCount).toBe(40));
    expect(countTextTokens).toHaveBeenCalledTimes(2);
  });

  it('resets the token count when disabled', async () => {
    const countTextTokens = vi.fn(async () => 123);

    tokenCacheMocks.useOptionalTokenCacheContext.mockImplementation(
      () =>
        ({
          countTextTokens,
          countingMode: 'accurate',
          isWorkerReady: true,
        }) as unknown as TokenCacheContextValue
    );

    const { result, rerender } = renderHook(
      (props: { text: string; enabled: boolean }) => useTextTokenCount(props),
      { initialProps: { text: 'hello', enabled: true } }
    );

    await waitFor(() => expect(result.current.tokenCount).toBe(123));
    rerender({ text: 'hello', enabled: false });

    await waitFor(() => expect(result.current.tokenCount).toBe(0));
    expect(result.current.loading).toBe(false);
  });
});
