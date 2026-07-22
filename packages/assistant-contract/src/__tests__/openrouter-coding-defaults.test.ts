import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_CODING_MAX_OUTPUT_TOKENS,
  OPENROUTER_RECOMMENDED_CODING_MODEL_IDS,
  resolveOpenRouterCodingMaxOutputTokens,
} from '../openrouter-coding-defaults';
import { listProviderLlmModels } from '../provider-registry';

describe('OPENROUTER_RECOMMENDED_CODING_MODEL_IDS', () => {
  it('provides the curated, live-tested coding routes in preference order', () => {
    expect(OPENROUTER_RECOMMENDED_CODING_MODEL_IDS).toEqual([
      'openai/gpt-5.6-terra',
      'moonshotai/kimi-k3',
      'qwen/qwen3.7-max',
    ]);
  });

  it('contains only supported OpenRouter models', () => {
    const supportedIds = new Set(listProviderLlmModels('openrouter').map((model) => model.id));
    for (const modelId of OPENROUTER_RECOMMENDED_CODING_MODEL_IDS) {
      expect(supportedIds.has(modelId), modelId).toBe(true);
    }
  });
});

describe('resolveOpenRouterCodingMaxOutputTokens', () => {
  it('uses the OpenCode coding ceiling when model metadata is unavailable', () => {
    expect(resolveOpenRouterCodingMaxOutputTokens()).toBe(32_000);
    expect(OPENROUTER_CODING_MAX_OUTPUT_TOKENS).toBe(32_000);
  });

  it('caps the coding default to a smaller model completion limit', () => {
    expect(resolveOpenRouterCodingMaxOutputTokens(16_384)).toBe(16_384);
  });

  it('keeps the coding ceiling for models with larger completion limits', () => {
    expect(resolveOpenRouterCodingMaxOutputTokens(128_000)).toBe(32_000);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects malformed model completion limit %s', (limit) => {
    expect(() => resolveOpenRouterCodingMaxOutputTokens(limit)).toThrow(
      /modelMaxOutputTokens must be a positive integer/
    );
  });
});
