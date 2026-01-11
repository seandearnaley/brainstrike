import { tokenPreferencesSelectors, useTokenPreferencesStore } from '@brainstrike/preferences';
import {
  countTokensAccurate,
  countTokensHeuristic,
  supportsAccurateTokenCounting,
} from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type TokenCountingMode = 'accurate' | 'heuristic';
export type TokenCountingReason = 'preference-disabled' | 'runtime-fallback' | null;

export interface TokenCountingState {
  mode: TokenCountingMode;
  reason: TokenCountingReason;
  loading: boolean;
  countTokens: (content: string) => Promise<number>;
}

let runtimeSupportPromise: Promise<boolean> | null = null;

async function resolveRuntimeSupport(): Promise<boolean> {
  if (!runtimeSupportPromise) {
    runtimeSupportPromise = supportsAccurateTokenCounting();
  }
  return runtimeSupportPromise;
}

export function useTokenCounting(): TokenCountingState {
  const accuratePreference = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const [mode, setMode] = useState<TokenCountingMode>('heuristic');
  const [reason, setReason] = useState<TokenCountingReason>('preference-disabled');
  const [loading, setLoading] = useState<boolean>(accuratePreference);

  // biome-ignore lint/plugin: Initialize token counting mode based on preference - async initialization
  useEffect(() => {
    let cancelled = false;

    if (!accuratePreference) {
      setMode('heuristic');
      setReason('preference-disabled');
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setReason(null);

    resolveRuntimeSupport()
      .then((supported) => {
        if (cancelled) {
          return;
        }
        if (supported) {
          setMode('accurate');
          setReason(null);
        } else {
          setMode('heuristic');
          setReason('runtime-fallback');
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setMode('heuristic');
          setReason('runtime-fallback');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accuratePreference]);

  const countTokens = useCallback(
    async (content: string) => {
      if (!accuratePreference) {
        return countTokensHeuristic(content);
      }
      return countTokensAccurate(content);
    },
    [accuratePreference]
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

export function __resetTokenCountingRuntimeCacheForTests() {
  runtimeSupportPromise = null;
}
