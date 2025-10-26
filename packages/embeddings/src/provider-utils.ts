import type { EmbeddingProviderType } from './provider-types';

const PROVIDER_SEPARATOR = '::';
const LEGACY_SEPARATOR = ':';

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

  if (composite.includes(PROVIDER_SEPARATOR)) {
    const [provider, modelId] = composite.split(PROVIDER_SEPARATOR);
    if (!provider || !modelId) {
      return null;
    }
    return {
      provider: provider as EmbeddingProviderType,
      modelId,
    };
  }

  const legacyIndex = composite.indexOf(LEGACY_SEPARATOR);
  if (legacyIndex > 0 && legacyIndex < composite.length - 1) {
    const provider = composite.slice(0, legacyIndex) as EmbeddingProviderType;
    const modelId = composite.slice(legacyIndex + 1);
    if (provider && modelId) {
      return { provider, modelId };
    }
  }

  return null;
}

export function isHostedProvider(
  provider: EmbeddingProviderType
): provider is Exclude<EmbeddingProviderType, 'local'> {
  return provider !== 'local';
}

export function canonicalizeProviderModelKey(
  modelKey: string | null | undefined,
  providerHint?: EmbeddingProviderType
): { provider: EmbeddingProviderType; modelId: string; composite: string } | null {
  const parsed = parseProviderModelKey(modelKey);
  const provider = parsed?.provider ?? providerHint ?? 'local';
  const rawModelId = parsed?.modelId ?? modelKey ?? '';
  const modelId = rawModelId.trim();
  if (!modelId) {
    return null;
  }
  const composite = formatProviderModelKey(provider, modelId);
  return { provider, modelId, composite };
}
