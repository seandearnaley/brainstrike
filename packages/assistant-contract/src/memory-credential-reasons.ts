import { getProviderDefinition, type ProviderId } from './provider-registry.ts';

/**
 * Why a send that needs the observer model is refused while its provider has
 * no API key: one wording, whichever owner finds the key missing.
 */
export function memoryCredentialRequiredReason(provider: ProviderId): string {
  const providerName = getProviderDefinition(provider).displayName;
  return `Observational memory requires a configured ${providerName} API key. Configure it in Settings → Providers, choose an observer whose provider has a key, or turn observations off.`;
}
