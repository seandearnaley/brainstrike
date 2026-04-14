import {
  canonicalizeProviderModelKey as canonicalizeSharedProviderModelKey,
  formatProviderModelKey as formatSharedProviderModelKey,
  parseProviderModelKey as parseSharedProviderModelKey,
} from '@brainstrike/utils';
import type { EmbeddingProviderType, HostedProviderType } from './provider-types';
import { isLocalProviderType } from './provider-types';

export interface ParsedProviderModel {
  modelId: string;
  provider: EmbeddingProviderType;
}

export function formatProviderModelKey(provider: EmbeddingProviderType, modelId: string): string {
  return formatSharedProviderModelKey(provider, modelId);
}

export function parseProviderModelKey(
  composite: string | null | undefined
): ParsedProviderModel | null {
  return parseSharedProviderModelKey<EmbeddingProviderType>(composite);
}

/**
 * Check if a provider is a hosted provider (requires API key, runs on remote servers)
 * Returns false for 'local' and 'transformers' (both use transformers.js in browser)
 */
export function isHostedProvider(provider: EmbeddingProviderType): provider is HostedProviderType {
  return !isLocalProviderType(provider);
}

export function canonicalizeProviderModelKey(
  modelKey: string | null | undefined,
  providerHint?: EmbeddingProviderType
): { provider: EmbeddingProviderType; modelId: string; composite: string } | null {
  const options = providerHint
    ? { providerHint, fallbackProvider: 'local' as const }
    : { fallbackProvider: 'local' as const };
  return canonicalizeSharedProviderModelKey<EmbeddingProviderType>(modelKey, {
    ...options,
  });
}
