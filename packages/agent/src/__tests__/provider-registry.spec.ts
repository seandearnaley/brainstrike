import {
  getProviderDefinition,
  listProviders,
  providerEnvKeys,
} from '@brainstrike/assistant-contract/provider-metadata';
import { describe, expect, it } from 'vitest';

describe('provider registry metadata', () => {
  it('lists every supported provider once, each with a display name', () => {
    const providers = listProviders();
    expect(new Set(providers.map((provider) => provider.id)).size).toBe(providers.length);

    for (const provider of providers) {
      expect(typeof provider.displayName).toBe('string');
      expect(provider.displayName.length).toBeGreaterThan(0);
    }
  });

  it('openrouter is flagged as not supporting embeddings', () => {
    const definition = getProviderDefinition('openrouter');
    expect(definition.capabilities.embeddings).toBe(false);
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
