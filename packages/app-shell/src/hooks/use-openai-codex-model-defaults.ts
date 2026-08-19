import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import {
  OPENAI_CODEX_RECOMMENDED_MODEL_IDS,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useToast } from '@brainstrike/ui';
import { useEffect, useRef } from 'react';

const logger = createLogger('OpenAiCodexModelDefaults');

interface InitializationAttempt {
  readonly db: DbHandle;
  readonly secretsVersion: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Seeds the recommended ChatGPT-subscription model set once an account is
 * connected (BST-1356). Migration 102 seeds every `openai-codex` catalog row
 * disabled — exactly like the openrouter and bedrock seeds — and THIS hook is
 * where enablement comes from, through the same idempotent,
 * user-choice-preserving registry action. Keep this structurally parallel to
 * `useBedrockDefaults`; asymmetry between the disabled-by-default providers
 * is a bug, not a customization.
 *
 * The `configuredProviders.includes('openai-codex')` gate is what ties
 * enablement to a real connection: `openai-codex` is NOT a keyless provider,
 * so it only appears in that list once a subscription credential is stored.
 */
export function useOpenAiCodexDefaults(
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
  // Read during render, not inside the effect: `openai-codex` needs COMPUTED
  // member access (the hyphen rules out the dot form `useBedrockDefaults`
  // uses), and a computed expression in a dependency array cannot be checked
  // statically — which is what let the effect close over `providerReadErrors`
  // while depending only on one slot of it. Naming the value keeps the
  // dependency and the value the effect actually uses the same thing.
  const codexReadError = providerReadErrors?.['openai-codex'];

  useEffect(() => {
    if (
      !(providerDiscoveryEnabled && db && hasLoaded) ||
      registryError ||
      codexReadError ||
      !configuredProviders.includes('openai-codex')
    ) {
      return;
    }

    if (attempted.current?.db === db && attempted.current.secretsVersion === secretsVersion) {
      return;
    }
    attempted.current = { db, secretsVersion };

    void initializeProviderModelDefaults(
      db,
      'openai-codex',
      OPENAI_CODEX_RECOMMENDED_MODEL_IDS
    ).catch((error: unknown) => {
      const description = errorMessage(error);
      logger.error('Failed to initialize recommended ChatGPT subscription models', { error });
      toast({
        description,
        title: 'OpenAI (ChatGPT) model setup failed',
        variant: 'destructive',
      });
    });
  }, [
    codexReadError,
    configuredProviders,
    db,
    hasLoaded,
    initializeProviderModelDefaults,
    providerDiscoveryEnabled,
    registryError,
    secretsVersion,
    toast,
  ]);
}
