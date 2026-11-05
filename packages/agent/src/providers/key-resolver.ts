import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { getProviderEnvKeys } from '@brainstrike/assistant-contract/provider-registry';
import type { RuntimeData } from '../types.ts';

export type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
export { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';

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
    const envVars = isSupportedProvider(provider) ? getProviderEnvKeys(provider) : [];

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
