import {
  __resetTokenPreferencesStoreForTests,
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '@brainstrike/preferences/stores/token-preferences-store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import {
  __resetTokenCountingRuntimeCacheForTests,
  useTokenCounting,
} from '../indexing/use-token-counting';

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

function createTokenCacheContextValue(
  overrides: Partial<TokenCacheContextValue>
): TokenCacheContextValue {
  return {
    cacheVersion: 0,
    clearHotCache: () => {},
    getFileSize: () => undefined,
    getTokenCount: () => null,
    getTotalTokens: async () => 0,
    invalidate: () => {},
    isAnyLoading: false,
    isLoading: () => false,
    preloadFolder: async () => {},
    queueForCounting: () => {},
    updateFileSizeCache: () => {},
    updateHotCache: () => {},
    isReady: true,
    isOperational: true,
    isPersisted: true,
    persistenceMode: 'persistent',
    isWorkerReady: true,
    countingMode: 'accurate',
    countTextTokens: async () => 0,
    store: {} as TokenCacheContextValue['store'],
    ...overrides,
  };
}

describe('useTokenCounting', () => {
  beforeEach(() => {
    __resetTokenPreferencesStoreForTests();
    __resetTokenCountingRuntimeCacheForTests();
    vi.clearAllMocks();
    tokenCacheMocks.useOptionalTokenCacheContext.mockReset();
    tokenCacheMocks.useOptionalTokenCacheContext.mockReturnValue(null);
  });

  it('uses the token cache worker when estimator counting is operational', async () => {
    const countTextTokens = vi.fn(async () => 42);
    tokenCacheMocks.useOptionalTokenCacheContext.mockReturnValue(
      createTokenCacheContextValue({
        isOperational: true,
        countingMode: 'heuristic',
        countTextTokens,
      })
    );

    const { result } = renderHook(() => useTokenCounting());

    expect(result.current.loading).toBe(false);
    expect(result.current.mode).toBe('heuristic');
    expect(result.current.reason).toBeNull();

    await expect(result.current.countTokens('hello')).resolves.toBe(42);
    expect(countTextTokens).toHaveBeenCalledWith('hello');
  });

  it('keeps estimator mode when the legacy accurate preference is disabled', async () => {
    const countTextTokens = vi.fn(async () => 123);
    tokenCacheMocks.useOptionalTokenCacheContext.mockReturnValue(
      createTokenCacheContextValue({
        isOperational: true,
        countingMode: 'heuristic',
        countTextTokens,
      })
    );

    const { result } = renderHook(() => useTokenCounting());

    act(() => {
      useTokenPreferencesStore.getState().setAccurateCounting(false);
    });

    await waitFor(() => {
      expect(result.current.mode).toBe('heuristic');
      expect(result.current.reason).toBeNull();
    });

    await expect(result.current.countTokens('abcde')).resolves.toBe(123);
    expect(countTextTokens).toHaveBeenCalledWith('abcde');
    expect(tokenPreferencesSelectors.accurateCounting(useTokenPreferencesStore.getState())).toBe(
      false
    );
  });

  it('uses the local estimator when the token cache worker is unavailable', async () => {
    tokenCacheMocks.useOptionalTokenCacheContext.mockReturnValue(
      createTokenCacheContextValue({
        isOperational: false,
        countingMode: 'heuristic',
        countTextTokens: vi.fn(async () => 99),
      })
    );

    const { result } = renderHook(() => useTokenCounting());

    await waitFor(() => expect(result.current.mode).toBe('heuristic'));
    expect(result.current.reason).toBeNull();
    await expect(result.current.countTokens('abcde')).resolves.toBe(1);
  });

  it('uses the local estimator when no token cache provider is present', async () => {
    const { result } = renderHook(() => useTokenCounting());

    expect(result.current.loading).toBe(false);
    expect(result.current.mode).toBe('heuristic');
    expect(result.current.reason).toBeNull();
    await expect(result.current.countTokens('abcde')).resolves.toBe(1);
  });
});
