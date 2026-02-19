import { describe, expect, it } from 'vitest';
import {
  type EmbeddingProviderType,
  hostedProviderRequiresApiKey,
  isLocalProviderType,
} from '../provider-types';
import { isHostedProvider } from '../provider-utils';

describe('provider-types', () => {
  it('classifies local providers', () => {
    expect(isLocalProviderType('local')).toBe(true);
    expect(isLocalProviderType('transformers')).toBe(true);
  });

  it('classifies hosted providers', () => {
    expect(isLocalProviderType('openai')).toBe(false);
    expect(isLocalProviderType('google')).toBe(false);
    expect(isLocalProviderType('cohere')).toBe(false);
    expect(isLocalProviderType('voyage')).toBe(false);
    expect(isLocalProviderType('ollama')).toBe(false);
    expect(isLocalProviderType('lmstudio')).toBe(false);
  });

  it('isHostedProvider mirrors local classification', () => {
    expect(isHostedProvider('local')).toBe(false);
    expect(isHostedProvider('transformers')).toBe(false);
    expect(isHostedProvider('openai')).toBe(true);
    expect(isHostedProvider('google')).toBe(true);
    expect(isHostedProvider('cohere')).toBe(true);
    expect(isHostedProvider('voyage')).toBe(true);
    expect(isHostedProvider('ollama')).toBe(true);
    expect(isHostedProvider('lmstudio')).toBe(true);
  });

  it('identifies hosted providers that do not require API keys', () => {
    expect(hostedProviderRequiresApiKey('openai')).toBe(true);
    expect(hostedProviderRequiresApiKey('google')).toBe(true);
    expect(hostedProviderRequiresApiKey('cohere')).toBe(true);
    expect(hostedProviderRequiresApiKey('voyage')).toBe(true);
    expect(hostedProviderRequiresApiKey('ollama')).toBe(false);
    expect(hostedProviderRequiresApiKey('lmstudio')).toBe(false);
  });

  it('handles all provider variants without throwing', () => {
    const providers: EmbeddingProviderType[] = [
      'local',
      'transformers',
      'openai',
      'google',
      'cohere',
      'voyage',
      'ollama',
      'lmstudio',
    ];

    for (const provider of providers) {
      expect(() => isLocalProviderType(provider)).not.toThrow();
      expect(() => isHostedProvider(provider)).not.toThrow();
    }
  });
});
