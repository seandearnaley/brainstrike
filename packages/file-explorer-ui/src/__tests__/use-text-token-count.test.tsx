import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';

const tokenCacheMocks = vi.hoisted(() => ({
  useOptionalTokenCacheContext: vi.fn<() => TokenCacheContextValue | null>(),
}));

vi.mock('../indexing/token-cache-context', async () => {
  const actual = await vi.importActual<typeof import('../indexing/token-cache-context')>(
    '../indexing/token-cache-context'
  );

  return {
    ...actual,
    useOptionalTokenCacheContext: tokenCacheMocks.useOptionalTokenCacheContext,
  };
});

const { useTextTokenCount } = await import('../indexing/use-text-token-count');

describe('useTextTokenCount', () => {
  beforeEach(() => {
    tokenCacheMocks.useOptionalTokenCacheContext.mockReset();
  });

  it('waits for worker readiness before counting', async () => {
    let workerReady = false;
    const countTextTokens = vi.fn(async (input: string) => input.length);

    tokenCacheMocks.useOptionalTokenCacheContext.mockImplementation(
      () =>
        ({
          countingMode: 'accurate',
          countTextTokens,
          isWorkerReady: workerReady,
        }) as unknown as TokenCacheContextValue
    );

    const text = 'x'.repeat(40);
    const { result, rerender } = renderHook(
      (props: { text: string; enabled: boolean }) => useTextTokenCount(props),
      { initialProps: { enabled: true, text } }
    );

    await waitFor(() => expect(result.current.tokenCount).toBe(0));
    expect(result.current.loading).toBe(false);
    expect(countTextTokens).toHaveBeenCalledTimes(0);

    workerReady = true;
    rerender({ enabled: true, text });

    await waitFor(() => expect(result.current.tokenCount).toBe(40));
    expect(countTextTokens).toHaveBeenCalledTimes(1);
  });

  it('resets the token count when disabled', async () => {
    const countTextTokens = vi.fn(async () => 123);

    tokenCacheMocks.useOptionalTokenCacheContext.mockImplementation(
      () =>
        ({
          countingMode: 'accurate',
          countTextTokens,
          isWorkerReady: true,
        }) as unknown as TokenCacheContextValue
    );

    const { result, rerender } = renderHook(
      (props: { text: string; enabled: boolean }) => useTextTokenCount(props),
      { initialProps: { enabled: true, text: 'hello' } }
    );

    await waitFor(() => expect(result.current.tokenCount).toBe(123));
    rerender({ enabled: false, text: 'hello' });

    await waitFor(() => expect(result.current.tokenCount).toBe(0));
    expect(result.current.loading).toBe(false);
  });
});
