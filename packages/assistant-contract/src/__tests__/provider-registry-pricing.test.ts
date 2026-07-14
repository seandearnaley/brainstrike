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
    expect(fable?.pricing).toEqual({ inputPerMTok: 10, outputPerMTok: 50 });
    expect(sonnet?.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
  });

  it('tracks current OpenRouter base rates for Sonnet 5 and GLM-5.2', () => {
    const models = listProviderLlmModels('openrouter');
    const sonnet = models.find((model) => model.id === 'anthropic/claude-sonnet-5');
    const glm = models.find((model) => model.id === 'z-ai/glm-5.2');
    expect(sonnet?.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(glm?.pricing).toEqual({ inputPerMTok: 0.9282, outputPerMTok: 2.9172 });
  });
});
