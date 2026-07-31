import {
  OPENROUTER_RECOMMENDED_CODING_MODEL_IDS,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import type { DbHandle } from '@brainstrike/db/react';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useRef } from 'react';

const logger = createLogger('OpenRouterModelDefaults');

interface InitializationAttempt {
  readonly db: DbHandle;
  readonly secretsVersion: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Seeds a small coding-oriented OpenRouter set after the first readable key is
 * configured. The registry action preserves every durable user choice and is
 * idempotent across reloads and key replacement.
 */
export function useOpenRouterDefaults(
  configuredProviders: readonly SupportedProvider[],
  db: DbHandle | null,
  secretsVersion: number,
  initialProviders?: readonly string[],
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
      !(initialProviders === undefined && db && hasLoaded) ||
      registryError ||
      providerReadErrors?.openrouter ||
      !configuredProviders.includes('openrouter')
    ) {
      return;
    }

    if (attempted.current?.db === db && attempted.current.secretsVersion === secretsVersion) {
      return;
    }
    attempted.current = { db, secretsVersion };

    void initializeProviderModelDefaults(
      db,
      'openrouter',
      OPENROUTER_RECOMMENDED_CODING_MODEL_IDS
    ).catch((error: unknown) => {
      const description = errorMessage(error);
      logger.error('Failed to initialize recommended OpenRouter models', { error });
      toast({
        description,
        title: 'OpenRouter model setup failed',
        variant: 'destructive',
      });
    });
  }, [
    configuredProviders,
    db,
    hasLoaded,
    initialProviders,
    initializeProviderModelDefaults,
    providerReadErrors?.openrouter,
    registryError,
    secretsVersion,
    toast,
  ]);
}
