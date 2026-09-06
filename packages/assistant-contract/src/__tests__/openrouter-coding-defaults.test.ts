import { describe, expect, it } from 'vitest';
import {
  mergeOpenRouterAutoProfileModel,
  OPENROUTER_CODING_MAX_OUTPUT_TOKENS,
  OPENROUTER_RECOMMENDED_CODING_MODEL_IDS,
  resolveOpenRouterAutoRuntimeProfile,
  resolveOpenRouterCodingMaxOutputTokens,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
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

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects malformed model completion limit %s',
    (limit) => {
      expect(() => resolveOpenRouterCodingMaxOutputTokens(limit)).toThrow(
        /modelMaxOutputTokens must be a positive integer/
      );
    }
  );
});

describe('resolveOpenRouterAutoRuntimeProfile', () => {
  it('sends Ox Alpha its mandatory max default without widening the coding output ceiling', () => {
    const oxAlpha = listProviderLlmModels('openrouter').find(({ id }) => id === 'stealth/ox-alpha');
    if (!oxAlpha) {
      throw new Error('Ox Alpha is missing from the OpenRouter registry');
    }
    expect(resolveOpenRouterAutoRuntimeProfile(oxAlpha)).toEqual({
      maxOutputTokens: 32_000,
      reasoningEffort: 'max',
    });
  });

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

describe('catalog Auto overrides survive live metadata (BST-833)', () => {
  // OpenRouter does not publish `autoEffort`, so `OpenRouterModelMetadata`
  // structurally cannot carry it. A caller that picks live metadata INSTEAD of
  // the catalog drops the override — which would drop Kimi K3 from its
  // recorded `low` back to the vendor's `max` the moment a key resolves live
  // metadata, silently restoring the exact behaviour BST-833 fixed.
  const liveKimi = {
    checkedAt: 42,
    contextWindow: 1_048_576,
    id: 'moonshotai/kimi-k3',
    reasoning: {
      defaultEffort: 'max' as const,
      defaultEnabled: true,
      mandatory: false,
      supportedEfforts: ['max', 'high', 'low'] as const,
      supportsMaxTokens: false,
    },
    source: 'openrouter-models-api' as const,
    supportedParameters: ['reasoning', 'max_tokens'],
  };
  const catalogKimi = {
    id: 'moonshotai/kimi-k3',
    reasoning: {
      autoEffort: 'low' as const,
      defaultEffort: 'max' as const,
      defaultEnabled: true,
      mandatory: false,
      supportedEfforts: ['max', 'high', 'low'] as const,
    },
  };

  it('drops to the vendor default without the merge — the regression being guarded', () => {
    expect(resolveOpenRouterAutoRuntimeProfile(liveKimi).reasoningEffort).toBe('max');
  });

  it('keeps the recorded autoEffort when live metadata is merged with the catalog', () => {
    const merged = mergeOpenRouterAutoProfileModel(liveKimi, catalogKimi);
    expect(merged).toBeDefined();
    expect(resolveOpenRouterAutoRuntimeProfile(merged!).reasoningEffort).toBe('low');
  });

  it('keeps live vendor facts while overlaying only the override', () => {
    const merged = mergeOpenRouterAutoProfileModel(liveKimi, catalogKimi);
    expect(merged?.reasoning?.defaultEffort).toBe('max');
    expect(merged?.reasoning?.supportedEfforts).toEqual(['max', 'high', 'low']);
  });

  it('falls back to the catalog when no live snapshot resolved', () => {
    expect(mergeOpenRouterAutoProfileModel(undefined, catalogKimi)).toBe(catalogKimi);
  });

  it('respects live metadata that reports no reasoning at all', () => {
    const noReasoning = { id: 'moonshotai/kimi-k3' };
    expect(mergeOpenRouterAutoProfileModel(noReasoning, catalogKimi)).toBe(noReasoning);
  });
});

describe('a malformed Auto override fails at its source, not on the wire', () => {
  it('rejects an autoEffort the model does not support', () => {
    expect(() =>
      resolveOpenRouterAutoRuntimeProfile({
        id: 'bad/entry',
        reasoning: {
          autoEffort: 'low',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['xhigh', 'high'],
        },
      })
    ).toThrow(/autoEffort 'low' is not in supportedEfforts \[xhigh, high\]/);
  });

  it("rejects autoEffort 'none' on a model whose reasoning is mandatory", () => {
    expect(() =>
      resolveOpenRouterAutoRuntimeProfile({
        id: 'required/reasoning',
        reasoning: {
          autoEffort: 'none',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['high'],
        },
      })
    ).toThrow(/autoEffort 'none' is invalid for a model whose reasoning is mandatory/);
  });

  it("allows autoEffort 'none' when reasoning is optional", () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'optional/reasoning',
        reasoning: {
          autoEffort: 'none',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['high'],
        },
      }).reasoningEffort
    ).toBe('none');
  });
});

describe('reasoning-aware OpenRouter output window (BST-1170)', () => {
  // OpenRouter documents that reasoning tokens ARE output tokens and that a
  // requested effort allocates a share OF max_tokens for reasoning (high ≈
  // 80%, max/xhigh ≈ 95%) — so the 32K coding ceiling never protected the
  // final answer on reasoning runs; it shrank the whole thinking+answer
  // window and Kimi K3 died at `finishReason: length`. A model whose vendor
  // documents a completion window sized for always-on thinking records it in
  // the catalog as `reasoning.vendorDefaultOutputTokens`.
  const registryKimi = () =>
    listProviderLlmModels('openrouter').find(({ id }) => id === 'moonshotai/kimi-k3');

  it('records the official Moonshot K3 completion window in the catalog', () => {
    // platform.kimi.ai K3 quickstart (verified 2026-08-05):
    // max_completion_tokens defaults to 131,072 and thinking cannot be
    // disabled — the vendor's own operating point for thinking + answer.
    expect(registryKimi()?.reasoning?.vendorDefaultOutputTokens).toBe(131_072);
  });

  it('opens the vendor window when reasoning is active on Kimi K3', () => {
    const kimi = registryKimi();
    expect(kimi).toBeDefined();
    expect(resolveOpenRouterOutputWindow(kimi!, true)).toBe(131_072);
  });

  it('keeps the coding ceiling when reasoning is inactive', () => {
    const kimi = registryKimi();
    expect(kimi).toBeDefined();
    expect(resolveOpenRouterOutputWindow(kimi!, false)).toBe(32_000);
  });

  it('keeps the coding ceiling for reasoning models with no recorded vendor window', () => {
    expect(
      resolveOpenRouterOutputWindow(
        {
          id: 'z-ai/glm-5.2',
          maxOutputTokens: 131_072,
          reasoning: {
            defaultEffort: 'high',
            defaultEnabled: true,
            mandatory: false,
            supportedEfforts: ['xhigh', 'high'],
          },
        },
        true
      )
    ).toBe(32_000);
  });

  it('caps the vendor window at a smaller declared model completion limit', () => {
    expect(
      resolveOpenRouterOutputWindow(
        {
          id: 'vendor/thinker',
          maxOutputTokens: 65_536,
          reasoning: {
            defaultEnabled: true,
            mandatory: false,
            vendorDefaultOutputTokens: 131_072,
          },
        },
        true
      )
    ).toBe(65_536);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a malformed recorded vendor window %s at its source',
    (vendorDefaultOutputTokens) => {
      expect(() =>
        resolveOpenRouterOutputWindow(
          {
            id: 'bad/entry',
            reasoning: { defaultEnabled: true, mandatory: false, vendorDefaultOutputTokens },
          },
          true
        )
      ).toThrow(/vendorDefaultOutputTokens must be a positive integer/);
    }
  );
});

describe('resolveOpenRouterReasoningActive', () => {
  const kimiLike = {
    id: 'moonshotai/kimi-k3',
    reasoning: {
      autoEffort: 'low' as const,
      defaultEffort: 'max' as const,
      defaultEnabled: true,
      mandatory: false,
      supportedEfforts: ['max', 'high', 'low'] as const,
    },
  };

  it('treats any explicit effort except none as active', () => {
    expect(resolveOpenRouterReasoningActive(kimiLike, 'high')).toBe(true);
    expect(resolveOpenRouterReasoningActive(kimiLike, 'max')).toBe(true);
    expect(resolveOpenRouterReasoningActive(kimiLike, 'none')).toBe(false);
  });

  it('follows the declared Auto resolution when no explicit effort is chosen', () => {
    expect(resolveOpenRouterReasoningActive(kimiLike)).toBe(true);
    expect(
      resolveOpenRouterReasoningActive({
        id: 'budget/sensitive',
        reasoning: {
          autoEffort: 'none',
          defaultEffort: 'high',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['high'],
        },
      })
    ).toBe(false);
  });

  it('is inactive for models that do not reason by default', () => {
    expect(resolveOpenRouterReasoningActive({ id: 'plain/model' })).toBe(false);
    expect(
      resolveOpenRouterReasoningActive({
        id: 'plain/model',
        reasoning: { defaultEffort: 'high', mandatory: false, supportedEfforts: ['high'] },
      })
    ).toBe(false);
  });

  it('stays active when reasoning is enabled by default with no declared effort', () => {
    // No effort parameter is sent, but the provider still applies its own
    // default — the window must be sized for thinking.
    expect(
      resolveOpenRouterReasoningActive({
        id: 'qwen/qwen3.7-max',
        reasoning: { defaultEnabled: true, mandatory: false },
      })
    ).toBe(true);
  });
});

describe('Auto profile sizes the window for its own reasoning resolution (BST-1170)', () => {
  it('resolves the registry Kimi K3 to its vendor window at the recorded low effort', () => {
    const kimi = listProviderLlmModels('openrouter').find(({ id }) => id === 'moonshotai/kimi-k3');
    expect(kimi).toBeDefined();
    expect(resolveOpenRouterAutoRuntimeProfile(kimi!)).toEqual({
      maxOutputTokens: 131_072,
      reasoningEffort: 'low',
    });
  });

  it('keeps the coding ceiling when the catalog deliberately switches Auto off', () => {
    expect(
      resolveOpenRouterAutoRuntimeProfile({
        id: 'budget/sensitive',
        reasoning: {
          autoEffort: 'none',
          defaultEffort: 'high',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['high'],
          vendorDefaultOutputTokens: 131_072,
        },
      })
    ).toEqual({ maxOutputTokens: 32_000, reasoningEffort: 'none' });
  });

  it('never overrides an explicitly configured output limit', () => {
    const kimi = listProviderLlmModels('openrouter').find(({ id }) => id === 'moonshotai/kimi-k3');
    expect(resolveOpenRouterAutoRuntimeProfile(kimi!, 48_000)).toEqual({
      maxOutputTokens: 48_000,
      reasoningEffort: 'low',
    });
  });
});

describe('catalog vendor window survives live metadata (BST-1170)', () => {
  // OpenRouter publishes NO max_completion_tokens for Kimi K3 (null as of
  // 2026-08-05), so `vendorDefaultOutputTokens` is catalog-only — exactly like
  // `autoEffort`, it must be merged back over a live snapshot.
  const liveKimi = {
    checkedAt: 42,
    contextWindow: 1_048_576,
    id: 'moonshotai/kimi-k3',
    reasoning: {
      defaultEffort: 'max' as const,
      defaultEnabled: true,
      mandatory: false,
      supportedEfforts: ['max', 'high', 'low'] as const,
      supportsMaxTokens: false,
    },
    source: 'openrouter-models-api' as const,
    supportedParameters: ['reasoning', 'max_tokens'],
  };
  const catalogKimi = {
    id: 'moonshotai/kimi-k3',
    reasoning: {
      autoEffort: 'low' as const,
      defaultEffort: 'max' as const,
      defaultEnabled: true,
      mandatory: false,
      supportedEfforts: ['max', 'high', 'low'] as const,
      vendorDefaultOutputTokens: 131_072,
    },
  };

  it('merges the recorded vendor window onto the live snapshot', () => {
    const merged = mergeOpenRouterAutoProfileModel(liveKimi, catalogKimi);
    expect(merged?.reasoning?.vendorDefaultOutputTokens).toBe(131_072);
    expect(resolveOpenRouterOutputWindow(merged!, true)).toBe(131_072);
  });

  it('keeps the Auto profile at the vendor window after the merge', () => {
    const merged = mergeOpenRouterAutoProfileModel(liveKimi, catalogKimi);
    expect(resolveOpenRouterAutoRuntimeProfile(merged!)).toEqual({
      maxOutputTokens: 131_072,
      reasoningEffort: 'low',
    });
  });

  it('still respects live metadata that reports no reasoning at all', () => {
    const noReasoning = { id: 'moonshotai/kimi-k3' };
    expect(mergeOpenRouterAutoProfileModel(noReasoning, catalogKimi)).toBe(noReasoning);
  });
});

describe('every catalogued OpenRouter model resolves a valid Auto profile', () => {
  // Registry-wide invariant: the resolver throws on a malformed override, so
  // running it across the catalog catches a bad entry in CI rather than at the
  // wire. Nothing else enforces `autoEffort` membership for the static
  // registry — the live parser only validates `defaultEffort`.
  it('resolves without throwing for all OpenRouter LLM entries', () => {
    const models = listProviderLlmModels('openrouter');
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(() => resolveOpenRouterAutoRuntimeProfile(model), model.id).not.toThrow();
    }
  });

  it('resolves an output window for all OpenRouter LLM entries in both reasoning states', () => {
    for (const model of listProviderLlmModels('openrouter')) {
      expect(() => resolveOpenRouterOutputWindow(model, true), model.id).not.toThrow();
      expect(() => resolveOpenRouterOutputWindow(model, false), model.id).not.toThrow();
    }
  });

  it('pins the Auto effort of the two models that reason by default', () => {
    const byId = new Map(listProviderLlmModels('openrouter').map((m) => [m.id, m]));
    const glm = byId.get('z-ai/glm-5.2');
    const kimi = byId.get('moonshotai/kimi-k3');
    expect(glm && resolveOpenRouterAutoRuntimeProfile(glm).reasoningEffort).toBe('high');
    expect(kimi && resolveOpenRouterAutoRuntimeProfile(kimi).reasoningEffort).toBe('low');
  });
});
