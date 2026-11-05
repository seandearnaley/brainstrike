import {
  listProviderLlmModels,
  listProviders,
} from '@brainstrike/assistant-contract/provider-registry';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { describe, expect, it } from 'vitest';
import { isMastraAgentError } from '../mastra-boundary/mastra-agent-error';
import {
  createLanguageModelProvider,
  createProvider,
  getDefaultModel,
} from '../providers/provider-factory';

describe('provider-factory', () => {
  describe('createProvider', () => {
    it('creates OpenAI provider with default model', () => {
      const model = createProvider('openai', { apiKey: 'test-key', kind: 'api_key' }) as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-6.1-terra');
    });

    it('creates OpenAI provider with custom model', () => {
      const model = createProvider(
        'openai',
        { apiKey: 'test-key', kind: 'api_key' },
        'gpt-5.4'
      ) as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-5.4');
    });

    it('creates Anthropic provider with default model', () => {
      const model = createProvider('anthropic', { apiKey: 'test-key', kind: 'api_key' }) as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('claude-sonnet-5-5');
    });

    it('creates Anthropic provider with custom model', () => {
      const model = createProvider(
        'anthropic',
        { apiKey: 'test-key', kind: 'api_key' },
        'claude-sonnet-4-6'
      ) as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('claude-sonnet-4-6');
    });

    it('creates Google provider with default model', () => {
      const model = createProvider('google', { apiKey: 'test-key', kind: 'api_key' }) as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gemini-3.8-flash');
    });

    it('creates Google provider with custom model', () => {
      const model = createProvider(
        'google',
        { apiKey: 'test-key', kind: 'api_key' },
        'gemini-3.6-flash'
      ) as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gemini-3.6-flash');
    });

    it('creates OpenRouter provider with default model', () => {
      const model = createProvider('openrouter', {
        apiKey: 'test-key',
        kind: 'api_key',
      }) as ModelRouterLanguageModel;
      expect(model).toBeInstanceOf(ModelRouterLanguageModel);
      expect(model.provider).toBe('openrouter');
      expect(model.modelId).toBe('openai/gpt-5.6-terra');
    });

    it('uses the Mastra model router for an OpenRouter model', () => {
      const model = createProvider(
        'openrouter',
        { apiKey: 'test-key', kind: 'api_key' },
        'z-ai/glm-5.2'
      ) as ModelRouterLanguageModel;
      expect(model).toBeInstanceOf(ModelRouterLanguageModel);
      expect(model.provider).toBe('openrouter');
      expect(model.modelId).toBe('z-ai/glm-5.2');
    });

    it('throws MastraAgentError for unsupported provider', () => {
      try {
        createProvider('unsupported', { apiKey: 'test-key', kind: 'api_key' });
        throw new Error('Expected unsupported provider to throw');
      } catch (error) {
        expect(isMastraAgentError(error)).toBe(true);
        if (isMastraAgentError(error)) {
          expect(error.code).toBe('mastra_agent_unsupported_provider');
          expect(error.context).toEqual(
            expect.objectContaining({
              provider: 'unsupported',
              supportedProviders: expect.arrayContaining([
                'openai',
                'anthropic',
                'google',
                'openrouter',
              ]),
            })
          );
        }
      }
    });

    it('creates provider without explicit API key (uses env vars)', () => {
      // Should not throw, will rely on environment variables
      const model = createProvider('openai');
      expect(model).toBeDefined();
    });
  });

  describe('createLanguageModelProvider', () => {
    it('returns the concrete hosted provider model unchanged', () => {
      const model = createLanguageModelProvider('openai', 'test-key', 'gpt-5.4');

      expect(model.modelId).toBe('gpt-5.4');
      expect(model.doStream).toBeTypeOf('function');
    });

    it('materializes an explicit-key OpenRouter config as a concrete model', () => {
      const model = createLanguageModelProvider('openrouter', 'test-key', 'z-ai/glm-5.2');

      expect(model.modelId).toBe('z-ai/glm-5.2');
      expect(model.provider).toBe('openrouter');
      expect(model.doStream).toBeTypeOf('function');
    });

    it('gives OpenRouter persistent-memory models a spec version @mastra/memory can execute', () => {
      // The OM observer agent runs inside @mastra/memory's bundled core.
      // ModelRouterLanguageModel declares specification 'v2', which that
      // bundled agent executes — this pin keeps the wrapper from silently
      // drifting to a spec literal the observer path cannot dispatch (the
      // BST-947 field failure was the EMBEDDING model making exactly that
      // class of mistake: a spec-'v4' embedder fell into @mastra/memory's
      // legacy v1-only embed pipeline).
      const model = createLanguageModelProvider(
        'openrouter',
        'test-key',
        'google/gemini-2.5-flash'
      );

      expect(model.specificationVersion).toBe('v2');
      expect(model.modelId).toBe('google/gemini-2.5-flash');
    });

    it('rejects a hosted router model without an explicit credential', () => {
      expect(() => createLanguageModelProvider('openrouter', undefined, 'z-ai/glm-5.2')).toThrow(
        /requires an explicit API key/iu
      );
    });

    it('rejects providers outside the persistent-memory model boundary', () => {
      expect(() =>
        createLanguageModelProvider('bedrock', 'test-key', 'anthropic.claude-sonnet-5')
      ).toThrow(/does not support provider: bedrock/iu);
    });
  });

  describe('getDefaultModel', () => {
    it('returns correct default for OpenAI', () => {
      expect(getDefaultModel('openai')).toBe('gpt-6.1-terra');
    });

    it('returns correct default for Anthropic', () => {
      expect(getDefaultModel('anthropic')).toBe('claude-sonnet-5-5');
    });

    it('returns correct default for Google', () => {
      expect(getDefaultModel('google')).toBe('gemini-3.8-flash');
    });

    it('returns correct default for OpenRouter', () => {
      expect(getDefaultModel('openrouter')).toBe('openai/gpt-5.6-terra');
    });

    it('throws for an unsupported provider', () => {
      expect(() => getDefaultModel('unsupported')).toThrow(/Unsupported provider/u);
    });
  });

  it('exposes a single default model per provider', () => {
    for (const provider of listProviders()) {
      const llmDefaults = listProviderLlmModels(provider.id).filter((model) => model.default);
      expect(llmDefaults.length).toBeLessThanOrEqual(1);
    }
  });
});
