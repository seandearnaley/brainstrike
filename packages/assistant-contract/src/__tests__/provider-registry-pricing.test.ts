import { describe, expect, it } from 'vitest';
import { listProviderLlmModels, listProviders } from '../provider-registry.js';

describe('model pricing metadata', () => {
  it('every declared pricing has positive finite input/output per-MTok rates', () => {
    for (const provider of listProviders()) {
      for (const model of provider.models) {
        if (model.type !== 'llm' || model.pricing === undefined) {
          continue;
        }
        const { inputPerMTok, outputPerMTok } = model.pricing;
        expect(Number.isFinite(inputPerMTok), `${provider.id}/${model.id} inputPerMTok`).toBe(true);
        expect(Number.isFinite(outputPerMTok), `${provider.id}/${model.id} outputPerMTok`).toBe(
          true
        );
        expect(inputPerMTok, `${provider.id}/${model.id} inputPerMTok`).toBeGreaterThan(0);
        expect(outputPerMTok, `${provider.id}/${model.id} outputPerMTok`).toBeGreaterThan(0);
      }
    }
  });

  it('every priced Anthropic model declares cache rates at the documented multipliers', () => {
    for (const model of listProviderLlmModels('anthropic')) {
      if (model.pricing === undefined) {
        continue;
      }
      const { cacheReadPerMTok, cacheWritePerMTok, inputPerMTok } = model.pricing;
      expect(cacheReadPerMTok, `anthropic/${model.id} cacheReadPerMTok`).toBeCloseTo(
        inputPerMTok * 0.1,
        10
      );
      expect(cacheWritePerMTok, `anthropic/${model.id} cacheWritePerMTok`).toBeCloseTo(
        inputPerMTok * 1.25,
        10
      );
    }
  });

  it('non-Anthropic providers declare no cache rates (their caching is provider-automatic)', () => {
    for (const provider of listProviders()) {
      if (provider.id === 'anthropic') {
        continue;
      }
      for (const model of provider.models) {
        if (model.type !== 'llm' || model.pricing === undefined) {
          continue;
        }
        expect(model.pricing.cacheReadPerMTok, `${provider.id}/${model.id}`).toBeUndefined();
        expect(model.pricing.cacheWritePerMTok, `${provider.id}/${model.id}`).toBeUndefined();
      }
    }
  });

  it('the built-in local provider omits pricing (keyless models must not render $0)', () => {
    for (const model of listProviderLlmModels('local')) {
      expect(model.pricing, `local/${model.id}`).toBeUndefined();
    }
  });

  it('new hosted models carry current base-rate estimates', () => {
    const sol = listProviderLlmModels('openai').find((model) => model.id === 'gpt-5.6-sol');
    const fable = listProviderLlmModels('anthropic').find((model) => model.id === 'claude-fable-5');
    const sonnet = listProviderLlmModels('anthropic').find(
      (model) => model.id === 'claude-sonnet-5'
    );
    expect(sol?.pricing).toEqual({ inputPerMTok: 5, outputPerMTok: 30 });
    expect(fable?.pricing).toEqual({
      cacheReadPerMTok: 1,
      cacheWritePerMTok: 12.5,
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
    expect(sonnet?.pricing).toEqual({
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
  });

  it('tracks current OpenRouter base rates for Sonnet 5, GLM-5.2, Spark, and Kimi K3', () => {
    const models = listProviderLlmModels('openrouter');
    const sonnet = models.find((model) => model.id === 'anthropic/claude-sonnet-5');
    const glm = models.find((model) => model.id === 'z-ai/glm-5.2');
    const spark = models.find((model) => model.id === 'meta/muse-spark-1.1');
    const kimi = models.find((model) => model.id === 'moonshotai/kimi-k3');
    expect(sonnet?.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(glm?.pricing).toEqual({ inputPerMTok: 0.9282, outputPerMTok: 2.9172 });
    expect(spark?.pricing).toEqual({ inputPerMTok: 1.25, outputPerMTok: 4.25 });
    expect(kimi?.pricing).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });
});
