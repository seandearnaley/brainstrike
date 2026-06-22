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

  it('well-known hosted models carry a dated pricing estimate', () => {
    const opus = listProviderLlmModels('anthropic').find((model) => model.id === 'claude-opus-4-8');
    expect(opus?.pricing).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
  });
});
