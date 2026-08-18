import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import {
  BEDROCK_RECOMMENDED_MODEL_IDS,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useToast } from '@brainstrike/ui';
import { useEffect, useRef } from 'react';

const logger = createLogger('BedrockModelDefaults');

interface InitializationAttempt {
  readonly db: DbHandle;
  readonly secretsVersion: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Seeds the recommended Bedrock model set after the first readable bedrock
 * configuration is present (BST-1350, review finding 8). Migration 100 seeds
 * every bedrock catalog row disabled — exactly like the openrouter seed —
 * and THIS hook is where enablement comes from, through the same idempotent,
 * user-choice-preserving registry action `useOpenRouterDefaults` uses. Keep
 * the two hooks structurally parallel; asymmetry between the keyed
 * disabled-by-default providers is a bug, not a customization.
 */
export function useBedrockDefaults(
  configuredProviders: readonly SupportedProvider[],
  db: DbHandle | null,
  secretsVersion: number,
  providerDiscoveryEnabled = true,
  providerReadErrors?: Partial<Record<SupportedProvider, string>>
): void {
  const hasLoaded = useModelRegistryStore((state) => state.hasLoaded);
  const registryError = useModelRegistryStore((state) => state.error);
  const initializeProviderModelDefaults = useModelRegistryStore(
    (state) => state.initializeProviderModelDefaults
  );
  const attempted = useRef<InitializationAttempt | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (
      !(providerDiscoveryEnabled && db && hasLoaded) ||
      registryError ||
      providerReadErrors?.bedrock ||
      !configuredProviders.includes('bedrock')
    ) {
      return;
    }

    if (attempted.current?.db === db && attempted.current.secretsVersion === secretsVersion) {
      return;
    }
    attempted.current = { db, secretsVersion };

    void initializeProviderModelDefaults(db, 'bedrock', BEDROCK_RECOMMENDED_MODEL_IDS).catch(
      (error: unknown) => {
        const description = errorMessage(error);
        logger.error('Failed to initialize recommended Amazon Bedrock models', { error });
        toast({
          description,
          title: 'Amazon Bedrock model setup failed',
          variant: 'destructive',
        });
      }
    );
  }, [
    configuredProviders,
    db,
    hasLoaded,
    initializeProviderModelDefaults,
    providerDiscoveryEnabled,
    providerReadErrors?.bedrock,
    registryError,
    secretsVersion,
    toast,
  ]);
}
