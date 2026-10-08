import type http from 'node:http';
import { isSupportedProvider } from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import type { ProviderCredential, ProviderKeySource } from '@brainstrike/assistant-contract';
import type { ResolvedProviderCredential } from '@brainstrike/assistant-service/ports';
import { createProviderApiKeyReader } from '@brainstrike/assistant-service/provider-credential-projection';
import { inspectProviderKeys, readProviderCredential } from '../provider-api-key';
import { desktopAssistantServerLogger as logger } from './logger';
import { respondToSecretReadError } from './secret-error-responses';
import { resolveTavilyApiKeyFromKeychain, TAVILY_SECRET_PROVIDER } from './web-search-tool';

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

/**
 * String migration shim (BST-1352): the legacy `ProviderApiKeyReader` surface
 * over the typed reader. `api_key` → `.key`; a stored non-api_key credential
 * throws the SecretReadError-shaped `credential_type_unsupported` failure —
 * exactly what `SecretsService.getKey` threw before, so every consumer's
 * classification (api_key_unreadable 400, persona pin skip) is unchanged.
 */
const providerApiKeyReader = createProviderApiKeyReader(resolveProviderCredential);

/**
 * @deprecated BST-1352 migration surface only. New consumers take the typed
 * {@link resolveProviderCredential} directly — this string shim exists for the
 * remaining bearer-key-only call sites (persona pin keys, persistent-memory
 * model targets, the OpenRouter metadata endpoint) and throws the classified
 * `credential_type_unsupported` SecretReadError shape on any stored
 * non-api_key credential.
 */
export async function resolveProviderApiKey(provider: string): Promise<string | undefined> {
  return await providerApiKeyReader(provider);
}

/** Main's legacy verification reader: env, then Main's read-only view of the profile store. */
export async function readMainVerificationCredential(
  providerId: string
): Promise<ProviderCredential | undefined> {
  if (providerId !== TAVILY_SECRET_PROVIDER) {
    return await resolveProviderCredential(providerId);
  }
  const key = await resolveTavilyApiKeyFromKeychain();
  return key === undefined ? undefined : { key, type: 'api_key' };
}

export async function collectAvailableProviders(): Promise<{
  providerErrors: Array<{
    code: string;
    error: 'api_key_unreadable';
    message: string;
    provider: SupportedProvider;
  }>;
  providerKeySources: ProviderKeySource<SupportedProvider>[];
  providers: string[];
}> {
  const inspection = await inspectProviderKeys();
  const providers = new Set(inspection.configuredProviders.map(({ provider }) => provider));

  // Local provider is always available (runs in-browser, no API key needed)
  providers.add('local');

  return {
    providerErrors: inspection.readFailures.map((failure) => ({
      code: failure.code,
      error: 'api_key_unreadable' as const,
      message: failure.message,
      provider: failure.provider,
    })),
    providerKeySources: inspection.configuredProviders,
    providers: Array.from(providers),
  };
}

export async function resolveProviderApiKeyOrRespond(
  provider: string,
  res: http.ServerResponse
): Promise<{ apiKey: string | undefined } | undefined> {
  try {
    return { apiKey: await resolveProviderApiKey(provider) };
  } catch (error) {
    if (respondToSecretReadError(res, error)) {
      return;
    }
    throw error;
  }
}
