import { countEstimatedTokens } from '@brainstrike/utils/token-counting-heuristics';
import { useCallback, useMemo } from 'react';
import { useOptionalTokenCacheContext } from './token-cache-context';

export type TokenCountingMode = 'accurate' | 'heuristic';
export type TokenCountingReason = null;

export interface TokenCountingState {
  /**
   * Counts tokens with the shared local estimator. Uses the worker-backed token
   * cache when available and computes directly otherwise.
   */
  countTokens: (content: string) => Promise<number>;
  loading: boolean;
  mode: TokenCountingMode;
  reason: TokenCountingReason;
}

export function useTokenCounting(): TokenCountingState {
  const tokenCache = useOptionalTokenCacheContext();
  const tokenCacheIsOperational = tokenCache?.isOperational === true;
  const countTextTokens = tokenCache?.countTextTokens;

  const mode: TokenCountingMode = 'heuristic';
  const reason: TokenCountingReason = null;
  const loading = false;

  const countTokens = useCallback(
    async (content: string) => {
      if (tokenCacheIsOperational && countTextTokens) {
        return countTextTokens(content);
      }

      return countEstimatedTokens(content);
    },
    [countTextTokens, tokenCacheIsOperational]
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
