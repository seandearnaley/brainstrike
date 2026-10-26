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
    expect(resolveModelPricing('google', 'gemini-embedding-001')).toBeUndefined();
    expect(resolveModelPricing('cohere', 'embed-english-v3.0')).toBeUndefined();
  });

  it('keeps a chat model’s own catalog pricing', () => {
    expect(resolveModelPricing('openai', 'gpt-6-astra')).toMatchObject({
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
  });
});
