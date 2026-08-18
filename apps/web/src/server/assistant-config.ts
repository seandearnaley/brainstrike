import {
  type DeprecatedEnvVarReport,
  detectDeprecatedProviderEnvVars,
  PROVIDER_DEFAULT_MODELS,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/agent/hosted-web';

export const HOSTED_WEB_ASSISTANT_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
] as const satisfies readonly SupportedProvider[];

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
  /**
   * Deprecated env names set in THIS server's environment (BST-1361), with
   * the canonical rename. Names only — values never cross the wire. Limited
   * to Hosted Web providers; omitted when nothing deprecated is set.
   */
  deprecatedEnvVars?: readonly DeprecatedEnvVarReport[];
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
  return HOSTED_WEB_ASSISTANT_PROVIDERS.map((provider) => {
    const config = resolveConfig(provider);
    if (config.provider !== provider) {
      throw new Error(
        `Hosted Web provider resolver returned ${String(config.provider)} for ${provider}`
      );
    }
    return config;
  }).filter(isConfiguredAssistantProvider);
}

export function resolveHostedWebAssistantStatus(
  resolveConfig: (
    provider: HostedWebAssistantProvider
  ) => AssistantProviderConfig = resolveAssistantProviderConfig
): HostedWebAssistantStatusPayload {
  // BST-1361: rename warnings for deprecated env names, computed from this
  // server's own environment and restricted to the Hosted Web provider set.
  const deprecatedReports = detectDeprecatedProviderEnvVars(process.env).filter((report) =>
    isHostedWebAssistantProvider(report.provider)
  );
  const deprecatedEnvVars =
    deprecatedReports.length > 0 ? { deprecatedEnvVars: deprecatedReports } : {};

  const configuredProviders = resolveAssistantProviderConfigs(resolveConfig);
  const primary = configuredProviders[0];
  if (!primary) {
    return { ...deprecatedEnvVars, enabled: false, reason: 'missing_api_key' };
  }

  return {
    ...deprecatedEnvVars,
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
