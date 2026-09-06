import { describe, expect, it } from 'vitest';
import { GEMMA4_E2B_MODEL_ID } from '../local-llm.js';
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
    // Hosted reasoning-first providers default to supported.
    ['openai', 'gpt-5.6-terra', { source: 'provider-default', state: 'supported' }],
    ['anthropic', 'claude-sonnet-5', { source: 'provider-default', state: 'supported' }],
    ['google', 'gemini-3.5-flash', { source: 'provider-default', state: 'supported' }],
    // Undeclared OpenRouter models are visibly unverified, never silently on.
    ['openrouter', 'qwen/qwen3.7-max', { reason: 'openrouter-undeclared', state: 'unknown' }],
    [
      'openrouter',
      'not-in-catalog/anything',
      { reason: 'openrouter-undeclared', state: 'unknown' },
    ],
    // Dynamically discovered local-runtime models report no signal.
    ['ollama', 'llama3.2', { reason: 'discovered-model', state: 'unknown' }],
    ['lmstudio', 'qwen2.5-7b-instruct', { reason: 'discovered-model', state: 'unknown' }],
    // Embedding-only providers cannot reason.
    ['cohere', 'embed-english-v3.0', { state: 'unsupported' }],
    ['voyage', 'voyage-3', { state: 'unsupported' }],
    // Unknown provider ids are visibly unsupported (never guessed).
    ['not-a-provider', 'whatever', { state: 'unsupported' }],
  ] as const)('resolves %s / %s', (provider, model, expected) => {
    expect(resolveModelReasoningSupport(provider, model)).toEqual(expected);
  });

  it('resolves the built-in local model from its LocalLlmModelSpec.supportsThinking', () => {
    expect(resolveModelReasoningSupport('local', GEMMA4_E2B_MODEL_ID)).toEqual({
      source: 'local-spec',
      state: 'supported',
    });
  });

  it('reports unknown local model ids as unsupported', () => {
    expect(resolveModelReasoningSupport('local', 'not-a-local-model')).toEqual({
      state: 'unsupported',
    });
  });

  it('normalizes provider id casing', () => {
    expect(resolveModelReasoningSupport('OpenAI', 'gpt-5.6-terra')).toEqual({
      source: 'provider-default',
      state: 'supported',
    });
  });
});

describe('resolveReasoningControlsAvailability', () => {
  it('keeps Ox Alpha mandatory and excludes an Off effort', () => {
    expect(resolveReasoningControlsAvailability('openrouter', 'stealth/ox-alpha')).toEqual({
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

  it('keeps the full effort list for undeclared OpenRouter models', () => {
    expect(resolveReasoningControlsAvailability('openrouter', 'qwen/qwen3.7-max')).toEqual({
      available: true,
      efforts: OPENAI_FAMILY_DEFAULT_EFFORTS,
      family: 'openrouter',
    });
  });

  it('offers the provider-default efforts for OpenAI models', () => {
    expect(resolveReasoningControlsAvailability('openai', 'gpt-5.6-terra')).toEqual({
      available: true,
      efforts: OPENAI_FAMILY_DEFAULT_EFFORTS,
      family: 'openai',
    });
  });

  it.each([
    ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-sonnet-4-6', ['low', 'medium', 'high', 'max']],
  ] as const)('offers the documented Anthropic ladder for %s', (modelId, efforts) => {
    expect(resolveReasoningControlsAvailability('anthropic', modelId)).toEqual({
      available: true,
      defaultEffort: 'high',
      efforts,
      family: 'anthropic',
    });
  });

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
    expect(resolveReasoningControlsAvailability('google', 'gemini-3.5-flash')).toEqual({
      available: true,
      family: 'google',
      levels: ['minimal', 'low', 'medium', 'high'],
    });
    expect(resolveReasoningControlsAvailability('google', 'gemini-3.7-flash')).toEqual({
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

  it('exposes only the thinking toggle for the built-in local model', () => {
    expect(resolveReasoningControlsAvailability('local', GEMMA4_E2B_MODEL_ID)).toEqual({
      available: true,
      family: 'local',
    });
  });

  it('hides controls for discovered runtimes, embedding-only, and unknown providers', () => {
    for (const [provider, model] of [
      ['ollama', 'llama3.2'],
      ['lmstudio', 'qwen2.5-7b-instruct'],
      ['cohere', 'embed-english-v3.0'],
      ['voyage', 'voyage-3'],
      ['local', 'not-a-local-model'],
      ['not-a-provider', 'whatever'],
    ] as const) {
      expect(resolveReasoningControlsAvailability(provider, model)).toEqual({
        available: false,
        reason: 'no-reasoning-controls',
      });
    }
  });

  it('normalizes provider id casing', () => {
    expect(resolveReasoningControlsAvailability('OpenAI', 'gpt-5.6-terra')).toEqual({
      available: true,
      efforts: OPENAI_FAMILY_DEFAULT_EFFORTS,
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
