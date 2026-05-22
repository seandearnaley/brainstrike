import { isAbortError } from '@brainstrike/utils/error-utils';
import { useEffect, useState } from 'react';

export type AssistantAvailabilityStatus =
  | { state: 'loading' }
  | { state: 'enabled' }
  | { state: 'disabled'; reason?: string }
  | { state: 'error'; message: string };

export type AssistantStatusFetcher = (signal: AbortSignal) => Promise<AssistantAvailabilityStatus>;

const defaultFetcher: AssistantStatusFetcher = (signal) => fetchAssistantStatusState({ signal });
export const ASSISTANT_AVAILABILITY_OVERRIDE_EVENT =
  'brainstrike:assistant-availability-override-changed';

declare global {
  interface Window {
    __assistantAvailabilityOverride?: AssistantAvailabilityStatus;
  }
}

export function useAssistantAvailability(
  fetcher: AssistantStatusFetcher = defaultFetcher
): AssistantAvailabilityStatus {
  const override = readAssistantAvailabilityOverride();
  const [status, setStatus] = useState<AssistantAvailabilityStatus>(
    override ?? { state: 'loading' }
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const syncOverride = (): void => {
      const nextOverride = readAssistantAvailabilityOverride();
      if (nextOverride) {
        setStatus(nextOverride);
      }
    };

    window.addEventListener(ASSISTANT_AVAILABILITY_OVERRIDE_EVENT, syncOverride);
    syncOverride();
    return () => {
      window.removeEventListener(ASSISTANT_AVAILABILITY_OVERRIDE_EVENT, syncOverride);
    };
  }, []);

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

function readAssistantAvailabilityOverride(): AssistantAvailabilityStatus | undefined {
  return typeof window === 'undefined' ? undefined : window.__assistantAvailabilityOverride;
}

export async function resolveAssistantStatusUrl(): Promise<string> {
  if (typeof window === 'undefined') {
    return '/api/assistant/status';
  }

  interface AssistantBridge {
    getUrl?: () => Promise<string>;
    url?: string;
  }

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

interface FetchAssistantStatusStateOptions {
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
}

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
