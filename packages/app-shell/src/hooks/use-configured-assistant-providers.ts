import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { useMemo, useSyncExternalStore } from 'react';
import {
  type AssistantProviderSource,
  useAssistantProviderSource,
} from './assistant-provider-source';

type SecretsState = ReturnType<typeof useSecretsStore.getState>;

type ProviderDiscoverySnapshot =
  | {
      readonly providers: readonly SupportedProvider[];
      readonly state: 'idle' | 'loading' | 'ready';
    }
  | {
      readonly error: string;
      readonly providers: readonly SupportedProvider[];
      readonly state: 'error';
    };

export interface ConfiguredAssistantProviders {
  readonly discoveryError?: string;
  readonly discoveryState: 'error' | 'idle' | 'inactive' | 'loading' | 'ready';
  readonly providers: readonly SupportedProvider[];
}

const idleDiscoverySnapshot: ProviderDiscoverySnapshot = {
  providers: [],
  state: 'idle',
};

let discoverySnapshot: ProviderDiscoverySnapshot = idleDiscoverySnapshot;
let requestGeneration = 0;
let unsubscribeFromSecrets: (() => void) | undefined;
const discoveryListeners = new Set<() => void>();

/**
 * Resolve providers without mirroring source props into component state.
 *
 * Hosted Web values are render-time authority. Desktop subscribes to one
 * shared external discovery resource, which refreshes on credential changes.
 * That keeps the trigger at the store where the events originate and prevents
 * one discovery read per mounted thread tab.
 */
export function useConfiguredAssistantProviders(): ConfiguredAssistantProviders {
  return useAssistantProviders(useAssistantProviderSource());
}

/** The providers a source names, for a surface outside a composer's source. */
export function useAssistantProviders(
  source: AssistantProviderSource
): ConfiguredAssistantProviders {
  const discoversProviders = source.kind === 'discovery';
  const snapshot = useSyncExternalStore(
    discoversProviders ? subscribeToProviderDiscovery : subscribeToInactiveDiscovery,
    discoversProviders ? getProviderDiscoverySnapshot : getInactiveDiscoverySnapshot,
    getInactiveDiscoverySnapshot
  );
  const authoritativeProviders = source.kind === 'authoritative' ? source.providers : undefined;
  const providerSeeds = source.kind === 'discovery' ? source.seeds : undefined;
  const providers = useMemo(
    () => authoritativeProviders ?? mergeProviders(providerSeeds, snapshot.providers),
    [authoritativeProviders, providerSeeds, snapshot.providers]
  );

  if (source.kind === 'authoritative') {
    return { discoveryState: 'inactive', providers };
  }

  return snapshot.state === 'error'
    ? { discoveryError: snapshot.error, discoveryState: snapshot.state, providers }
    : { discoveryState: snapshot.state, providers };
}

function getProviderDiscoverySnapshot(): ProviderDiscoverySnapshot {
  return discoverySnapshot;
}

function getInactiveDiscoverySnapshot(): ProviderDiscoverySnapshot {
  return idleDiscoverySnapshot;
}

function subscribeToInactiveDiscovery(): () => void {
  return () => undefined;
}

function subscribeToProviderDiscovery(onStoreChange: () => void): () => void {
  discoveryListeners.add(onStoreChange);
  if (discoveryListeners.size === 1) {
    startProviderDiscoverySubscriptions();
  }

  return () => {
    discoveryListeners.delete(onStoreChange);
    if (discoveryListeners.size === 0) {
      stopProviderDiscoverySubscriptions();
    }
  };
}

function startProviderDiscoverySubscriptions(): void {
  unsubscribeFromSecrets = useSecretsStore.subscribe(handleSecretsStoreChange);
  void refreshProviderDiscovery();
}

function stopProviderDiscoverySubscriptions(): void {
  requestGeneration += 1;
  unsubscribeFromSecrets?.();
  unsubscribeFromSecrets = undefined;
}

function handleSecretsStoreChange(next: SecretsState, previous: SecretsState): void {
  if (next.secretsVersion !== previous.secretsVersion) {
    void refreshProviderDiscovery();
  }
}

async function refreshProviderDiscovery(): Promise<void> {
  const generation = ++requestGeneration;
  publishProviderDiscovery({
    providers: discoverySnapshot.providers,
    state: 'loading',
  });

  try {
    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();
    if (generation !== requestGeneration || discoveryListeners.size === 0) {
      return;
    }
    publishProviderDiscovery({ providers, state: 'ready' });
  } catch (error) {
    if (generation !== requestGeneration || discoveryListeners.size === 0) {
      return;
    }
    publishProviderDiscovery({
      error: error instanceof Error ? error.message : String(error),
      providers: discoverySnapshot.providers,
      state: 'error',
    });
  }
}

function publishProviderDiscovery(next: ProviderDiscoverySnapshot): void {
  discoverySnapshot = next;
  for (const listener of discoveryListeners) {
    listener();
  }
}

function mergeProviders(
  providerSeeds: readonly SupportedProvider[] | undefined,
  discoveredProviders: readonly SupportedProvider[]
): readonly SupportedProvider[] {
  const merged = new Set(providerSeeds);
  for (const provider of discoveredProviders) {
    merged.add(provider);
  }
  return [...merged];
}

/** @internal Test-only reset for the module-scoped external resource. */
export function __resetConfiguredAssistantProvidersForTests(): void {
  discoveryListeners.clear();
  stopProviderDiscoverySubscriptions();
  discoverySnapshot = idleDiscoverySnapshot;
}
