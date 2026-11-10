import { describe, expect, it } from 'vitest';
import {
  OPENAI_FAMILY_DEFAULT_EFFORTS,
  resolveModelReasoningSupport,
  resolveReasoningControlsAvailability,
} from '../model-reasoning.js';
import { listProviderLlmModels, listProviders } from '../provider-registry.js';

describe('resolveModelReasoningSupport', () => {
  it.each([
    // Declared reasoning models resolve from the model definition itself.
    ['openrouter', 'moonshotai/kimi-k3', { source: 'model', state: 'supported' }],
    ['openrouter', 'meta/muse-spark-1.1', { source: 'model', state: 'supported' }],
    ['openrouter', 'z-ai/glm-5.2', { source: 'model', state: 'supported' }],
    // Every direct OpenAI row now declares its own ladder (BST-1709).
    ['openai', 'gpt-5.6-terra', { source: 'model', state: 'supported' }],
    // Hosted reasoning-first providers default to supported.
    ['openai', 'gpt-not-in-catalog', { source: 'provider-default', state: 'supported' }],
    ['anthropic', 'claude-sonnet-5', { source: 'provider-default', state: 'supported' }],
    ['google', 'gemini-3.8-flash', { source: 'provider-default', state: 'supported' }],
    // Undeclared OpenRouter models are visibly unverified, never silently on.
    ['openrouter', 'qwen/qwen3.7-max', { reason: 'openrouter-undeclared', state: 'unknown' }],
    [
      'openrouter',
      'not-in-catalog/anything',
      { reason: 'openrouter-undeclared', state: 'unknown' },
    ],
    // Unknown provider ids are visibly unsupported (never guessed).
    ['not-a-provider', 'whatever', { state: 'unsupported' }],
  ] as const)('resolves %s / %s', (provider, model, expected) => {
    expect(resolveModelReasoningSupport(provider, model)).toEqual(expected);
  });

  it('normalizes provider id casing', () => {
    expect(resolveModelReasoningSupport('OpenAI', 'gpt-5.6-terra')).toEqual({
      source: 'model',
      state: 'supported',
    });
  });
});

describe('resolveReasoningControlsAvailability', () => {
  // Retargeted from the delisted stealth/ox-alpha (BST-1697) to GLM 5.3,
  // which declares the same mandatory max/high/low ladder. The behaviour under
  // test is that a mandatory ladder gets no synthesized Off effort.
  it('keeps a mandatory OpenRouter ladder free of an Off effort', () => {
    expect(resolveReasoningControlsAvailability('openrouter', 'z-ai/glm-5.3')).toEqual({
      available: true,
      defaultEffort: 'max',
      efforts: ['max', 'high', 'low'],
      family: 'openrouter',
      mandatory: true,
    });
  });

  it('constrains Kimi K3 to its published efforts and optional Off control', () => {
    expect(resolveReasoningControlsAvailability('openrouter', 'moonshotai/kimi-k3')).toEqual({
      available: true,
      defaultEffort: 'max',
      efforts: ['max', 'high', 'low', 'none'],
      family: 'openrouter',
    });
  });

  it('constrains GLM 5.2 to its published efforts', () => {
    expect(resolveReasoningControlsAvailability('openrouter', 'z-ai/glm-5.2')).toEqual({
      available: true,
      defaultEffort: 'high',
      efforts: ['xhigh', 'high', 'none'],
      family: 'openrouter',
    });
  });

  it('offers only Off for Nemotron on/off reasoning without live metadata', () => {
    expect(
      resolveReasoningControlsAvailability('openrouter', 'nvidia/nemotron-3.5-lightning')
    ).toEqual({
      available: true,
      efforts: ['none'],
      family: 'openrouter',
    });
  });

  it('prefers matching live OpenRouter reasoning capabilities over the static registry', () => {
    expect(
      resolveReasoningControlsAvailability('openrouter', 'moonshotai/kimi-k3', {
        checkedAt: 42,
        contextWindow: 1_048_576,
        id: 'moonshotai/kimi-k3',
        reasoning: {
          defaultEffort: 'high',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['high', 'low'],
          supportsMaxTokens: false,
        },
        source: 'openrouter-models-api',
        supportedParameters: ['reasoning'],
      })
    ).toEqual({
      available: true,
      defaultEffort: 'high',
      efforts: ['high', 'low', 'none'],
      family: 'openrouter',
    });
  });

  it('does not invent static efforts when matching live reasoning metadata is partial', () => {
    expect(
      resolveReasoningControlsAvailability('openrouter', 'moonshotai/kimi-k3', {
        checkedAt: 42,
        contextWindow: 1_048_576,
        id: 'moonshotai/kimi-k3',
        reasoning: {
          defaultEnabled: true,
          mandatory: false,
          supportsMaxTokens: false,
        },
        source: 'openrouter-models-api',
        supportedParameters: ['reasoning'],
      })
    ).toEqual({
      available: true,
      efforts: ['none'],
      family: 'openrouter',
    });
  });

  it('does not invent an effort list for undeclared OpenRouter models', () => {
    expect(resolveReasoningControlsAvailability('openrouter', 'qwen/qwen3.7-max')).toEqual({
      available: false,
      reason: 'no-reasoning-controls',
    });
  });

  it('offers the provider-default efforts for an undeclared OpenAI model', () => {
    expect(resolveReasoningControlsAvailability('openai', 'gpt-not-in-catalog')).toEqual({
      available: true,
      efforts: OPENAI_FAMILY_DEFAULT_EFFORTS,
      family: 'openai',
    });
  });

  /**
   * BST-1709. Every direct OpenAI row declares the ladder its own model page
   * documents (developers.openai.com/api/docs/models/<id>, read 2026-10-18).
   * The undeclared family default offered `minimal`, which none of them lists,
   * and withheld `max`, which the GPT-5.6 rows accept. Literal lists, not the
   * constant: a test that compares the resolver to its own input can't go red.
   */
  it.each([
    ['gpt-5.6-sol', 'medium', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.6-terra', 'medium', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.6-luna', 'medium', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.5', 'medium', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.5-pro', 'high', ['medium', 'high', 'xhigh']],
    ['gpt-5.4', 'none', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.4-pro', 'medium', ['medium', 'high', 'xhigh']],
    ['gpt-5.4-mini', 'none', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.4-nano', 'none', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.3-codex', undefined, ['low', 'medium', 'high', 'xhigh']],
    ['gpt-5.2', 'none', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.2-pro', undefined, ['medium', 'high', 'xhigh']],
  ] as const)('offers the documented %s ladder (default %s)', (modelId, defaultEffort, efforts) => {
    expect(resolveReasoningControlsAvailability('openai', modelId)).toEqual({
      available: true,
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      efforts,
      family: 'openai',
    });
  });

  /**
   * BST-1692. GPT-6 Astra is the first DIRECT OpenAI row to declare its own
   * ladder, because the undeclared default is wrong in both directions for it:
   * it offers `minimal`, which OpenAI's Astra model page does not list, and it
   * withholds `max`, which that page does list. Offering an effort the route
   * rejects is a silent-degradation hazard; hiding one it accepts is a
   * capability we never surface.
   */
  it('offers the documented GPT-6 Astra ladder, not the OpenAI family default', () => {
    const availability = resolveReasoningControlsAvailability('openai', 'gpt-6-astra');
    expect(availability).toEqual({
      available: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      family: 'openai',
    });
    expect(OPENAI_FAMILY_DEFAULT_EFFORTS).toContain('minimal');
    expect(OPENAI_FAMILY_DEFAULT_EFFORTS).not.toContain('max');
  });

  it.each([
    ['claude-fable-5-2', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['claude-fable-5-1', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max'], false],
    ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max'], false],
    ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max'], false],
    ['claude-sonnet-4-6', ['low', 'medium', 'high', 'max'], false],
  ] as const)('offers the documented Anthropic ladder for %s', (modelId, efforts, mandatory) => {
    expect(resolveReasoningControlsAvailability('anthropic', modelId)).toEqual({
      available: true,
      defaultEffort: 'high',
      efforts,
      family: 'anthropic',
      ...(mandatory ? { mandatory: true } : {}),
    });
  });

  it('offers the Claude Opus 5.5 ladder with its medium default and no Thinking toggle', () => {
    expect(resolveReasoningControlsAvailability('anthropic', 'claude-opus-5-5')).toEqual({
      available: true,
      defaultEffort: 'medium',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      family: 'anthropic',
      mandatory: true,
    });
  });

  /**
   * BST-1804. GPT-6 Sol and Luna declare their own ladders for the same reason
   * Astra does, and unlike Astra they offer `none` and document a default.
   */
  it.each(['gpt-6-sol', 'gpt-6-luna'])(
    'offers the documented %s ladder with its medium default, not the family default',
    (modelId) => {
      expect(resolveReasoningControlsAvailability('openai', modelId)).toEqual({
        available: true,
        defaultEffort: 'medium',
        efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        family: 'openai',
      });
    }
  );

  it('offers Haiku thinking without an effort ladder', () => {
    expect(resolveReasoningControlsAvailability('anthropic', 'claude-haiku-4-5')).toEqual({
      available: true,
      efforts: [],
      family: 'anthropic',
    });
  });

  it.each([undefined, 'claude-not-in-catalog'])(
    'keeps the Thinking toggle but withholds the ladder without a declared model: %s',
    (modelId) => {
      // A persisted legacy budget is still sent for such an id (see
      // anthropic-provider-options.test.ts), so the toggle that clears it must
      // stay reachable; only the effort ladder has nothing to be judged against.
      expect(resolveReasoningControlsAvailability('anthropic', modelId)).toEqual({
        available: true,
        efforts: [],
        family: 'anthropic',
      });
    }
  );

  it('offers google thinking levels, restricted for the Gemini 3 Pro line', () => {
    expect(resolveReasoningControlsAvailability('google', 'gemini-3.6-flash')).toEqual({
      available: true,
      family: 'google',
      levels: ['minimal', 'low', 'medium', 'high'],
    });
    expect(resolveReasoningControlsAvailability('google', 'gemini-3.8-flash')).toEqual({
      available: true,
      family: 'google',
      levels: ['low', 'medium', 'high'],
    });
    expect(resolveReasoningControlsAvailability('google', 'gemini-3.1-pro-preview')).toEqual({
      available: true,
      family: 'google',
      levels: ['low', 'high'],
    });
  });

  it('hides controls for unknown providers', () => {
    expect(resolveReasoningControlsAvailability('not-a-provider', 'whatever')).toEqual({
      available: false,
      reason: 'no-reasoning-controls',
    });
  });

  it('normalizes provider id casing', () => {
    expect(resolveReasoningControlsAvailability('OpenAI', 'gpt-5.6-terra')).toEqual({
      available: true,
      defaultEffort: 'medium',
      efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      family: 'openai',
    });
  });

  it('resolves the openai family without a model id (provider defaults)', () => {
    expect(resolveReasoningControlsAvailability('openai', undefined)).toEqual({
      available: true,
      efforts: OPENAI_FAMILY_DEFAULT_EFFORTS,
      family: 'openai',
    });
  });
});

describe('model taglines', () => {
  it("gives every provider's default LLM a curated tagline", () => {
    for (const provider of listProviders()) {
      const models = listProviderLlmModels(provider.id);
      const defaultModel = models.find((model) => model.default);
      if (!defaultModel) {
        continue;
      }
      expect(defaultModel.tagline, `${provider.id}/${defaultModel.id}`).toBeTruthy();
    }
  });
});
