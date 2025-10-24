import type { EmbeddingProviderType } from './provider-types';

const PROVIDER_SEPARATOR = '::';

export interface ParsedProviderModel {
  provider: EmbeddingProviderType;
  modelId: string;
}

export function formatProviderModelKey(provider: EmbeddingProviderType, modelId: string): string {
  return `${provider}${PROVIDER_SEPARATOR}${modelId}`;
}

export function parseProviderModelKey(
  composite: string | null | undefined
): ParsedProviderModel | null {
  if (!composite) {
    return null;
  }

  const [provider, modelId] = composite.split(PROVIDER_SEPARATOR);
  if (!provider || !modelId) {
    return null;
  }

  return {
    provider: provider as EmbeddingProviderType,
    modelId,
  };
}

export function isHostedProvider(
  provider: EmbeddingProviderType
): provider is Exclude<EmbeddingProviderType, 'local'> {
  return provider !== 'local';
}
