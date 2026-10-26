/**
 * Utilities for validating API key availability before attempting embedding operations.
 * Prevents errors from propagating to users when they haven't configured required API keys.
 */

import { providerVendorEnvKey } from '@brainstrike/assistant-contract/provider-metadata';
import type { EmbeddingProviderType } from './provider-types.ts';
import { parseProviderModelKey } from './provider-utils.ts';
import {
  detectDeprecatedHostedProviderEnvNames,
  HOSTED_PROVIDER_ENV_KEYS,
  resolveHostedProviderApiKey,
} from './providers/hosted/api-key-resolver.ts';

/**
 * Result of API key validation check
 */
export type ApiKeyValidationUnavailableReason = 'missing-provider-key';

export type ApiKeyValidationResult =
  | { available: true }
  | {
      available: false;
      provider: EmbeddingProviderType;
      reason: ApiKeyValidationUnavailableReason;
      message: string;
    };

/**
 * User-facing env-name hints, derived from the resolver's ONE name table
 * (BST-1361 review 6 — no second hand-maintained list). The vendor-standard
 * name (`providerVendorEnvKey`) leads the hint.
 */
function providerEnvHints(provider: EmbeddingProviderType): readonly string[] {
  const names = HOSTED_PROVIDER_ENV_KEYS[provider] ?? [];
  const vendorName = providerVendorEnvKey(provider);
  if (!(vendorName && names.includes(vendorName))) {
    return names;
  }
  return [vendorName, ...names.filter((name) => name !== vendorName)];
}

/**
 * Human-readable provider names for error messages
 */
const PROVIDER_DISPLAY_NAMES: Record<EmbeddingProviderType, string> = {
  cohere: 'Cohere',
  google: 'Google',
  openai: 'OpenAI',
  voyage: 'Voyage AI',
};

/**
 * Check if an API key is available for a given model key: checks environment
 * variables and Electron secrets.
 *
 * @param modelKey - The composite model key (e.g., "openai::text-embedding-3-small")
 * @returns Result indicating availability and helpful error message if not available
 *
 * @example
 * const result = await checkApiKeyAvailability('openai::text-embedding-3-small');
 * if (!result.available) {
 *   toast.error(result.message);
 *   return;
 * }
 * // Proceed with embedding...
 */
export async function checkApiKeyAvailability(
  modelKey: string | null | undefined
): Promise<ApiKeyValidationResult> {
  // No model key means we can't validate
  if (!modelKey) {
    return { available: true }; // Let other validation handle missing model key
  }

  const parsed = parseProviderModelKey(modelKey);
  if (!parsed) {
    return { available: true }; // Invalid format, let other validation handle it
  }

  const { provider } = parsed;

  const apiKey = await resolveHostedProviderApiKey(provider);

  if (apiKey) {
    return { available: true };
  }

  // API key not found - return helpful error message
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const envHints = providerEnvHints(provider);
  const envHintText = envHints.length > 0 ? ` (${envHints[0]})` : '';

  // BST-1361: a set-but-deprecated name (plain or VITE_-prefixed) is the
  // most likely cause of a suddenly-missing key — surface the rename in the
  // same visible error instead of dying silently. Names only, never values.
  const deprecatedHits = detectDeprecatedHostedProviderEnvNames(provider);
  const deprecatedText =
    deprecatedHits.length > 0
      ? ` Deprecated variable(s) detected that never authenticate: ${deprecatedHits
          .map(({ envVar, replacement }) => `${envVar} (rename to ${replacement})`)
          .join(', ')}.`
      : '';

  return {
    available: false,
    message: `${displayName} API key not configured. Please add your API key${envHintText} in Settings → Secrets or set the environment variable.${deprecatedText}`,
    provider,
    reason: 'missing-provider-key',
  };
}

/**
 * Synchronous check for whether a model key requires an API key.
 * Does not actually check if the key is present - use checkApiKeyAvailability for that.
 *
 * @param modelKey - The composite model key
 * @returns true if the model key names an embedding provider
 */
export function requiresApiKey(modelKey: string | null | undefined): boolean {
  return parseProviderModelKey(modelKey) !== null;
}

/**
 * Get a user-friendly message explaining how to configure an API key for a provider.
 *
 * @param provider - The embedding provider type
 * @returns Configuration instructions for the provider
 */
export function getApiKeyConfigInstructions(provider: EmbeddingProviderType): string {
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const envHints = providerEnvHints(provider);

  const instructions = [
    `To use ${displayName} embeddings, configure your API key:`,
    '',
    '**Desktop (Electron):**',
    '1. Go to Settings → Secrets',
    `2. Add your ${displayName} API key`,
    '',
    '**Web:**',
    `Set the environment variable: ${envHints[0] ?? `${provider.toUpperCase()}_API_KEY`}`,
  ];

  return instructions.join('\n');
}
