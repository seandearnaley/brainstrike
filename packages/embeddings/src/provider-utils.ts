import {
  canonicalizeEmbeddingProviderModelKey,
  formatEmbeddingProviderModelKey,
  isHostedProvider,
  type ParsedEmbeddingProviderModel,
  parseEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import type { EmbeddingProviderType } from './provider-types';

export type ParsedProviderModel = ParsedEmbeddingProviderModel;

export function formatProviderModelKey(provider: EmbeddingProviderType, modelId: string): string {
  return formatEmbeddingProviderModelKey(provider, modelId);
}

export function parseProviderModelKey(
  composite: string | null | undefined
): ParsedProviderModel | null {
  return parseEmbeddingProviderModelKey(composite);
}

export { isHostedProvider };

export function canonicalizeProviderModelKey(
  modelKey: string | null | undefined,
  providerHint?: EmbeddingProviderType
): { provider: EmbeddingProviderType; modelId: string; composite: string } | null {
  return canonicalizeEmbeddingProviderModelKey(modelKey, providerHint);
}
