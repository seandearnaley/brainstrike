import {
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '@brainstrike/preferences/stores/token-preferences-store';
import { useCallback, useMemo } from 'react';
import { useOptionalTokenCacheContext } from './token-cache-context';

export type TokenCountingMode = 'accurate' | 'heuristic';
export type TokenCountingReason = 'preference-disabled' | 'runtime-unavailable' | null;

export interface TokenCountingState {
  countTokens: (content: string) => Promise<number>;
  loading: boolean;
  mode: TokenCountingMode;
  reason: TokenCountingReason;
}

export function useTokenCounting(): TokenCountingState {
  const accuratePreference = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const tokenCache = useOptionalTokenCacheContext();
  const hasAccurateRuntime =
    accuratePreference &&
    tokenCache?.isOperational === true &&
    tokenCache.countingMode === 'accurate';

  const mode: TokenCountingMode = accuratePreference ? 'accurate' : 'heuristic';
  const reason: TokenCountingReason = accuratePreference
    ? hasAccurateRuntime
      ? null
      : 'runtime-unavailable'
    : 'preference-disabled';
  const loading = accuratePreference && tokenCache !== null && tokenCache.isOperational === false;

  const countTokens = useCallback(
    async (content: string) => {
      if (!accuratePreference) {
        return Math.ceil(content.length / 4);
      }

      if (tokenCache?.isOperational && tokenCache.countingMode === 'accurate') {
        return tokenCache.countTextTokens(content);
      }

      throw new Error(
        'Accurate token counting is unavailable: tiktoken worker is not operational and heuristic mode was not explicitly selected.'
      );
    },
    [accuratePreference, tokenCache]
  );

  return useMemo(
    () => ({
      mode,
      reason,
      loading,
      countTokens,
    }),
    [mode, reason, loading, countTokens]
  );
}

export function __resetTokenCountingRuntimeCacheForTests() {}
