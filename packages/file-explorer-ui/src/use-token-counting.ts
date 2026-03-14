import {
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '@brainstrike/preferences/stores/token-preferences-store';
import { countTokensHeuristic } from '@brainstrike/text-splitter';
import { useCallback, useMemo } from 'react';
import { useOptionalTokenCacheContext } from './token-cache-context';

export type TokenCountingMode = 'accurate' | 'heuristic';
export type TokenCountingReason = 'preference-disabled' | 'runtime-unavailable' | null;

export interface TokenCountingState {
  /**
   * Counts tokens using the currently selected mode.
   *
   * When accurate counting is preferred, this rejects if the tiktoken runtime
   * is unavailable. Callers are expected to guard with `loading` / `reason` or
   * catch the rejection explicitly rather than silently falling back.
   *
   * @throws {Error} When accurate mode is preferred but the tiktoken runtime is
   * unavailable.
   */
  countTokens: (content: string) => Promise<number>;
  loading: boolean;
  mode: TokenCountingMode;
  reason: TokenCountingReason;
}

export function useTokenCounting(): TokenCountingState {
  const accuratePreference = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const tokenCache = useOptionalTokenCacheContext();
  const tokenCacheIsOperational = tokenCache?.isOperational === true;
  const tokenCacheCountingMode = tokenCache?.countingMode;
  const countTextTokens = tokenCache?.countTextTokens;
  const hasAccurateRuntime =
    accuratePreference && tokenCacheIsOperational && tokenCacheCountingMode === 'accurate';

  const mode: TokenCountingMode = accuratePreference ? 'accurate' : 'heuristic';
  const reason: TokenCountingReason = accuratePreference
    ? hasAccurateRuntime
      ? null
      : 'runtime-unavailable'
    : 'preference-disabled';
  const loading = accuratePreference && tokenCache !== null && tokenCacheIsOperational === false;

  const countTokens = useCallback(
    async (content: string) => {
      if (!accuratePreference) {
        return countTokensHeuristic(content);
      }

      if (tokenCacheIsOperational && tokenCacheCountingMode === 'accurate' && countTextTokens) {
        return countTextTokens(content);
      }

      throw new Error(
        'Accurate token counting is unavailable: tiktoken worker is not operational and heuristic mode was not explicitly selected.'
      );
    },
    [accuratePreference, countTextTokens, tokenCacheCountingMode, tokenCacheIsOperational]
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

/**
 * @deprecated Token counting state now lives in context, not module caches.
 * Kept only as a stable import for older tests until those call sites are removed.
 */
export function __resetTokenCountingRuntimeCacheForTests() {
  // No-op: token counting state now lives in the token cache context rather
  // than module-level runtime caches, but the test helper remains as a stable
  // import for existing tests.
}
