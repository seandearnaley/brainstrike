import { describe, expect, it } from 'vitest';
import {
  canonicalizeProviderModelKey,
  formatProviderModelKey,
  parseProviderModelKey,
} from '../provider-utils';

describe('parseProviderModelKey', () => {
  it('parses double-colon composite keys', () => {
    expect(parseProviderModelKey('local::jina-code')).toEqual({
      provider: 'local',
      modelId: 'jina-code',
    });
  });

  it('parses legacy single-colon composites for backwards compatibility', () => {
    expect(parseProviderModelKey('local:jina-code')).toEqual({
      provider: 'local',
      modelId: 'jina-code',
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
      provider: 'openai',
      modelId: 'text-embedding-3-large',
      composite: 'openai::text-embedding-3-large',
    });
  });

  it('normalizes legacy single-colon values into the :: format', () => {
    const result = canonicalizeProviderModelKey('local:jina-code');
    expect(result).toEqual({
      provider: 'local',
      modelId: 'jina-code',
      composite: formatProviderModelKey('local', 'jina-code'),
    });
  });

  it('infers provider from hint when composite lacks namespace', () => {
    const result = canonicalizeProviderModelKey('bge-m3', 'local');
    expect(result).toEqual({
      provider: 'local',
      modelId: 'bge-m3',
      composite: formatProviderModelKey('local', 'bge-m3'),
    });
  });

  it('returns null for missing model identifiers', () => {
    expect(canonicalizeProviderModelKey('   ', 'local')).toBeNull();
  });
});
