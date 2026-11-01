import { describe, expect, it } from 'vitest';
import {
  canonicalizeProviderModelKey,
  formatProviderModelKey,
  parseProviderModelKey,
} from '../index.js';

describe('provider-model-key', () => {
  it('formats provider/model ids with the canonical separator', () => {
    expect(formatProviderModelKey('openai', 'gpt-5-mini')).toBe('openai::gpt-5-mini');
  });

  it('parses canonical composite keys', () => {
    expect(parseProviderModelKey('openai::gpt-5-mini')).toEqual({
      modelId: 'gpt-5-mini',
      provider: 'openai',
    });
  });

  it('parses legacy provider:model keys', () => {
    expect(parseProviderModelKey('google:gemini-2.5-pro')).toEqual({
      modelId: 'gemini-2.5-pro',
      provider: 'google',
    });
  });

  it('rejects empty or malformed composite keys', () => {
    expect(parseProviderModelKey('')).toBeNull();
    expect(parseProviderModelKey('openai::')).toBeNull();
    expect(parseProviderModelKey('::gpt-5-mini')).toBeNull();
    expect(parseProviderModelKey('gpt-5-mini')).toBeNull();
  });

  it('canonicalizes composite keys without changing valid values', () => {
    expect(canonicalizeProviderModelKey('openai::gpt-5-mini')).toEqual({
      composite: 'openai::gpt-5-mini',
      modelId: 'gpt-5-mini',
      provider: 'openai',
    });
  });

  it('canonicalizes raw model ids using the provider hint or fallback provider', () => {
    expect(
      canonicalizeProviderModelKey('gemini-2.5-pro', {
        providerHint: 'google',
      })
    ).toEqual({
      composite: 'google::gemini-2.5-pro',
      modelId: 'gemini-2.5-pro',
      provider: 'google',
    });

    expect(
      canonicalizeProviderModelKey('gpt-5-mini', {
        fallbackProvider: 'openai',
      })
    ).toEqual({
      composite: 'openai::gpt-5-mini',
      modelId: 'gpt-5-mini',
      provider: 'openai',
    });
  });

  it('returns null when canonicalization has neither a provider nor a model id', () => {
    expect(canonicalizeProviderModelKey(null)).toBeNull();
    expect(canonicalizeProviderModelKey('   ', { fallbackProvider: 'openai' })).toBeNull();
  });
});
