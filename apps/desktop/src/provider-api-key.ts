import { isSupportedProvider } from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import { getAgentProviderEnvKeys, listAgentProviders } from './agent-client-loader';
import { getSecretsService } from './secrets';

function normalizeSecretValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveProviderEnvKey(provider: SupportedProvider): string | undefined {
  const envKeys = getAgentProviderEnvKeys(provider);
  for (const envKey of envKeys) {
    const value = normalizeSecretValue(process.env[envKey]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export async function readProviderSecretKey(
  provider: SupportedProvider
): Promise<string | undefined> {
  try {
    const secretsService = getSecretsService();
    const value = await secretsService.getKey(provider);
    return normalizeSecretValue(value);
  } catch (error) {
    console.error(
      `[provider-api-key] Failed to read secrets entry for provider "${provider}":`,
      error
    );
    return undefined;
  }
}

export async function readProviderApiKey(provider: SupportedProvider): Promise<string | undefined> {
  const envValue = resolveProviderEnvKey(provider);
  if (envValue) {
    return envValue;
  }
  return await readProviderSecretKey(provider);
}

export async function listConfiguredProviders(): Promise<SupportedProvider[]> {
  const configured = new Set<SupportedProvider>();
  const supportedProviders = listAgentProviders();

  for (const provider of supportedProviders) {
    if (resolveProviderEnvKey(provider)) {
      configured.add(provider);
    }
  }

  try {
    const secretsService = getSecretsService();
    const storedProviders: string[] = await secretsService.listProviders();
    for (const provider of storedProviders) {
      if (!isSupportedProvider(provider)) continue;
      const supported = provider as SupportedProvider;
      const key = await secretsService.getKey(supported);
      if (normalizeSecretValue(key)) {
        configured.add(supported);
      }
    }
  } catch (error) {
    console.error('[provider-api-key] Failed to enumerate stored provider keys:', error);
  }

  return Array.from(configured.values());
}
