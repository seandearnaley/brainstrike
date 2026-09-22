import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import {
  getProviderDisplayName,
  getProviderModelDefaultPolicy,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useToast } from '@brainstrike/ui';
import { useEffect, useRef } from 'react';

const logger = createLogger('ProviderModelDefaults');

interface InitializationAttempt {
  readonly db: DbHandle;
  readonly secretsVersion: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * First-configuration and ongoing catalog enablement for every provider that
 * declares a policy (BST-1794). This replaced three near-identical
 * per-provider hooks: the asymmetry between them was the bug, because
 * `openai`, `anthropic` and `google` simply never got one and their newest
 * catalog rows stayed unreachable.
 *
 * Driving it from `PROVIDER_MODEL_DEFAULT_POLICIES` means a new provider
 * cannot be added without stating a policy — the map is exhaustive over
 * `SupportedProvider` and will not compile otherwise.
 *
 * The attempt guard is per provider AND per `{db, secretsVersion}`: one
 * dispatch per app session, and again when credentials change. That cadence is
 * what makes an `all` policy standing rather than one-time — a model added by a
 * later migration is evaluated on the next launch.
 */
export function useProviderModelDefaults(
  configuredProviders: readonly SupportedProvider[],
  db: DbHandle | null,
  secretsVersion: number,
  providerDiscoveryEnabled: boolean,
  providerReadErrors?: Partial<Record<SupportedProvider, string>>
): void {
  const hasLoaded = useModelRegistryStore((state) => state.hasLoaded);
  const registryError = useModelRegistryStore((state) => state.error);
  const initializeProviderModelDefaults = useModelRegistryStore(
    (state) => state.initializeProviderModelDefaults
  );
  const attempted = useRef<Map<SupportedProvider, InitializationAttempt> | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!(providerDiscoveryEnabled && db && hasLoaded) || registryError) {
      return;
    }

    attempted.current ??= new Map<SupportedProvider, InitializationAttempt>();
    const attemptedProviders = attempted.current;

    for (const provider of configuredProviders) {
      const policy = getProviderModelDefaultPolicy(provider);
      if (!policy || providerReadErrors?.[provider]) {
        continue;
      }

      const previous = attemptedProviders.get(provider);
      if (previous?.db === db && previous.secretsVersion === secretsVersion) {
        continue;
      }
      attemptedProviders.set(provider, { db, secretsVersion });

      void initializeProviderModelDefaults(db, provider, policy).catch((error: unknown) => {
        const description = errorMessage(error);
        logger.error('Failed to initialize provider model defaults', { error, provider });
        toast({
          description,
          title: `${getProviderDisplayName(provider)} model setup failed`,
          variant: 'destructive',
        });
      });
    }
  }, [
    configuredProviders,
    db,
    hasLoaded,
    initializeProviderModelDefaults,
    providerDiscoveryEnabled,
    providerReadErrors,
    registryError,
    secretsVersion,
    toast,
  ]);
}
