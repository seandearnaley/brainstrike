import type { SupportedProvider } from '@brainstrike/agent/client';
import {
  createProviderCredentialReader,
  normalizeSecretValue,
  type ResolvedDesktopProviderCredential,
} from '@brainstrike/host-capabilities/provider-credentials';
import {
  inspectProviderKeys as inspectStoredProviderKeys,
  type ProviderKeyInspection,
} from '@brainstrike/host-capabilities/provider-status';
import { createLogger } from '@brainstrike/logging';
import { getAgentProviderEnvKeys, listAgentProviders } from './agent-client-loader';
import { getSecretsService } from './secrets';

export {
  type ResolvedDesktopProviderCredential,
  resolveAwsEnvChainCredential,
} from '@brainstrike/host-capabilities/provider-credentials';

const logger = createLogger('ProviderApiKey');

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

export async function readProviderCredential(
  provider: SupportedProvider
): Promise<ResolvedDesktopProviderCredential | undefined> {
  return createProviderCredentialReader(
    { getCredential: (id) => getSecretsService().getCredential(id) },
    process.env,
    getAgentProviderEnvKeys
  )(provider);
}

export {
  type ProviderKeyInspection,
  type ProviderKeyReadFailure,
  storedAuthMode,
} from '@brainstrike/host-capabilities/provider-status';

/** Main's view of the profile store and its own env; the rules live in host-capabilities. */
export async function inspectProviderKeys(): Promise<ProviderKeyInspection> {
  return await inspectStoredProviderKeys({
    env: process.env,
    envKeys: getAgentProviderEnvKeys,
    providers: listAgentProviders(),
    secrets: getSecretsService,
  });
}

export async function listConfiguredProviders(): Promise<SupportedProvider[]> {
  return (await inspectProviderKeys()).configuredProviders.map(({ provider }) => provider);
}
