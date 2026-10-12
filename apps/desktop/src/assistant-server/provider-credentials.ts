import { isSupportedProvider } from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import type { ResolvedProviderCredential } from '@brainstrike/assistant-service/ports';
import { readProviderCredential } from '../provider-api-key';
import { desktopAssistantServerLogger as logger } from './logger';

/**
 * Typed credential reader (BST-1352): the desktop implementation of the
 * assistant-service `ProviderCredentialReader` port. Resolution order and the
 * thrown SecretReadError contract are the pre-BST-1352
 * `resolveProviderApiKey` behavior exactly — only the resolved VALUE widened
 * from a key string to the typed credential.
 */
export async function resolveProviderCredential(
  provider: string
): Promise<ResolvedProviderCredential | undefined> {
  if (!isSupportedProvider(provider)) {
    return;
  }

  const credential = await readProviderCredential(provider as SupportedProvider);
  if (!credential) {
    return;
  }
  if (credential.source === 'env') {
    logger.info('Using environment API key for provider', { provider });
  } else {
    logger.info('Retrieved stored API key for provider', { provider });
  }
  return credential;
}
