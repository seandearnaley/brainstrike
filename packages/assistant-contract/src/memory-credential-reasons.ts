import { getProviderDefinition, type ProviderId } from './provider-registry.js';

/** The memory feature a hosted provider's API key is required for. */
export type MemoryCredentialNeed =
  | 'observational-memory'
  | 'semantic-recall'
  | 'semantic-observation-recall';

/**
 * Why a send that needs a hosted memory model is refused while its provider
 * has no API key: one wording, whichever owner finds the key missing.
 */
export function memoryCredentialRequiredReason(
  need: MemoryCredentialNeed,
  provider: ProviderId
): string {
  const providerName = getProviderDefinition(provider).displayName;
  switch (need) {
    case 'observational-memory':
      return `Observational memory requires a configured ${providerName} API key. Configure it in Settings → Providers, choose a keyless local observer, or turn observations off.`;
    case 'semantic-recall':
      return `Semantic recall requires a configured ${providerName} API key. Configure it in Settings → Providers, choose a keyless local embedder, or turn semantic recall off.`;
    case 'semantic-observation-recall':
      return `Semantic observation recall requires a configured ${providerName} API key. Configure it in Settings → Providers, choose a keyless local embedder, or turn vector observation retrieval off.`;
    default: {
      const exhaustive: never = need;
      return exhaustive;
    }
  }
}
