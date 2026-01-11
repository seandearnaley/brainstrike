import type { RuntimeData } from '../index';
import type { SupportedProvider } from './types';

export type { SupportedProvider } from './types';
export { isSupportedProvider } from './types';

/**
 * Environment variable mapping for each supported provider
 */
const PROVIDER_ENV_VARS: Record<SupportedProvider, string[]> = {
  openai: ['OPENAI_API_KEY', 'AI_OPENAI_API_KEY', 'OPENAI_API_KEY_V1', 'OPENAI_API_KEY_V2'],
  anthropic: ['ANTHROPIC_API_KEY', 'AI_ANTHROPIC_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY', 'AI_OPENROUTER_API_KEY'],
  cohere: ['COHERE_API_KEY', 'AI_COHERE_API_KEY'],
  voyage: ['VOYAGE_API_KEY', 'AI_VOYAGE_API_KEY'],
  local: [], // Local provider runs client-side, no API key needed
};

/**
 * Resolves the API key for a given provider from runtime data or environment variables
 *
 * @param provider - The AI provider to resolve the key for
 * @param runtime - Optional runtime data that may contain an explicit API key
 * @returns The API key if found, otherwise undefined
 */
export function resolveProviderApiKey(
  provider: SupportedProvider | string,
  runtime?: RuntimeData
): string | undefined {
  // First priority: explicit API key in runtime data
  if (runtime?.apiKey && typeof runtime.apiKey === 'string' && runtime.apiKey.trim()) {
    return runtime.apiKey;
  }

  // Second priority: environment variables (only check in Node.js environments)
  if (typeof process !== 'undefined') {
    const env = process.env ?? {};
    const envVars = PROVIDER_ENV_VARS[provider as SupportedProvider] ?? [];

    for (const envVar of envVars) {
      const value = env[envVar];
      const trimmed = value?.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }

  return;
}
