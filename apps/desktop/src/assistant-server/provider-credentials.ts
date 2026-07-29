import type http from 'node:http';
import { isSupportedProvider, type RuntimeData } from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import {
  inspectProviderKeys,
  readProviderSecretKey,
  resolveProviderEnvKey,
} from '../provider-api-key';
import { desktopAssistantServerLogger as logger } from './logger';
import { respondToSecretReadError } from './secret-error-responses';

export async function resolveProviderApiKey(provider: string): Promise<string | undefined> {
  if (!isSupportedProvider(provider)) {
    return;
  }

  const supportedProvider = provider as SupportedProvider;

  const envKey = resolveProviderEnvKey(supportedProvider);
  if (envKey) {
    logger.info('Using environment API key for provider', { provider });
    return envKey;
  }

  const storedKey = await readProviderSecretKey(supportedProvider);
  if (storedKey) {
    logger.info('Retrieved stored API key for provider', { provider });
    return storedKey;
  }
  return;
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

export function hydrateRuntimeDataWithLocalRuntimeToken(
  runtimeData: RuntimeData,
  provider: string,
  fetchedApiKey: string | undefined
): RuntimeData {
  // Only local-runtime providers need their `apiToken` injected into
  // providerOptions so the OpenAI-compat factory can forward it as a bearer
  // header. Hosted providers receive the key through the top-level `apiKey`.
  if (!((provider === 'ollama' || provider === 'lmstudio') && fetchedApiKey)) {
    return runtimeData;
  }

  const providerOptions = { ...(runtimeData.providerOptions ?? {}) };
  const existing = providerOptions[provider];
  providerOptions[provider] = {
    ...(existing ?? {}),
    apiToken: fetchedApiKey,
  };

  return {
    ...runtimeData,
    providerOptions,
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
