import type { HostEnvFileFailure, HostProviderService } from '@brainstrike/agent-host';
import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import {
  isSupportedProvider,
  listProviders,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import { createTavilyKeyResolver } from './native-tools/web-search-tool.ts';
import {
  createOpenRouterModelMetadataService,
  requireOpenRouterModelId,
} from './openrouter-model-metadata.ts';
import type { HostAuthority } from './provider-auth/host-authority.ts';
import { createProviderCredentialReader } from './provider-credentials.ts';
import { readProviderStatus } from './provider-status.ts';
import {
  createProviderVerificationService,
  TAVILY_SECRET_PROVIDER,
} from './provider-verification.ts';
import { leaveOnAbort } from './shared-flight.ts';

export interface HostProviderServicesOptions {
  readonly auth: Pick<HostAuthority, 'secrets'>;
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
  const secrets = (): SecretsService => options.auth.secrets();
  const readCredential = createProviderCredentialReader(
    { getCredential: (provider) => secrets().getCredential(provider) },
    options.env
  );
  // The same reader as host-executed web search: env first, then the gated store.
  const readTavilyKey = createTavilyKeyResolver(options.env, (account) =>
    secrets().getKey(account)
  );
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
  });
  const metadata = createOpenRouterModelMetadataService({ ...fetchImpl, env: options.env });
  const providers = listProviders()
    .map(({ id }) => id)
    .filter((id): id is SupportedProvider => isSupportedProvider(id));
  return {
    openRouterModel: async (modelId, signal) => {
      requireOpenRouterModelId(modelId);
      const credential = await leaveOnAbort(() => readCredential('openrouter'), signal);
      if (!credential) {
        throw new Error('No API key configured for provider "openrouter".');
      }
      if (credential.type !== 'api_key') {
        throw new Error('The stored OpenRouter credential is not an API key.');
      }
      return await metadata.get(modelId, credential.key, signal);
    },
    status: () =>
      readProviderStatus({
        env: options.env,
        envFileFailures: options.envFileFailures,
        envKeys: providerEnvKeys,
        providers,
        secrets,
      }),
    verify: async (providerId, signal) => await verification.verify(providerId, signal),
  };
}
