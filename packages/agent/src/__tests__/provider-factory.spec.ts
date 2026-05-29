import { describe, expect, it } from 'vitest';
import { isMastraAgentError } from '../mastra/mastra-agent-error';
import { createProvider, getDefaultModel } from '../providers/provider-factory';
import { listProviderModels, listProviders } from '../providers/registry';

describe('provider-factory', () => {
  describe('createProvider', () => {
    it('creates OpenAI provider with default model', () => {
      const model = createProvider('openai', 'test-key') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-5.4');
    });

    it('creates OpenAI provider with custom model', () => {
      const model = createProvider('openai', 'test-key', 'gpt-5.4') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-5.4');
    });

    it('creates Anthropic provider with default model', () => {
      const model = createProvider('anthropic', 'test-key') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('claude-sonnet-4-6');
    });

    it('creates Anthropic provider with custom model', () => {
      const model = createProvider('anthropic', 'test-key', 'claude-sonnet-4-6') as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('claude-sonnet-4-6');
    });

    it('creates Google provider with default model', () => {
      const model = createProvider('google', 'test-key') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gemini-3.5-flash');
    });

    it('creates Google provider with custom model', () => {
      const model = createProvider('google', 'test-key', 'gemini-3.5-flash') as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gemini-3.5-flash');
    });

    it('creates OpenRouter provider with default model', () => {
      const model = createProvider('openrouter', 'test-key') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('openai/gpt-5.4');
    });

    it('creates OpenRouter provider with custom model', () => {
      const model = createProvider('openrouter', 'test-key', 'anthropic/claude-sonnet-4.5') as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('anthropic/claude-sonnet-4.5');
    });

    it('creates Ollama provider with custom model', () => {
      const model = createProvider('ollama', undefined, 'qwen2.5:latest') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('qwen2.5:latest');
    });

    it('creates LM Studio provider with custom model', () => {
      const model = createProvider('lmstudio', undefined, 'qwen2.5') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('qwen2.5');
    });

    it('throws when local runtime provider has no selected model', () => {
      expect(() => createProvider('ollama')).toThrowError();
    });

    it('throws MastraAgentError for unsupported provider', () => {
      try {
        createProvider('unsupported', 'test-key');
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
                'local',
                'ollama',
                'lmstudio',
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
      expect(getDefaultModel('openai')).toBe('gpt-5.4');
    });

    it('returns correct default for Anthropic', () => {
      expect(getDefaultModel('anthropic')).toBe('claude-sonnet-4-6');
    });

    it('returns correct default for Google', () => {
      expect(getDefaultModel('google')).toBe('gemini-3.5-flash');
    });

    it('returns correct default for OpenRouter', () => {
      expect(getDefaultModel('openrouter')).toBe('openai/gpt-5.4');
    });

    it('falls back to OpenAI default for unsupported provider', () => {
      expect(getDefaultModel('unsupported')).toBe('gpt-5.4');
    });
  });

  it('exposes a single default model per provider and type', () => {
    for (const provider of listProviders()) {
      const llmDefaults = listProviderModels(provider.id, 'llm').filter((model) => model.default);
      expect(llmDefaults.length).toBeLessThanOrEqual(1);
      const embeddingDefaults = listProviderModels(provider.id, 'embedding').filter(
        (model) => model.default
      );
      expect(embeddingDefaults.length).toBeLessThanOrEqual(1);
    }
  });
});
