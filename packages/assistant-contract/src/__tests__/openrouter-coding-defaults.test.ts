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
  it('sends the vendor default effort when the catalog records no override', () => {
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
      reasoningEffort: 'medium',
    });
  });

  it('keeps Kimi K3 at the coding ceiling and honours its recorded autoEffort', () => {
    // Kimi's vendor default is `max`, which spends the whole coding-profile
    // output budget reasoning — so the catalog records a lower Auto effort.
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        checkedAt: 42,
        contextWindow: 1_048_576,
        id: 'moonshotai/kimi-k3',
        reasoning: {
          autoEffort: 'low',
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

  it('keeps an explicit valid output limit alongside the declared effort', () => {
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
      reasoningEffort: 'high',
    });
  });

  it('sends the declared default for mandatory models that cannot disable reasoning', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'required-reasoning',
        reasoning: {
          defaultEffort: 'high',
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

describe('Auto reasoning effort is DECLARED, never inferred (BST-833)', () => {
  // The old resolver scanned `supportedEfforts` for a "completion-biased"
  // effort and, failing to find one, silently substituted `none` — discarding
  // the model's own declared default. GLM-5.2 declares `defaultEffort: 'high'`
  // and advertises no low tier, so it lost reasoning entirely for a reason
  // nothing surfaced. Auto now uses declared catalog data only.

  it('uses an explicitly recorded autoEffort ahead of the vendor default', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'moonshotai/kimi-k3',
        reasoning: {
          autoEffort: 'low',
          defaultEffort: 'max',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['max', 'high', 'low'],
        },
      })
    ).toEqual({ maxOutputTokens: 32_000, reasoningEffort: 'low' });
  });

  it('honours a declared vendor default instead of coercing it to none', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'z-ai/glm-5.2',
        reasoning: {
          defaultEffort: 'high',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['xhigh', 'high'],
        },
      })
    ).toEqual({ maxOutputTokens: 32_000, reasoningEffort: 'high' });
  });

  it('lets the catalog record a deliberate off switch', () => {
    // Switching reasoning off stays possible — it just has to be WRITTEN DOWN
    // rather than inferred from the absence of a low tier.
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'budget/sensitive',
        reasoning: {
          autoEffort: 'none',
          defaultEffort: 'high',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['high'],
        },
      })
    ).toEqual({ maxOutputTokens: 32_000, reasoningEffort: 'none' });
  });

  it('claims nothing when neither an autoEffort nor a vendor default is declared', () => {
    // No declared basis means no request parameter — the provider applies its
    // own default. Inventing `none` here is the silent fallback this removes.
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'qwen/qwen3.7-max',
        reasoning: { defaultEnabled: true, mandatory: false },
      })
    ).toEqual({ maxOutputTokens: 32_000 });
  });

  it('still sends no reasoning options when the model does not reason by default', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'plain/model',
        reasoning: { defaultEffort: 'high', mandatory: false, supportedEfforts: ['high'] },
      })
    ).toEqual({ maxOutputTokens: 32_000 });
  });
});
