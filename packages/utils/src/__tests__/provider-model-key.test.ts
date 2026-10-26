import { describe, expect, it } from 'vitest';
import {
  canonicalizeProviderModelKey,
  formatProviderModelKey,
  parseProviderModelKey,
} from '../index.js';

describe('provider-model-key', () => {
  it('formats provider/model ids with the canonical separator', () => {
    expect(formatProviderModelKey('openai', 'text-embedding-3-small')).toBe(
      'openai::text-embedding-3-small'
    );
  });

  it('parses canonical composite keys', () => {
    expect(parseProviderModelKey('openai::text-embedding-3-small')).toEqual({
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    });
  });

  it('parses legacy provider:model keys', () => {
    expect(parseProviderModelKey('voyage:voyage-3')).toEqual({
      modelId: 'voyage-3',
      provider: 'voyage',
    });
  });

  it('rejects empty or malformed composite keys', () => {
    expect(parseProviderModelKey('')).toBeNull();
    expect(parseProviderModelKey('openai::')).toBeNull();
    expect(parseProviderModelKey('::text-embedding-3-small')).toBeNull();
    expect(parseProviderModelKey('text-embedding-3-small')).toBeNull();
  });

  it('canonicalizes composite keys without changing valid values', () => {
    expect(canonicalizeProviderModelKey('openai::text-embedding-3-small')).toEqual({
      composite: 'openai::text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    });
  });

  it('canonicalizes raw model ids using the provider hint or fallback provider', () => {
    expect(
      canonicalizeProviderModelKey('voyage-3', {
        providerHint: 'voyage',
      })
    ).toEqual({
      composite: 'voyage::voyage-3',
      modelId: 'voyage-3',
      provider: 'voyage',
    });

    expect(
      canonicalizeProviderModelKey('text-embedding-3-small', {
        fallbackProvider: 'openai',
      })
    ).toEqual({
      composite: 'openai::text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    });
  });

  it('returns null when canonicalization has neither a provider nor a model id', () => {
    expect(canonicalizeProviderModelKey(null)).toBeNull();
    expect(canonicalizeProviderModelKey('   ', { fallbackProvider: 'openai' })).toBeNull();
  });
});
