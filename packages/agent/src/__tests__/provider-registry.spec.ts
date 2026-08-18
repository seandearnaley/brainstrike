import { describe, expect, it } from 'vitest';
import {
  getProviderDefinition,
  listEmbeddingModels,
  listProviders,
  providerEnvKeys,
  STANDARD_EMBEDDING_DIMENSION,
  type SupportedProvider,
  supportsStandardEmbeddingDimension,
} from '../providers/types';

describe('provider registry metadata', () => {
  it('lists all supported providers with display names', () => {
    const providers = listProviders();
    // 11 since BST-1356 added `openai-codex` (ChatGPT subscription).
    expect(providers).toHaveLength(11);

    for (const provider of providers) {
      expect(typeof provider.displayName).toBe('string');
      expect(provider.displayName.length).toBeGreaterThan(0);
    }
  });

  it.each<SupportedProvider>(['openai', 'google'])(
    '%s embedding models support the standard dimension',
    (provider) => {
      expect(supportsStandardEmbeddingDimension(provider)).toBe(true);

      const embeddingModels = listEmbeddingModels(provider);
      expect(embeddingModels.length).toBeGreaterThan(0);
      const matching = embeddingModels.filter((model) => model.supportsStandardDimension);
      expect(matching.length).toBeGreaterThan(0);
      for (const model of matching) {
        if (!model.supportsCustomDimensions) {
          expect(model.availableDimensions?.includes(STANDARD_EMBEDDING_DIMENSION)).toBe(true);
        }
      }
    }
  );

  it('openrouter is flagged as not supporting embeddings', () => {
    const definition = getProviderDefinition('openrouter');
    expect(definition.capabilities.embeddings).toBe(false);
    expect(supportsStandardEmbeddingDimension('openrouter')).toBe(false);
    expect(listEmbeddingModels('openrouter')).toHaveLength(0);
  });

  it('surface provider environment key precedence', () => {
    // BST-1361: exactly two names — app-scoped override first, vendor second.
    expect(providerEnvKeys('openai')).toEqual(['BRAINSTRIKE_OPENAI_API_KEY', 'OPENAI_API_KEY']);
    expect(providerEnvKeys('anthropic')).toEqual([
      'BRAINSTRIKE_ANTHROPIC_API_KEY',
      'ANTHROPIC_API_KEY',
    ]);
    expect(providerEnvKeys('google')).toEqual([
      'BRAINSTRIKE_GOOGLE_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
    ]);
    // BST-1350: bedrock keeps the same override-first order; the vendor name
    // is AWS's documented bearer variable for Bedrock API keys.
    expect(providerEnvKeys('bedrock')).toEqual([
      'BRAINSTRIKE_BEDROCK_API_KEY',
      'AWS_BEARER_TOKEN_BEDROCK',
    ]);
  });
});
