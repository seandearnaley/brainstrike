import {
  __resetTokenPreferencesStoreForTests,
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '@brainstrike/preferences';
import {
  countTokensAccurate,
  countTokensHeuristic,
  supportsAccurateTokenCounting,
} from '@brainstrike/utils';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetTokenCountingRuntimeCacheForTests, useTokenCounting } from '../use-token-counting';

vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    supportsAccurateTokenCounting: vi.fn(),
    countTokensAccurate: vi.fn(),
    countTokensHeuristic: vi.fn(),
  };
});

const mockedSupports = vi.mocked(supportsAccurateTokenCounting);
const mockedAccurate = vi.mocked(countTokensAccurate);
const mockedHeuristic = vi.mocked(countTokensHeuristic);

describe('useTokenCounting', () => {
  beforeEach(() => {
    __resetTokenPreferencesStoreForTests();
    __resetTokenCountingRuntimeCacheForTests();
    vi.clearAllMocks();
    mockedHeuristic.mockImplementation((text: string) => text.length);
    mockedAccurate.mockResolvedValue(0);
  });

  it('resolves to accurate mode when runtime supports WASM tokenizer', async () => {
    mockedSupports.mockResolvedValue(true);
    mockedAccurate.mockResolvedValue(42);

    const { result } = renderHook(() => useTokenCounting());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.mode).toBe('accurate');
      expect(result.current.reason).toBeNull();
    });

    await expect(result.current.countTokens('hello')).resolves.toBe(42);
    expect(mockedAccurate).toHaveBeenCalledWith('hello');
  });

  it('falls back to heuristic mode when preference is disabled', async () => {
    mockedSupports.mockResolvedValue(true);
    mockedHeuristic.mockImplementation((text: string) => text.length * 2);

    const { result } = renderHook(() => useTokenCounting());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      useTokenPreferencesStore.getState().setAccurateCounting(false);
    });

    await waitFor(() => {
      expect(result.current.mode).toBe('heuristic');
      expect(result.current.reason).toBe('preference-disabled');
    });

    await expect(result.current.countTokens('abc')).resolves.toBe(6);
    expect(mockedHeuristic).toHaveBeenCalledWith('abc');
    expect(tokenPreferencesSelectors.accurateCounting(useTokenPreferencesStore.getState())).toBe(
      false
    );
  });

  it('reports runtime fallback when WASM tokenizer is unavailable', async () => {
    mockedSupports.mockResolvedValue(false);

    const { result } = renderHook(() => useTokenCounting());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.mode).toBe('heuristic');
      expect(result.current.reason).toBe('runtime-fallback');
    });
  });
});
