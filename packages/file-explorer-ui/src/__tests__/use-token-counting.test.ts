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
    countingMode: 'accurate',
    countTextTokens: async () => 0,
    getFileSize: () => undefined,
    getTokenCount: () => null,
    getTotalTokens: async () => 0,
    invalidate: () => {},
    isAnyLoading: false,
    isLoading: () => false,
    isOperational: true,
    isPersisted: true,
    isReady: true,
    isWorkerReady: true,
    persistenceMode: 'persistent',
    preloadFolder: async () => {},
    queueForCounting: () => {},
    store: {} as TokenCacheContextValue['store'],
    updateFileSizeCache: () => {},
    updateHotCache: () => {},
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

  it('uses the token cache worker when accurate counting is operational', async () => {
    const countTextTokens = vi.fn(async () => 42);
    tokenCacheMocks.useOptionalTokenCacheContext.mockReturnValue(
      createTokenCacheContextValue({
        countingMode: 'accurate',
        countTextTokens,
        isOperational: true,
      })
    );

    const { result } = renderHook(() => useTokenCounting());

    expect(result.current.loading).toBe(false);
    expect(result.current.mode).toBe('accurate');
    expect(result.current.reason).toBeNull();

    await expect(result.current.countTokens('hello')).resolves.toBe(42);
    expect(countTextTokens).toHaveBeenCalledWith('hello');
  });

  it('falls back to heuristic mode when preference is disabled', async () => {
    const countTextTokens = vi.fn(async () => 123);
    tokenCacheMocks.useOptionalTokenCacheContext.mockReturnValue(
      createTokenCacheContextValue({
        countingMode: 'accurate',
        countTextTokens,
        isOperational: true,
      })
    );

    const { result } = renderHook(() => useTokenCounting());

    act(() => {
      useTokenPreferencesStore.getState().setAccurateCounting(false);
    });

    await waitFor(() => {
      expect(result.current.mode).toBe('heuristic');
      expect(result.current.reason).toBe('preference-disabled');
    });

    await expect(result.current.countTokens('abcde')).resolves.toBe(2);
    expect(countTextTokens).not.toHaveBeenCalled();
    expect(tokenPreferencesSelectors.accurateCounting(useTokenPreferencesStore.getState())).toBe(
      false
    );
  });

  it('reports runtime unavailability when the token cache worker is unavailable', async () => {
    tokenCacheMocks.useOptionalTokenCacheContext.mockReturnValue(
      createTokenCacheContextValue({
        countingMode: 'accurate',
        countTextTokens: vi.fn(async () => 99),
        isOperational: false,
      })
    );

    const { result } = renderHook(() => useTokenCounting());

    await waitFor(() => expect(result.current.mode).toBe('accurate'));
    expect(result.current.reason).toBe('runtime-unavailable');
    await expect(result.current.countTokens('abcd')).rejects.toThrow(
      'Accurate token counting is unavailable'
    );
  });

  it('fails fast when no token cache provider is present and accurate mode is enabled', async () => {
    const { result } = renderHook(() => useTokenCounting());

    expect(result.current.loading).toBe(false);
    expect(result.current.mode).toBe('accurate');
    expect(result.current.reason).toBe('runtime-unavailable');
    await expect(result.current.countTokens('abcd')).rejects.toThrow(
      'Accurate token counting is unavailable'
    );
  });
});
