import { resolveDefaultModel } from '@brainstrike/assistant-contract/provider-registry';
import { buildTokenUsageCounts, computeCost } from '@brainstrike/tokenization';
import { describe, expect, it } from 'vitest';
import { resolveModelPricing } from '../model-pricing';

describe('resolveModelPricing', () => {
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
