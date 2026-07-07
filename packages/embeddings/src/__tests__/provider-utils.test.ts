import { describe, expect, it } from 'vitest';
import {
  canonicalizeProviderModelKey,
  formatProviderModelKey,
  parseProviderModelKey,
} from '../provider-utils';

describe('parseProviderModelKey', () => {
  it('parses double-colon composite keys', () => {
    expect(parseProviderModelKey('local::jinaai/jina-embeddings-v2-base-code')).toEqual({
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      provider: 'local',
    });
  });

  it('parses legacy single-colon composites for backwards compatibility', () => {
    expect(parseProviderModelKey('local:jinaai/jina-embeddings-v2-base-code')).toEqual({
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      provider: 'local',
    });
  });

  it('returns null for invalid values', () => {
    expect(parseProviderModelKey('')).toBeNull();
    expect(parseProviderModelKey('local::')).toBeNull();
    expect(parseProviderModelKey('::model')).toBeNull();
  });
});

describe('canonicalizeProviderModelKey', () => {
  it('returns provider/model/composite triple for well-formed keys', () => {
    const result = canonicalizeProviderModelKey('openai::text-embedding-3-large');
    expect(result).toEqual({
      composite: 'openai::text-embedding-3-large',
      modelId: 'text-embedding-3-large',
      provider: 'openai',
    });
  });

  it('normalizes legacy single-colon values into the :: format', () => {
    const result = canonicalizeProviderModelKey('local:jinaai/jina-embeddings-v2-base-code');
    expect(result).toEqual({
      composite: formatProviderModelKey('local', 'jinaai/jina-embeddings-v2-base-code'),
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      provider: 'local',
    });
  });

  it('infers provider from hint when composite lacks namespace', () => {
    const result = canonicalizeProviderModelKey('bge-m3', 'local');
    expect(result).toEqual({
      composite: formatProviderModelKey('local', 'bge-m3'),
      modelId: 'bge-m3',
      provider: 'local',
    });
  });

  it('returns null for missing model identifiers', () => {
    expect(canonicalizeProviderModelKey('   ', 'local')).toBeNull();
  });
});
