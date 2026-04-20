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
  ProviderCapabilities,
  ProviderDefinition,
  ProviderModelDefinition,
  ProviderModelType,
  ProviderRuntime,
};
export { STANDARD_EMBEDDING_DIMENSION };

const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = listProviders().map(
  (provider) => provider.id
);

/** Type-safe builder for provider-keyed records from the exhaustive provider list. */
function buildProviderRecord<V>(fn: (id: SupportedProvider) => V): Record<SupportedProvider, V> {
  const entries: [SupportedProvider, V][] = SUPPORTED_PROVIDERS.map((id) => [id, fn(id)]);
  return Object.fromEntries(entries) as Record<SupportedProvider, V>;
}

export const PROVIDER_DISPLAY_NAMES: Record<SupportedProvider, string> = buildProviderRecord(
  (id) => getProviderDefinition(id).displayName
);

export const PROVIDER_MODELS: Record<SupportedProvider, readonly string[]> = buildProviderRecord(
  (id) => listProviderLlmModels(id).map((model) => model.id)
);

export const PROVIDER_DEFAULT_MODELS = Object.fromEntries(
  SUPPORTED_PROVIDERS.map((id) => [id, resolveDefaultModel(id)] as const).filter(
    (pair): pair is [SupportedProvider, string] => pair[1] !== undefined
  )
) as Partial<Record<SupportedProvider, string>>;

/**
 * Models that should be enabled by default (those with `default: true` in registry).
 * Used by assistant-preferences-store for initial state.
 * Unlike PROVIDER_MODELS which lists ALL models, this only includes default ones.
 */
export const PROVIDER_DEFAULT_ENABLED_MODELS: Record<SupportedProvider, readonly string[]> =
  buildProviderRecord((id) =>
    listProviderLlmModels(id)
      .filter((model) => model.default)
      .map((model) => model.id)
  );

const SUPPORTED_PROVIDER_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_PROVIDERS);

export function isSupportedProvider(provider: string | undefined): provider is SupportedProvider {
  if (!provider) {
    return false;
  }
  return SUPPORTED_PROVIDER_SET.has(provider);
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
  return;
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
