import { describe, expect, it } from 'vitest';
import { resolveTokenMeasurementCapability } from '../provider-registry.js';

describe('provider token measurement capabilities', () => {
  it('declares the current direct OpenAI models against the local o200k reference', () => {
    expect(resolveTokenMeasurementCapability('openai', 'gpt-5.6-terra')).toEqual({
      mode: 'declared-compatible-reference',
      tokenizer: 'o200k_base',
    });
  });

  it('uses an exact selected-model tokenizer only for an explicit verified mapping', () => {
    expect(resolveTokenMeasurementCapability('openai', 'gpt-4o')).toEqual({
      mode: 'exact-selected-model',
      tokenizer: 'o200k_base',
    });
  });

  it.each([
    ['anthropic', 'claude-sonnet-5'],
    ['google', 'gemini-3.5-flash'],
    ['openrouter', 'openai/gpt-5.6-terra'],
    ['openai', 'prefix-gpt-4o-suffix'],
    ['openai', 'gpt-4o-compatible'],
    ['unknown-provider', 'gpt-4o'],
  ])('keeps %s/%s on the explicit deterministic backstop', (provider, model) => {
    expect(resolveTokenMeasurementCapability(provider, model)).toEqual({
      charactersPerToken: 4,
      mode: 'deterministic-serialized-character-backstop',
    });
  });
});
