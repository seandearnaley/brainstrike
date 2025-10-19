import {
  type EmbeddingModelDefinition,
  getProviderDefinition,
  getProviderEnvKeys,
  listProviderEmbeddingModels,
  listProviderLlmModels,
  listProviderModels,
  listProviders,
  type ProviderCapabilities,
  type ProviderDefinition,
  type ProviderId,
  type ProviderModelDefinition,
  type ProviderModelType,
  type ProviderRuntime,
  providerSupportsStandardEmbeddingDimension,
  resolveDefaultModel,
  STANDARD_EMBEDDING_DIMENSION,
} from './registry';

export type SupportedProvider = ProviderId;
export type {
  ProviderRuntime,
  ProviderDefinition,
  ProviderModelDefinition,
  ProviderModelType,
  ProviderCapabilities,
};
export { STANDARD_EMBEDDING_DIMENSION };

const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = listProviders().map(
  (provider) => provider.id
);

export const PROVIDER_DISPLAY_NAMES: Record<SupportedProvider, string> = SUPPORTED_PROVIDERS.reduce(
  (acc, providerId) => {
    acc[providerId] = getProviderDefinition(providerId).displayName;
    return acc;
  },
  {} as Record<SupportedProvider, string>
);

export const PROVIDER_MODELS: Record<SupportedProvider, readonly string[]> =
  SUPPORTED_PROVIDERS.reduce(
    (acc, providerId) => {
      acc[providerId] = listProviderLlmModels(providerId).map((model) => model.id);
      return acc;
    },
    {} as Record<SupportedProvider, readonly string[]>
  );

export const PROVIDER_DEFAULT_MODELS: Record<SupportedProvider, string> =
  SUPPORTED_PROVIDERS.reduce(
    (acc, providerId) => {
      const resolved = resolveDefaultModel(providerId);
      if (resolved) {
        acc[providerId] = resolved;
      }
      return acc;
    },
    {} as Record<SupportedProvider, string>
  );

export function isSupportedProvider(provider: string | undefined): provider is SupportedProvider {
  if (!provider) return false;
  return SUPPORTED_PROVIDERS.includes(provider as SupportedProvider);
}

export function getProviderDisplayName(provider: SupportedProvider | string): string {
  if (isSupportedProvider(provider)) {
    return PROVIDER_DISPLAY_NAMES[provider];
  }
  return provider;
}

export function getProviderModels(provider: SupportedProvider | string): readonly string[] {
  if (isSupportedProvider(provider)) {
    return PROVIDER_MODELS[provider];
  }
  return [];
}

export function getProviderDefaultModel(provider: SupportedProvider | string): string | undefined {
  if (isSupportedProvider(provider)) {
    return PROVIDER_DEFAULT_MODELS[provider];
  }
  return undefined;
}

export function isValidModelForProvider(
  provider: SupportedProvider | string,
  model: string
): boolean {
  return getProviderModels(provider).includes(model);
}

export function listEmbeddingModels(
  provider: SupportedProvider
): readonly EmbeddingModelDefinition[] {
  return listProviderEmbeddingModels(provider);
}

export function providerEnvKeys(provider: SupportedProvider): readonly string[] {
  return getProviderEnvKeys(provider);
}

export function supportsStandardEmbeddingDimension(provider: SupportedProvider): boolean {
  return providerSupportsStandardEmbeddingDimension(provider);
}

export function getProviderModelDefinitions(
  provider: SupportedProvider
): readonly ProviderModelDefinition[] {
  return listProviderModels(provider);
}

export { getProviderDefinition, listProviders } from './registry';
