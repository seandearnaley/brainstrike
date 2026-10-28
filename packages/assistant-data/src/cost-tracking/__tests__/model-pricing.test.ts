import { resolveDefaultModel } from '@brainstrike/assistant-contract/provider-registry';
import { buildTokenUsageCounts, computeCost } from '@brainstrike/tokenization';
import { describe, expect, it } from 'vitest';
import { resolveModelPricing } from '../model-pricing';

describe('resolveModelPricing', () => {
  it('prices a hosted memory embedder’s input tokens, and no output (BST-2226)', () => {
    expect(resolveModelPricing('openai', 'text-embedding-3-small')).toEqual({
      inputPerMTok: 0.02,
      outputPerMTok: 0,
    });
    expect(resolveModelPricing('openai', 'text-embedding-3-large')).toEqual({
      inputPerMTok: 0.13,
      outputPerMTok: 0,
    });
  });

  it('leaves an embedder without an official price unpriced, never $0', () => {
    expect(resolveModelPricing('cohere', 'embed-english-v3.0')).toBeUndefined();
  });

  it('prices the default Gemini embedder, so memory embedding never blanks a thread cost', () => {
    expect(resolveModelPricing('google', 'gemini-embedding-001')).toEqual({
      inputPerMTok: 0.15,
      outputPerMTok: 0,
    });
  });

  // Every chat provider caches prompts (automatically or through our
  // breakpoints) and reports the cached share; a default model without a
  // cache-read rate turned every cached turn into "cost unavailable".
  it.each(['openai', 'anthropic', 'google', 'openrouter', 'bedrock'] as const)(
    'prices a partly cached turn on the %s default model',
    (provider) => {
      const model = resolveDefaultModel(provider) ?? '';
      const cost = computeCost(
        buildTokenUsageCounts(100_000, 2000, 80_000),
        resolveModelPricing(provider, model)
      );
      expect(cost, `${provider}/${model}`).toMatchObject({ available: true });
    }
  );

  it('keeps a chat model’s own catalog pricing', () => {
    expect(resolveModelPricing('openai', 'gpt-6-astra')).toMatchObject({
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
  });
});
