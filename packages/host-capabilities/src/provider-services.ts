import type {
  HostAuthService,
  HostEnvFileFailure,
  HostProviderService,
} from '@brainstrike/agent-host';
import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import {
  findProviderDefinition,
  isSupportedProvider,
  listProviders,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import { TAVILY_ENV_KEYS } from '@brainstrike/assistant-contract/tavily-env-keys';
import type { HostCredentials } from './credentials.js';
import {
  createOpenRouterModelMetadataService,
  requireOpenRouterModelId,
} from './openrouter-model-metadata.js';
import { createProviderCredentialReader, normalizeSecretValue } from './provider-credentials.js';
import { readProviderStatus } from './provider-status.js';
import {
  createProviderVerificationService,
  TAVILY_SECRET_PROVIDER,
} from './provider-verification.js';

export interface HostProviderServicesOptions {
  /** The host's one refresher answers subscription freshness; never a token. */
  readonly auth: Pick<HostAuthService, 'verify'>;
  readonly credentials: HostCredentials;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** Env files the launching shell rejected. */
  readonly envFileFailures: readonly HostEnvFileFailure[];
  /** Trusted fixture seam; production uses the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Provider reads a Settings or panel client makes. Keys resolve here, from the
 * host's environment and credential store, and never leave the process.
 */
export function createHostProviderServices(
  options: HostProviderServicesOptions
): HostProviderService {
  const secrets = (): SecretsService => options.credentials.secrets();
  const readCredential = createProviderCredentialReader(
    { getCredential: (provider) => secrets().getCredential(provider) },
    options.env
  );
  const readTavilyKey = async (): Promise<string | undefined> => {
    for (const name of TAVILY_ENV_KEYS) {
      const value = normalizeSecretValue(options.env[name]);
      if (value) {
        return value;
      }
    }
    return normalizeSecretValue(await secrets().getKey(TAVILY_SECRET_PROVIDER));
  };
  const fetchImpl = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
  const verification = createProviderVerificationService({
    ...fetchImpl,
    env: options.env,
    readCredential: async (providerId) => {
      if (providerId !== TAVILY_SECRET_PROVIDER) {
        return await readCredential(providerId);
      }
      const key = await readTavilyKey();
      return key === undefined ? undefined : { key, type: 'api_key' };
    },
    verifySubscriptionSession: (providerId) => options.auth.verify(providerId),
  });
  const metadata = createOpenRouterModelMetadataService(fetchImpl);
  const providers = listProviders()
    .map(({ id }) => id)
    .filter((id): id is SupportedProvider => isSupportedProvider(id));
  return {
    openRouterModel: async (modelId) => {
      requireOpenRouterModelId(modelId);
      const credential = await readCredential('openrouter');
      if (!credential) {
        throw new Error('No API key configured for provider "openrouter".');
      }
      if (credential.type !== 'api_key') {
        throw new Error('The stored OpenRouter credential is not an API key.');
      }
      return await metadata.get(modelId, credential.key);
    },
    status: () =>
      readProviderStatus({
        env: options.env,
        envFileFailures: options.envFileFailures,
        envKeys: providerEnvKeys,
        providers,
        secrets,
      }),
    verify: async (providerId, origin) => {
      // The same desktop-only gate as a subscription run and auth/verify.
      if (
        findProviderDefinition(providerId)?.authType === 'oauth_subscription' &&
        origin !== 'desktop-ui'
      ) {
        throw new Error('A subscription sign-in can be verified only from the desktop app.');
      }
      return await verification.verify(providerId);
    },
  };
}
