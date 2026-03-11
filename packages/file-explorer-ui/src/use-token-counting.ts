import { tokenPreferencesSelectors, useTokenPreferencesStore } from '@brainstrike/preferences';
import {
  countTokensAccurateLazy,
  countTokensHeuristicLazy,
  supportsAccurateTokenCountingLazy,
} from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type TokenCountingMode = 'accurate' | 'heuristic';
export type TokenCountingReason = 'preference-disabled' | 'runtime-fallback' | null;

export interface TokenCountingState {
  countTokens: (content: string) => Promise<number>;
  loading: boolean;
  mode: TokenCountingMode;
  reason: TokenCountingReason;
}

let runtimeSupportPromise: Promise<boolean> | null = null;

async function resolveRuntimeSupport(): Promise<boolean> {
  if (!runtimeSupportPromise) {
    runtimeSupportPromise = supportsAccurateTokenCountingLazy();
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
        return countTokensHeuristicLazy(content);
      }
      return countTokensAccurateLazy(content);
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
