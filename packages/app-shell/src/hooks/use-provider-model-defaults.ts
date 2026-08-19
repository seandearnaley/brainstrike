import type { SupportedProvider } from '@brainstrike/assistant-contract';
import type { DbHandle } from '@brainstrike/db/react';
import { useBedrockDefaults } from './use-bedrock-model-defaults';
import { useOpenAiCodexDefaults } from './use-openai-codex-model-defaults';
import { useOpenRouterDefaults } from './use-openrouter-model-defaults';

/**
 * ONE wrapper-facing seam for first-configuration model-catalog enablement
 * (BST-1350, review finding 8): every keyed provider whose catalog rows ship
 * disabled gets its defaults hook composed HERE, so the panel wrapper stays a
 * single call under its composition budget. The per-provider hooks stay
 * separate (and separately tested) — they share the idempotent,
 * user-choice-preserving `initializeProviderModelDefaults` action.
 */
export function useProviderModelDefaults(
  configuredProviders: readonly SupportedProvider[],
  db: DbHandle | null,
  secretsVersion: number,
  providerDiscoveryEnabled: boolean,
  providerReadErrors?: Partial<Record<SupportedProvider, string>>
): void {
  useOpenRouterDefaults(
    configuredProviders,
    db,
    secretsVersion,
    providerDiscoveryEnabled,
    providerReadErrors
  );
  useBedrockDefaults(
    configuredProviders,
    db,
    secretsVersion,
    providerDiscoveryEnabled,
    providerReadErrors
  );
  // BST-1356. Omitting this call leaves every `openai-codex` catalog row
  // `is_enabled = 0` forever: connect succeeds, the provider reports
  // configured, and the model picker shows nothing — a provider that is dead
  // end to end. Pinned by use-openai-codex-model-defaults.test.tsx.
  useOpenAiCodexDefaults(
    configuredProviders,
    db,
    secretsVersion,
    providerDiscoveryEnabled,
    providerReadErrors
  );
}
