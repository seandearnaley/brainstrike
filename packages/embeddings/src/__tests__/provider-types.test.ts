import { describe, expect, it } from 'vitest';
import { type EmbeddingProviderType, isLocalProviderType } from '../provider-types';
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
  });

  it('isHostedProvider mirrors local classification', () => {
    expect(isHostedProvider('local')).toBe(false);
    expect(isHostedProvider('transformers')).toBe(false);
    expect(isHostedProvider('openai')).toBe(true);
    expect(isHostedProvider('google')).toBe(true);
    expect(isHostedProvider('cohere')).toBe(true);
    expect(isHostedProvider('voyage')).toBe(true);
  });

  it('handles all provider variants without throwing', () => {
    const providers: EmbeddingProviderType[] = [
      'local',
      'transformers',
      'openai',
      'google',
      'cohere',
      'voyage',
    ];

    for (const provider of providers) {
      expect(() => isLocalProviderType(provider)).not.toThrow();
      expect(() => isHostedProvider(provider)).not.toThrow();
    }
  });
});
