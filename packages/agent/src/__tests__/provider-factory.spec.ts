import { describe, expect, it } from 'vitest';
import { isMastraAgentError } from '../mastra/mastra-agent-error';
import {
  createEmbeddingProvider,
  createProvider,
  getDefaultModel,
} from '../providers/provider-factory';
import { listProviderModels, listProviders } from '../providers/registry';

describe('provider-factory', () => {
  describe('createProvider', () => {
    it('creates OpenAI provider with default model', () => {
      const model = createProvider('openai', 'test-key') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-5.6-terra');
    });

    it('creates OpenAI provider with custom model', () => {
      const model = createProvider('openai', 'test-key', 'gpt-5.4') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-5.4');
    });

    it('creates Anthropic provider with default model', () => {
      const model = createProvider('anthropic', 'test-key') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('claude-sonnet-5');
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
      expect(createProvider('openrouter', 'test-key')).toEqual({
        apiKey: 'test-key',
        id: 'openrouter/openai/gpt-5.6-terra',
      });
    });

    it('uses Mastra model-router config for an OpenRouter model', () => {
      expect(createProvider('openrouter', 'test-key', 'z-ai/glm-5.2')).toEqual({
        apiKey: 'test-key',
        id: 'openrouter/z-ai/glm-5.2',
      });
    });

    it('creates Ollama provider with custom model', () => {
      expect(createProvider('ollama', undefined, 'qwen2.5:latest')).toEqual({
        apiKey: 'ollama',
        id: 'ollama/qwen2.5:latest',
        url: 'http://127.0.0.1:11434/v1',
      });
    });

    it('creates LM Studio provider with custom model', () => {
      expect(createProvider('lmstudio', undefined, 'qwen2.5')).toEqual({
        apiKey: 'lmstudio',
        id: 'lmstudio/qwen2.5',
        url: 'http://127.0.0.1:1234/v1',
      });
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
      expect(getDefaultModel('openai')).toBe('gpt-5.6-terra');
    });

    it('returns correct default for Anthropic', () => {
      expect(getDefaultModel('anthropic')).toBe('claude-sonnet-5');
    });

    it('returns correct default for Google', () => {
      expect(getDefaultModel('google')).toBe('gemini-3.5-flash');
    });

    it('returns correct default for OpenRouter', () => {
      expect(getDefaultModel('openrouter')).toBe('openai/gpt-5.6-terra');
    });

    it('throws for an unsupported provider', () => {
      expect(() => getDefaultModel('unsupported')).toThrow(/Unsupported provider/);
    });

    it('returns an explicit unset default for a supported dynamic provider', () => {
      expect(getDefaultModel('ollama')).toBe('');
    });
  });

  describe('createEmbeddingProvider', () => {
    it('creates OpenAI embedding provider with the requested model', () => {
      const model = createEmbeddingProvider('openai', 'test-key', 'text-embedding-3-small') as {
        modelId: string;
      };

      expect(model).toBeDefined();
      expect(model.modelId).toBe('text-embedding-3-small');
    });

    it('creates Google embedding provider with the requested model', () => {
      const model = createEmbeddingProvider('google', 'test-key', 'gemini-embedding-001') as {
        modelId: string;
      };

      expect(model).toBeDefined();
      expect(model.modelId).toBe('gemini-embedding-001');
    });

    it('throws MastraAgentError for unsupported embedding provider names', () => {
      try {
        createEmbeddingProvider('unsupported', 'test-key', 'model');
        throw new Error('Expected unsupported embedding provider to throw');
      } catch (error) {
        expect(isMastraAgentError(error)).toBe(true);
        if (isMastraAgentError(error)) {
          expect(error.code).toBe('mastra_agent_unsupported_provider');
          expect(error.context).toEqual(
            expect.objectContaining({
              provider: 'unsupported',
              supportedProviders: expect.arrayContaining(['openai', 'google']),
            })
          );
        }
      }
    });

    it('throws MastraAgentError for providers without hosted Mastra embedders', () => {
      try {
        createEmbeddingProvider('anthropic', 'test-key', 'claude-embedding');
        throw new Error('Expected unsupported Mastra embedder provider to throw');
      } catch (error) {
        expect(isMastraAgentError(error)).toBe(true);
        if (isMastraAgentError(error)) {
          expect(error.code).toBe('mastra_agent_unsupported_provider');
          expect(error.context).toEqual(
            expect.objectContaining({
              provider: 'anthropic',
              supportedProviders: expect.arrayContaining(['openai', 'google']),
            })
          );
        }
      }
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
