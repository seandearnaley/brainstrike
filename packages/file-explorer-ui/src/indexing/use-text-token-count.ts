import { useEffect, useRef, useState } from 'react';
import { useOptionalTokenCacheContext } from './token-cache-context';

export interface UseTextTokenCountOptions {
  enabled?: boolean;
  text: string;
}

export interface UseTextTokenCountReturn {
  loading: boolean;
  tokenCount: number;
}

export function useTextTokenCount({
  text,
  enabled = true,
}: UseTextTokenCountOptions): UseTextTokenCountReturn {
  const tokenCache = useOptionalTokenCacheContext();
  const countTextTokens = tokenCache?.countTextTokens;
  const countingMode = tokenCache?.countingMode;
  const isWorkerReady = tokenCache?.isWorkerReady ?? false;

  const [state, setState] = useState<UseTextTokenCountReturn>({ tokenCount: 0, loading: false });
  const lastTextRef = useRef<string>('');
  const lastModeRef = useRef<string>('');

  // biome-ignore lint/plugin: Async tokenization requires effect-driven state updates
  useEffect(() => {
    if (!(enabled && countTextTokens)) {
      setState({ tokenCount: 0, loading: false });
      lastTextRef.current = '';
      lastModeRef.current = '';
      return;
    }

    if (!text) {
      setState({ tokenCount: 0, loading: false });
      lastTextRef.current = '';
      lastModeRef.current = '';
      return;
    }

    if (!isWorkerReady) {
      // CRITICAL: Never use heuristic fallback in preview token counting.
      // Token counts remain unavailable until worker readiness is confirmed.
      setState({ tokenCount: 0, loading: false });
      lastTextRef.current = '';
      lastModeRef.current = '';
      return;
    }

    const modeKey = countingMode ?? 'heuristic';
    if (lastTextRef.current === text && lastModeRef.current === modeKey) {
      return;
    }
    lastTextRef.current = text;
    lastModeRef.current = modeKey;

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));

    void (async () => {
      try {
        const count = await countTextTokens(text);
        if (!cancelled) {
          setState({ tokenCount: count, loading: false });
        }
      } catch {
        if (!cancelled) {
          setState({ tokenCount: 0, loading: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [countTextTokens, countingMode, enabled, isWorkerReady, text]);

  return state;
}
