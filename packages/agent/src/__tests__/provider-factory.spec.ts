import {
  listProviderLlmModels,
  listProviders,
} from '@brainstrike/assistant-contract/provider-registry';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { describe, expect, it } from 'vitest';
import { isMastraAgentError } from '../mastra-boundary/mastra-agent-error';
import { createProvider, getDefaultModel } from '../providers/provider-factory';

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
