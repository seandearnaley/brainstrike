import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_CODING_MAX_OUTPUT_TOKENS,
  OPENROUTER_RECOMMENDED_CODING_MODEL_IDS,
  resolveOpenRouterAutoRuntimeProfile,
  resolveOpenRouterCodingMaxOutputTokens,
} from '../openrouter-coding-defaults';
import { listProviderLlmModels } from '../provider-registry';

describe('OPENROUTER_RECOMMENDED_CODING_MODEL_IDS', () => {
  it('provides the curated, live-tested coding routes in preference order', () => {
    expect(OPENROUTER_RECOMMENDED_CODING_MODEL_IDS).toEqual([
      'openai/gpt-5.6-terra',
      'moonshotai/kimi-k3',
      'qwen/qwen3.7-max',
      'z-ai/glm-5.2',
      'minimax/minimax-m3',
    ]);
  });

  it('contains only supported OpenRouter models', () => {
    const supportedIds = new Set(listProviderLlmModels('openrouter').map((model) => model.id));
    for (const modelId of OPENROUTER_RECOMMENDED_CODING_MODEL_IDS) {
      expect(supportedIds.has(modelId), modelId).toBe(true);
    }
  });

  it('declares MiniMax M3 image input support', () => {
    const model = listProviderLlmModels('openrouter').find(({ id }) => id === 'minimax/minimax-m3');
    expect(model?.vision).toBe('supported');
  });

  it('restricts GLM 5.2 reasoning to its documented efforts', () => {
    const model = listProviderLlmModels('openrouter').find(({ id }) => id === 'z-ai/glm-5.2');
    expect(model?.reasoning).toEqual({
      defaultEffort: 'high',
      defaultEnabled: true,
      mandatory: false,
      supportedEfforts: ['xhigh', 'high'],
    });
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

describe('resolveOpenRouterAutoRuntimeProfile', () => {
  it('prefers low reasoning over disabling reasoning when both are supported', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'openai/gpt-5.6-terra',
        reasoning: {
          defaultEffort: 'medium',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'],
          supportsMaxTokens: false,
        },
      })
    ).toEqual({
      maxOutputTokens: 32_000,
      reasoningEffort: 'low',
    });
  });

  it('keeps Kimi K3 at the coding ceiling and selects its lowest supported effort', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        checkedAt: 42,
        contextWindow: 1_048_576,
        id: 'moonshotai/kimi-k3',
        reasoning: {
          defaultEffort: 'max',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['max', 'high', 'low'],
          supportsMaxTokens: false,
        },
        source: 'openrouter-models-api',
        supportedParameters: ['reasoning', 'max_tokens'],
      })
    ).toEqual({
      maxOutputTokens: 32_000,
      reasoningEffort: 'low',
    });
  });

  it('disables optional Auto reasoning when the lowest supported effort is high and unbounded', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        checkedAt: 42,
        contextWindow: 1_048_576,
        id: 'z-ai/glm-5.2',
        maxOutputTokens: 131_072,
        reasoning: {
          defaultEffort: 'high',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['xhigh', 'high'],
          supportsMaxTokens: false,
        },
        source: 'openrouter-models-api',
        supportedParameters: ['reasoning', 'max_tokens'],
      })
    ).toEqual({
      maxOutputTokens: 32_000,
      reasoningEffort: 'none',
    });
  });

  it('keeps an explicit valid output limit while disabling unbounded optional Auto reasoning', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile(
        {
          checkedAt: 42,
          contextWindow: 1_048_576,
          id: 'z-ai/glm-5.2',
          maxOutputTokens: 131_072,
          reasoning: {
            defaultEffort: 'high',
            defaultEnabled: true,
            mandatory: false,
            supportedEfforts: ['xhigh', 'high'],
            supportsMaxTokens: false,
          },
          source: 'openrouter-models-api',
          supportedParameters: ['reasoning', 'max_tokens'],
        },
        32_000
      )
    ).toEqual({
      maxOutputTokens: 32_000,
      reasoningEffort: 'none',
    });
  });

  it('disables optional default reasoning when no bounded effort is published', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'qwen/qwen3.7-max',
        reasoning: {
          defaultEnabled: true,
          mandatory: false,
          supportsMaxTokens: false,
        },
      })
    ).toEqual({
      maxOutputTokens: 32_000,
      reasoningEffort: 'none',
    });
  });

  it('keeps the lowest effort for mandatory models that cannot disable reasoning', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'required-reasoning',
        reasoning: {
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['xhigh', 'high'],
          supportsMaxTokens: false,
        },
      })
    ).toEqual({
      maxOutputTokens: 32_000,
      reasoningEffort: 'high',
    });
  });
});
