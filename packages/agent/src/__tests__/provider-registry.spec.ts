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
    expect(providers).toHaveLength(9);

    for (const provider of providers) {
      expect(typeof provider.displayName).toBe('string');
      expect(provider.displayName.length).toBeGreaterThan(0);
    }
  });

  it.each<SupportedProvider>([
    'openai',
    'google',
  ])('%s embedding models support the standard dimension', (provider) => {
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
  });

  it('openrouter is flagged as not supporting embeddings', () => {
    const definition = getProviderDefinition('openrouter');
    expect(definition.capabilities.embeddings).toBe(false);
    expect(supportsStandardEmbeddingDimension('openrouter')).toBe(false);
    expect(listEmbeddingModels('openrouter')).toHaveLength(0);
  });

  it('surface provider environment key precedence', () => {
    const envKeys = providerEnvKeys('openai');
    expect(envKeys[0]).toBe('BRAINSTRIKE_OPENAI_API_KEY');
    expect(envKeys[1]).toBe('BS_OPENAI_API_KEY');
    expect(envKeys).toContain('OPENAI_API_KEY');
    expect(envKeys).toContain('AI_OPENAI_API_KEY');
  });
});
