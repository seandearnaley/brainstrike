import { describe, expect, it } from 'vitest';
import {
  canonicalizeProviderModelKey,
  formatProviderModelKey,
  parseProviderModelKey,
} from '../provider-utils.js';

describe('parseProviderModelKey', () => {
  it('parses double-colon composite keys', () => {
    expect(parseProviderModelKey('voyage::voyage-code-3')).toEqual({
      modelId: 'voyage-code-3',
      provider: 'voyage',
    });
  });

  it('parses legacy single-colon composites for backwards compatibility', () => {
    expect(parseProviderModelKey('voyage:voyage-code-3')).toEqual({
      modelId: 'voyage-code-3',
      provider: 'voyage',
    });
  });

  it('returns null for invalid values', () => {
    expect(parseProviderModelKey('')).toBeNull();
    expect(parseProviderModelKey('voyage::')).toBeNull();
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
    const result = canonicalizeProviderModelKey('voyage:voyage-code-3');
    expect(result).toEqual({
      composite: formatProviderModelKey('voyage', 'voyage-code-3'),
      modelId: 'voyage-code-3',
      provider: 'voyage',
    });
  });

  it('infers provider from hint when composite lacks namespace', () => {
    const result = canonicalizeProviderModelKey('text-embedding-3-small', 'openai');
    expect(result).toEqual({
      composite: formatProviderModelKey('openai', 'text-embedding-3-small'),
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    });
  });

  it('returns null for missing model identifiers', () => {
    expect(canonicalizeProviderModelKey('   ', 'openai')).toBeNull();
  });
});
