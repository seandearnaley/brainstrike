import { isSupportedProvider } from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import { createLogger } from '@brainstrike/utils/logger';
import { getAgentProviderEnvKeys, listAgentProviders } from './agent-client-loader';
import { getSecretsService, SecretReadError, type SecretReadErrorCode } from './secrets';

const logger = createLogger('ProviderApiKey');

function normalizeSecretValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The environment variable NAME (never its value) that currently supplies this
 * provider's credential, or undefined when no env var is set.
 */
export function resolveProviderEnvVarName(provider: SupportedProvider): string | undefined {
  const envKeys = getAgentProviderEnvKeys(provider);
  for (const envKey of envKeys) {
    if (normalizeSecretValue(process.env[envKey])) {
      return envKey;
    }
  }
  return;
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
    throw error;
  }
}

export async function readProviderApiKey(provider: SupportedProvider): Promise<string | undefined> {
  const envValue = resolveProviderEnvKey(provider);
  if (envValue) {
    return envValue;
  }
  return await readProviderSecretKey(provider);
}

export interface ProviderKeyReadFailure {
  readonly code: SecretReadErrorCode;
  readonly message: string;
  readonly provider: SupportedProvider;
}

/** Which credential store the runtime will actually use for this provider. */
export type ProviderKeySource = 'env' | 'stored';

export interface ProviderKeyOrigin {
  /** Env var NAME when `source` is 'env'; absent for 'stored'. Never a value. */
  readonly envVar?: string;
  readonly provider: SupportedProvider;
  readonly source: ProviderKeySource;
}

export interface ProviderKeyInspection {
  readonly configuredProviders: SupportedProvider[];
  /** One entry per configured provider, in `configuredProviders` order. */
  readonly providerSources: ProviderKeyOrigin[];
  readonly readFailures: ProviderKeyReadFailure[];
}

export async function inspectProviderKeys(): Promise<ProviderKeyInspection> {
  const configured = new Set<SupportedProvider>();
  const providerSources: ProviderKeyOrigin[] = [];
  const readFailures: ProviderKeyReadFailure[] = [];
  const supportedProviders = listAgentProviders();

  for (const provider of supportedProviders) {
    const envVar = resolveProviderEnvVarName(provider);
    if (envVar) {
      configured.add(provider);
      providerSources.push({ envVar, provider, source: 'env' });
    }
  }

  const secretsService = getSecretsService();
  const storedProviders: string[] = await secretsService.listProviders();
  for (const provider of storedProviders) {
    if (!isSupportedProvider(provider)) {
      continue;
    }
    const supported = provider as SupportedProvider;
    if (configured.has(supported)) {
      continue;
    }
    try {
      const key = await secretsService.getKey(supported);
      if (normalizeSecretValue(key)) {
        configured.add(supported);
        providerSources.push({ provider: supported, source: 'stored' });
      }
    } catch (error) {
      if (!(error instanceof SecretReadError)) {
        throw error;
      }
      logger.error('Stored provider key is unreadable; reporting provider failure', {
        error,
        provider: supported,
      });
      readFailures.push({
        code: error.code,
        message: error.message,
        provider: supported,
      });
    }
  }

  return {
    configuredProviders: Array.from(configured.values()),
    providerSources,
    readFailures,
  };
}

export async function listConfiguredProviders(): Promise<SupportedProvider[]> {
  return (await inspectProviderKeys()).configuredProviders;
}
