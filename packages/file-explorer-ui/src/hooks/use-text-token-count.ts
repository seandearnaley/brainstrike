import { useEffect, useRef, useState } from 'react';
import { useOptionalTokenCacheContext } from '../token-cache-context';

export interface UseTextTokenCountOptions {
  text: string;
  enabled?: boolean;
}

export interface UseTextTokenCountReturn {
  tokenCount: number;
  loading: boolean;
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

    // Include readiness in the memo key so we re-count once the worker is available.
    // This prevents us from getting "stuck" with a heuristic fallback value indefinitely.
    const modeKey = `${countingMode ?? 'heuristic'}:${isWorkerReady ? 'worker' : 'fallback'}`;
    if (lastTextRef.current === text && lastModeRef.current === modeKey) {
      return;
    }
    lastTextRef.current = text;
    lastModeRef.current = modeKey;

    let cancelled = false;
    if (isWorkerReady) {
      setState((prev) => ({ ...prev, loading: true }));
    }

    void (async () => {
      try {
        const count = await countTextTokens(text);
        if (!cancelled) {
          setState({ tokenCount: count, loading: false });
        }
      } catch {
        if (!cancelled) {
          setState((prev) => ({ ...prev, loading: false }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [countTextTokens, countingMode, enabled, isWorkerReady, text]);

  return state;
}
