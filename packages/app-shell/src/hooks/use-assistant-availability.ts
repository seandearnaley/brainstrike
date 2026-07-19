import {
  isSupportedProvider,
  isValidModelForProvider,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { useEffect, useState, useSyncExternalStore } from 'react';

export type AssistantAvailabilityStatus =
  | { state: 'loading' }
  | { state: 'enabled'; model?: string; provider?: SupportedProvider }
  | { state: 'disabled'; reason?: string }
  | { state: 'error'; message: string };

export type AssistantStatusFetcher = (signal: AbortSignal) => Promise<AssistantAvailabilityStatus>;

const defaultFetcher: AssistantStatusFetcher = (signal) => fetchAssistantStatusState({ signal });
const loadingStatus: AssistantAvailabilityStatus = { state: 'loading' };
export const ASSISTANT_AVAILABILITY_OVERRIDE_EVENT =
  'brainstrike:assistant-availability-override-changed';

interface AssistantAvailabilityOverrideSnapshot {
  readonly override: AssistantAvailabilityStatus | undefined;
  readonly revision: number;
}

interface FetchedAssistantAvailability {
  readonly fetcher: AssistantStatusFetcher;
  readonly overrideRevision: number;
  readonly status: AssistantAvailabilityStatus;
}

const serverOverrideSnapshot: AssistantAvailabilityOverrideSnapshot = {
  override: undefined,
  revision: 0,
};
const overrideListeners = new Set<() => void>();
let overrideSnapshot = serverOverrideSnapshot;

declare global {
  interface Window {
    __assistantAvailabilityOverride?: AssistantAvailabilityStatus;
  }
}

export function useAssistantAvailability(
  fetcher: AssistantStatusFetcher = defaultFetcher
): AssistantAvailabilityStatus {
  const { override, revision: overrideRevision } = useSyncExternalStore(
    subscribeToAssistantAvailabilityOverride,
    getAssistantAvailabilityOverrideSnapshot,
    getServerAssistantAvailabilityOverrideSnapshot
  );
  const [fetchedAvailability, setFetchedAvailability] = useState<FetchedAssistantAvailability>(
    () => ({
      fetcher,
      overrideRevision,
      status: loadingStatus,
    })
  );

  useEffect(() => {
    if (override !== undefined) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    fetcher(controller.signal)
      .then((next) => {
        if (!cancelled) {
          setFetchedAvailability({
            fetcher,
            overrideRevision,
            status: next,
          });
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (isAbortError(error)) {
          return;
        }
        setFetchedAvailability({
          fetcher,
          overrideRevision,
          status: {
            message: error instanceof Error ? error.message : String(error),
            state: 'error',
          },
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetcher, override, overrideRevision]);

  if (override !== undefined) {
    return override;
  }

  if (
    fetchedAvailability.fetcher !== fetcher ||
    fetchedAvailability.overrideRevision !== overrideRevision
  ) {
    return loadingStatus;
  }

  return fetchedAvailability.status;
}

function readAssistantAvailabilityOverride(): AssistantAvailabilityStatus | undefined {
  return typeof window === 'undefined' ? undefined : window.__assistantAvailabilityOverride;
}

function getAssistantAvailabilityOverrideSnapshot(): AssistantAvailabilityOverrideSnapshot {
  const override = readAssistantAvailabilityOverride();
  if (overrideSnapshot.override !== override) {
    overrideSnapshot = {
      override,
      revision: overrideSnapshot.revision + 1,
    };
  }
  return overrideSnapshot;
}

function getServerAssistantAvailabilityOverrideSnapshot(): AssistantAvailabilityOverrideSnapshot {
  return serverOverrideSnapshot;
}

function publishAssistantAvailabilityOverride(): void {
  overrideSnapshot = {
    override: readAssistantAvailabilityOverride(),
    revision: overrideSnapshot.revision + 1,
  };
  for (const listener of overrideListeners) {
    listener();
  }
}

function subscribeToAssistantAvailabilityOverride(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  if (overrideListeners.size === 0) {
    window.addEventListener(
      ASSISTANT_AVAILABILITY_OVERRIDE_EVENT,
      publishAssistantAvailabilityOverride
    );
  }
  overrideListeners.add(onStoreChange);

  return () => {
    overrideListeners.delete(onStoreChange);
    if (overrideListeners.size === 0) {
      window.removeEventListener(
        ASSISTANT_AVAILABILITY_OVERRIDE_EVENT,
        publishAssistantAvailabilityOverride
      );
    }
  };
}

/**
 * Resolve the assistant server ROOT base URL via the same strategy the status
 * probe uses (bridge `getUrl()` → static `url` → `/api` fallback). Callers append
 * their own endpoint path (`/assistant/status`, `/assistant/suspended-runs`, …).
 */
export async function resolveAssistantBaseUrl(): Promise<string> {
  if (typeof window === 'undefined') {
    return '/api';
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
          return trimTrailingSlash(base);
        }
      } catch {
        // ignored - fall through to other strategies
      }
    }

    if (typeof assistantBridge.url === 'string' && assistantBridge.url.length > 0) {
      return trimTrailingSlash(assistantBridge.url);
    }
  }

  return '/api';
}

export async function resolveAssistantStatusUrl(): Promise<string> {
  return `${await resolveAssistantBaseUrl()}/assistant/status`;
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

  const payload = (await response.json()) as {
    enabled: boolean;
    model?: string;
    provider?: string;
    reason?: string;
  };

  if (payload.enabled) {
    const hasProvider = payload.provider !== undefined;
    const hasModel = payload.model !== undefined;
    if (hasProvider !== hasModel) {
      throw new Error('Assistant status must advertise provider and model together');
    }
    if (!(hasProvider && hasModel)) {
      return { state: 'enabled' };
    }
    if (!isSupportedProvider(payload.provider)) {
      throw new Error(`Unsupported assistant provider: ${payload.provider}`);
    }
    if (
      typeof payload.model !== 'string' ||
      !isValidModelForProvider(payload.provider, payload.model)
    ) {
      throw new Error(`Unsupported assistant model: ${payload.provider}/${String(payload.model)}`);
    }
    return {
      model: payload.model,
      provider: payload.provider,
      state: 'enabled',
    };
  }

  if (payload.reason) {
    return { reason: payload.reason, state: 'disabled' };
  }

  return { state: 'disabled' };
}

export const __private__ = {
  trimTrailingSlash,
};
