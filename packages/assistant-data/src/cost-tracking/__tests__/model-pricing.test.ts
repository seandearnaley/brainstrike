import { resolveDefaultModel } from '@brainstrike/assistant-contract/provider-registry';
import { buildTokenUsageCounts, computeCost } from '@brainstrike/tokenization';
import { describe, expect, it } from 'vitest';
import { resolveModelPricing } from '../model-pricing';

const NOV_20_2026 = Date.UTC(2026, 10, 20);
const DEC_1_2026 = Date.UTC(2026, 11, 1);

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
        resolveModelPricing(provider, model, NOV_20_2026)
      );
      expect(cost, `${provider}/${model}`).toMatchObject({ available: true });
    }
  );

  it('keeps a chat model’s own catalog pricing', () => {
    expect(resolveModelPricing('openai', 'gpt-6-astra', NOV_20_2026)).toMatchObject({
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
  });

  // Gemini 4 Argon's introductory rates end on 2026-11-30 (Google's latest-model page).
  it('prices a call at the rates in force on the day it ran', () => {
    const before = { cacheReadPerMTok: 0.1, inputPerMTok: 2, outputPerMTok: 10 };
    const after = { cacheReadPerMTok: 0.2, inputPerMTok: 4, outputPerMTok: 20 };
    expect(resolveModelPricing('google', 'gemini-4-argon', NOV_20_2026)).toEqual(before);
    expect(resolveModelPricing('google', 'gemini-4-argon', DEC_1_2026 - 1)).toEqual(before);
    expect(resolveModelPricing('google', 'gemini-4-argon', DEC_1_2026)).toEqual(after);
    const turn = buildTokenUsageCounts(1_000_000, 1_000_000);
    expect(computeCost(turn, resolveModelPricing('google', 'gemini-4-argon', NOV_20_2026))).toEqual(
      { available: true, provenance: 'exact-pricing', usdAmount: 12 }
    );
    expect(computeCost(turn, resolveModelPricing('google', 'gemini-4-argon', DEC_1_2026))).toEqual({
      available: true,
      provenance: 'exact-pricing',
      usdAmount: 24,
    });
  });

  it('prices a call of unknown time only when the model’s price never changed', () => {
    expect(resolveModelPricing('google', 'gemini-4-argon', undefined)).toBeUndefined();
    expect(resolveModelPricing('openai', 'gpt-6-astra', undefined)).toMatchObject({
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
  });
});
