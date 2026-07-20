import { isSupportedProvider } from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import { createLogger } from '@brainstrike/utils/logger';
import { getAgentProviderEnvKeys, listAgentProviders } from './agent-client-loader';
import { getSecretsService } from './secrets';

const logger = createLogger('ProviderApiKey');

function normalizeSecretValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return;
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
  return;
}

export async function readProviderSecretKey(
  provider: SupportedProvider
): Promise<string | undefined> {
  try {
    const secretsService = getSecretsService();
    const value = await secretsService.getKey(provider);
    return normalizeSecretValue(value);
  } catch (error) {
    logger.error('Failed to read secrets entry for provider', { error, provider });
  }
  return;
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
      if (!isSupportedProvider(provider)) {
        continue;
      }
      const supported = provider as SupportedProvider;
      try {
        const key = await secretsService.getKey(supported);
        if (normalizeSecretValue(key)) {
          configured.add(supported);
        }
      } catch (error) {
        // Per-provider: one unreadable key must not abort enumeration of the
        // providers after it (BST-574 review finding). Surfaced, not counted.
        logger.error('Stored provider key is unreadable; omitting from configured list', {
          error,
          provider: supported,
        });
      }
    }
  } catch (error) {
    logger.error('Failed to enumerate stored provider keys', { error });
  }

  return Array.from(configured.values());
}
