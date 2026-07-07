/**
 * Utilities for validating API key availability before attempting embedding operations.
 * Prevents errors from propagating to users when they haven't configured required API keys.
 */

import { type HostedProviderType, hostedProviderRequiresApiKey } from './provider-types';
import { isHostedProvider, parseProviderModelKey } from './provider-utils';
import { resolveHostedProviderApiKey } from './providers/hosted/api-key-resolver';

/**
 * Result of API key validation check
 */
export type ApiKeyValidationUnavailableReason = 'missing-provider-key';

export type ApiKeyValidationResult =
  | { available: true }
  | {
      available: false;
      provider: HostedProviderType;
      reason: ApiKeyValidationUnavailableReason;
      message: string;
    };

/**
 * Environment variable names for each hosted provider
 */
const PROVIDER_ENV_HINTS: Record<HostedProviderType, string[]> = {
  cohere: ['COHERE_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  lmstudio: ['LMSTUDIO_API_KEY'],
  ollama: ['OLLAMA_API_KEY'],
  openai: ['OPENAI_API_KEY', 'BRAINSTRIKE_OPENAI_API_KEY'],
  voyage: ['VOYAGE_API_KEY'],
};

/**
 * Human-readable provider names for error messages
 */
const PROVIDER_DISPLAY_NAMES: Record<HostedProviderType, string> = {
  cohere: 'Cohere',
  google: 'Google',
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
  openai: 'OpenAI',
  voyage: 'Voyage AI',
};

/**
 * Check if an API key is available for a given model key.
 * Returns immediately for local models (always available).
 * For hosted models, checks environment variables and Electron secrets.
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

  // Local providers don't need API keys
  if (!isHostedProvider(provider)) {
    return { available: true };
  }

  if (!hostedProviderRequiresApiKey(provider)) {
    return { available: true };
  }

  // Check if API key is available for the hosted provider
  const apiKey = await resolveHostedProviderApiKey(provider);

  if (apiKey) {
    return { available: true };
  }

  // API key not found - return helpful error message
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const envHints = PROVIDER_ENV_HINTS[provider];
  const envHintText = envHints.length > 0 ? ` (${envHints[0]})` : '';

  return {
    available: false,
    message: `${displayName} API key not configured. Please add your API key${envHintText} in Settings → Secrets or set the environment variable.`,
    provider,
    reason: 'missing-provider-key',
  };
}

/**
 * Synchronous check for whether a model key requires an API key.
 * Does not actually check if the key is present - use checkApiKeyAvailability for that.
 *
 * @param modelKey - The composite model key
 * @returns true if the model requires an API key (hosted provider)
 */
export function requiresApiKey(modelKey: string | null | undefined): boolean {
  if (!modelKey) {
    return false;
  }

  const parsed = parseProviderModelKey(modelKey);
  if (!parsed) {
    return false;
  }

  return isHostedProvider(parsed.provider) && hostedProviderRequiresApiKey(parsed.provider);
}

/**
 * Get a user-friendly message explaining how to configure an API key for a provider.
 *
 * @param provider - The hosted provider type
 * @returns Configuration instructions for the provider
 */
export function getApiKeyConfigInstructions(provider: HostedProviderType): string {
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const envHints = PROVIDER_ENV_HINTS[provider];

  if (!hostedProviderRequiresApiKey(provider)) {
    return `${displayName} local runtime does not require an API key by default.`;
  }

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
