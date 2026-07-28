import {
  PROVIDER_DEFAULT_MODELS,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/agent/hosted-web';

export const HOSTED_WEB_ASSISTANT_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
] as const;

export type HostedWebAssistantProvider = (typeof HOSTED_WEB_ASSISTANT_PROVIDERS)[number];

const HOSTED_WEB_ASSISTANT_PROVIDER_SET: ReadonlySet<string> = new Set(
  HOSTED_WEB_ASSISTANT_PROVIDERS
);

export function isHostedWebAssistantProvider(
  provider: string
): provider is HostedWebAssistantProvider {
  return HOSTED_WEB_ASSISTANT_PROVIDER_SET.has(provider);
}

export function resolveHostedWebAssistantModel(provider: HostedWebAssistantProvider): string {
  const model = PROVIDER_DEFAULT_MODELS[provider];
  if (!model) {
    throw new Error(`Hosted Web provider ${provider} has no default model`);
  }
  return model;
}

export interface AssistantProviderConfig {
  apiKey?: string;
  disabledReason?: 'missing_api_key';
  enabled: boolean;
  provider?: HostedWebAssistantProvider;
  source?: string;
}

export interface ConfiguredAssistantProviderConfig extends AssistantProviderConfig {
  apiKey: string;
  enabled: true;
  provider: HostedWebAssistantProvider;
}

export interface HostedWebAssistantStatusPayload {
  enabled: boolean;
  model?: string;
  provider?: HostedWebAssistantProvider;
  providerKeySources?: readonly {
    envVar: string;
    provider: HostedWebAssistantProvider;
    source: 'env';
  }[];
  providers?: readonly HostedWebAssistantProvider[];
  reason?: 'missing_api_key';
}

function readEnvVar(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') {
    return;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveAssistantProviderConfig(
  provider: HostedWebAssistantProvider = 'openai'
): AssistantProviderConfig {
  for (const name of providerEnvKeys(provider satisfies SupportedProvider)) {
    const value = readEnvVar(name);
    if (value) {
      return { apiKey: value, enabled: true, provider, source: name };
    }
  }
  return { disabledReason: 'missing_api_key', enabled: false, provider };
}

export function resolveAssistantProviderConfigs(
  resolveConfig: (
    provider: HostedWebAssistantProvider
  ) => AssistantProviderConfig = resolveAssistantProviderConfig
): readonly ConfiguredAssistantProviderConfig[] {
  return HOSTED_WEB_ASSISTANT_PROVIDERS.map((provider) => ({
    ...resolveConfig(provider),
    provider,
  })).filter(isConfiguredAssistantProvider);
}

export function resolveHostedWebAssistantStatus(
  resolveConfig: (
    provider: HostedWebAssistantProvider
  ) => AssistantProviderConfig = resolveAssistantProviderConfig
): HostedWebAssistantStatusPayload {
  const configuredProviders = resolveAssistantProviderConfigs(resolveConfig);
  const primary = configuredProviders[0];
  if (!primary) {
    return { enabled: false, reason: 'missing_api_key' };
  }

  return {
    enabled: true,
    model: resolveHostedWebAssistantModel(primary.provider),
    provider: primary.provider,
    providerKeySources: configuredProviders.map((config) => {
      if (!config.source) {
        throw new Error(`Hosted Web provider ${config.provider} is missing its credential source`);
      }
      return {
        envVar: config.source,
        provider: config.provider,
        source: 'env' as const,
      };
    }),
    providers: configuredProviders.map(({ provider }) => provider),
  };
}

function isConfiguredAssistantProvider(
  config: AssistantProviderConfig
): config is ConfiguredAssistantProviderConfig {
  return Boolean(config.enabled && config.apiKey && config.provider);
}

export function getAssistantApiKey(
  provider: HostedWebAssistantProvider = 'openai'
): string | undefined {
  return resolveAssistantProviderConfig(provider).apiKey;
}
