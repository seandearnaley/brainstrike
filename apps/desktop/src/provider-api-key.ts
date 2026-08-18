import { isSupportedProvider } from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import {
  type ProviderCredential,
  type ProviderKeySource,
  resolveHostedProviderCredential,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
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

export interface ResolvedProviderEnvCredential {
  readonly envVar: string;
  readonly value: string;
}

export function resolveProviderEnvCredential(
  provider: SupportedProvider
): ResolvedProviderEnvCredential | undefined {
  const envKeys = getAgentProviderEnvKeys(provider);
  for (const envKey of envKeys) {
    const value = normalizeSecretValue(process.env[envKey]);
    if (value) {
      return { envVar: envKey, value };
    }
  }
  return;
}

export function resolveProviderEnvKey(provider: SupportedProvider): string | undefined {
  return resolveProviderEnvCredential(provider)?.value;
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

/** A typed credential plus where it came from (BST-1352). */
export type ResolvedDesktopProviderCredential = ProviderCredential & {
  source: 'env' | 'stored';
};

/**
 * Normalize a stored api_key credential exactly like the legacy string read
 * (`normalizeSecretValue`): trim the key; a blank key is "not configured".
 * Typed credentials (`oauth`/`aws`) have validated fields and pass through.
 */
function normalizeStoredCredential(credential: ProviderCredential): ProviderCredential | undefined {
  if (credential.type !== 'api_key') {
    return credential;
  }
  const key = credential.key.trim();
  if (!key) {
    return;
  }
  return key === credential.key ? credential : { ...credential, key };
}

/**
 * Typed credential read (BST-1352), routed through the ONE shared
 * env-authoritative resolution core (`resolveHostedProviderCredential`,
 * BST-979 contract preserved): env hits are `api_key` credentials tagged
 * `source: 'env'`; stored hits come from the BST-1348 `getCredential` and tag
 * `source: 'stored'`. A store read failure with no env credential rethrows
 * (same contract as `readProviderSecretKey`) — never coerced into "not
 * configured".
 */
export async function readProviderCredential(
  provider: SupportedProvider
): Promise<ResolvedDesktopProviderCredential | undefined> {
  const secretsService = getSecretsService();
  const resolution = await resolveHostedProviderCredential({
    envKeyNames: getAgentProviderEnvKeys(provider),
    envSources: [process.env],
    readCredential: async () => {
      const stored = await secretsService.getCredential(provider);
      return stored === null ? null : normalizeStoredCredential(stored);
    },
  });
  if (resolution.credential && resolution.source) {
    return { ...resolution.credential, source: resolution.source };
  }
  if (resolution.secretReadError !== undefined) {
    logger.error('Failed to read secrets entry for provider', {
      error: resolution.secretReadError,
      provider,
    });
    throw resolution.secretReadError;
  }
  return;
}

export interface ProviderKeyReadFailure {
  readonly code: SecretReadErrorCode;
  readonly message: string;
  readonly provider: SupportedProvider;
}

export interface ProviderKeyInspection {
  readonly configuredProviders: ProviderKeySource<SupportedProvider>[];
  readonly readFailures: ProviderKeyReadFailure[];
}

export async function inspectProviderKeys(): Promise<ProviderKeyInspection> {
  const configured = new Map<SupportedProvider, ProviderKeySource<SupportedProvider>>();
  const readFailures: ProviderKeyReadFailure[] = [];
  const supportedProviders = listAgentProviders();

  for (const provider of supportedProviders) {
    const environmentCredential = resolveProviderEnvCredential(provider);
    if (environmentCredential) {
      configured.set(provider, {
        envVar: environmentCredential.envVar,
        provider,
        source: 'env',
      });
    }
  }

  const secretsService = getSecretsService();
  const storedProviders: string[] = await secretsService.listProviders();
  const inspectedStoredProviders = new Set<SupportedProvider>();
  for (const provider of storedProviders) {
    if (!isSupportedProvider(provider)) {
      continue;
    }
    const supported = provider as SupportedProvider;
    if (configured.has(supported) || inspectedStoredProviders.has(supported)) {
      continue;
    }
    inspectedStoredProviders.add(supported);
    try {
      const key = await secretsService.getKey(supported);
      if (normalizeSecretValue(key)) {
        configured.set(supported, { provider: supported, source: 'stored' });
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
    configuredProviders: [...configured.values()],
    readFailures,
  };
}

export async function listConfiguredProviders(): Promise<SupportedProvider[]> {
  return (await inspectProviderKeys()).configuredProviders.map(({ provider }) => provider);
}
