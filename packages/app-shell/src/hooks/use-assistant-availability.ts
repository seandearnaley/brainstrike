import { isAbortError } from '@brainstrike/utils';
import { useEffect, useState } from 'react';

export type AssistantAvailabilityStatus =
  | { state: 'loading' }
  | { state: 'enabled' }
  | { state: 'disabled'; reason?: string }
  | { state: 'error'; message: string };

export type AssistantStatusFetcher = (signal: AbortSignal) => Promise<AssistantAvailabilityStatus>;

const defaultFetcher: AssistantStatusFetcher = (signal) => fetchAssistantStatusState({ signal });

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
  interface Window {
    __assistantAvailabilityOverride?: AssistantAvailabilityStatus;
  }
}

export function useAssistantAvailability(
  fetcher: AssistantStatusFetcher = defaultFetcher
): AssistantAvailabilityStatus {
  const override =
    typeof window === 'undefined' ? undefined : window.__assistantAvailabilityOverride;
  const [status, setStatus] = useState<AssistantAvailabilityStatus>(
    override ?? { state: 'loading' }
  );

  useEffect(() => {
    if (override) {
      setStatus(override);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    fetcher(controller.signal)
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (isAbortError(error)) {
          return;
        }
        setStatus({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetcher, override]);

  return status;
}

export async function resolveAssistantStatusUrl(): Promise<string> {
  if (typeof window === 'undefined') {
    return '/api/assistant/status';
  }

  type AssistantBridge = {
    url?: string;
    getUrl?: () => Promise<string>;
  };

  const assistantBridge = (window as unknown as { assistant?: AssistantBridge }).assistant;

  if (assistantBridge) {
    if (typeof assistantBridge.getUrl === 'function') {
      try {
        const base = await assistantBridge.getUrl();
        if (base) {
          return `${trimTrailingSlash(base)}/assistant/status`;
        }
      } catch {
        // ignored - fall through to other strategies
      }
    }

    if (typeof assistantBridge.url === 'string' && assistantBridge.url.length > 0) {
      return `${trimTrailingSlash(assistantBridge.url)}/assistant/status`;
    }
  }

  return '/api/assistant/status';
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

type FetchAssistantStatusStateOptions = {
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
};

export async function fetchAssistantStatusState({
  signal,
  fetchImpl = globalThis.fetch,
}: FetchAssistantStatusStateOptions): Promise<AssistantAvailabilityStatus> {
  if (!fetchImpl) {
    throw new Error('Fetch implementation is not available');
  }

  const url = await resolveAssistantStatusUrl();
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }

  const payload = (await response.json()) as { enabled: boolean; reason?: string };

  if (payload.enabled) {
    return { state: 'enabled' };
  }

  if (payload.reason) {
    return { state: 'disabled', reason: payload.reason };
  }

  return { state: 'disabled' };
}

export const __private__ = {
  trimTrailingSlash,
};
