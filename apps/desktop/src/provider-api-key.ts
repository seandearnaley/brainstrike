import type { SupportedProvider } from '@brainstrike/agent/client';
import { listProviders, providerEnvKeys } from '@brainstrike/assistant-contract/provider-metadata';
import {
  createProviderCredentialReader,
  normalizeSecretValue,
  type ResolvedDesktopProviderCredential,
} from '@brainstrike/host-capabilities/provider-credentials';
import {
  inspectProviderKeys as inspectStoredProviderKeys,
  type ProviderKeyInspection,
} from '@brainstrike/host-capabilities/provider-status';
import { getSecretsService } from './secrets';

export {
  type ResolvedDesktopProviderCredential,
  resolveAwsEnvChainCredential,
} from '@brainstrike/host-capabilities/provider-credentials';

export interface ResolvedProviderEnvCredential {
  readonly envVar: string;
  readonly value: string;
}

export function resolveProviderEnvCredential(
  provider: SupportedProvider
): ResolvedProviderEnvCredential | undefined {
  const envKeys = providerEnvKeys(provider);
  for (const envKey of envKeys) {
    const value = normalizeSecretValue(process.env[envKey]);
    if (value) {
      return { envVar: envKey, value };
    }
  }
  return;
}

export async function readProviderCredential(
  provider: SupportedProvider
): Promise<ResolvedDesktopProviderCredential | undefined> {
  return createProviderCredentialReader(
    { getCredential: (id) => getSecretsService().getCredential(id) },
    process.env,
    providerEnvKeys
  )(provider);
}

export {
  type ProviderKeyInspection,
  storedAuthMode,
} from '@brainstrike/host-capabilities/provider-status';

/** Main's view of the profile store and its own env; the rules live in host-capabilities. */
export async function inspectProviderKeys(): Promise<ProviderKeyInspection> {
  return await inspectStoredProviderKeys({
    env: process.env,
    envKeys: providerEnvKeys,
    providers: listProviders().map(({ id }) => id),
    secrets: getSecretsService,
  });
}

/** @internal Provider status regressions verify configured-provider projection. */
export async function listConfiguredProviders(): Promise<SupportedProvider[]> {
  return (await inspectProviderKeys()).configuredProviders.map(({ provider }) => provider);
}
