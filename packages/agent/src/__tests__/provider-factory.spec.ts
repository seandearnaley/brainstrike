import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMastraAgentError } from '../mastra-boundary/mastra-agent-error';
import {
  createEmbeddingProvider,
  createLanguageModelProvider,
  createProvider,
  getDefaultModel,
} from '../providers/provider-factory';
import { listProviderModels, listProviders } from '../providers/registry';

describe('provider-factory', () => {
  describe('createProvider', () => {
    it('creates OpenAI provider with default model', () => {
      const model = createProvider('openai', { apiKey: 'test-key', kind: 'api_key' }) as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-5.6-terra');
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
      expect(model.modelId).toBe('claude-sonnet-5');
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
      expect(model.modelId).toBe('gemini-3.5-flash');
    });

    it('creates Google provider with custom model', () => {
      const model = createProvider(
        'google',
        { apiKey: 'test-key', kind: 'api_key' },
        'gemini-3.5-flash'
      ) as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gemini-3.5-flash');
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

    it('creates Ollama provider with custom model', () => {
      expect(createProvider('ollama', undefined, 'qwen2.5:latest')).toEqual({
        apiKey: 'ollama',
        modelId: 'qwen2.5:latest',
        providerId: 'ollama',
        url: 'http://127.0.0.1:11434/v1',
      });
    });

    it('creates LM Studio provider with custom model', () => {
      expect(createProvider('lmstudio', undefined, 'qwen2.5')).toEqual({
        apiKey: 'lmstudio',
        modelId: 'qwen2.5',
        providerId: 'lmstudio',
        url: 'http://127.0.0.1:1234/v1',
      });
    });

    // Mastra 1.78 types the local runtime config as `{ providerId, modelId }`;
    // its router normalizes that to the same `provider/model` route as the
    // older `{ id }` shape. Observe the actual routed request, not the shape.
    describe.each([
      { model: 'qwen2.5:latest', runtime: 'ollama', url: 'http://127.0.0.1:11434/v1' },
      { model: 'qwen2.5', runtime: 'lmstudio', url: 'http://127.0.0.1:1234/v1' },
    ] as const)('$runtime model config through the Mastra router', ({ model, runtime, url }) => {
      afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      });

      async function route(config: ConstructorParameters<typeof ModelRouterLanguageModel>[0]) {
        const requests: { authorization: string | null; url: string }[] = [];
        const captured = new Error('request captured');
        vi.stubEnv('OPENAI_API_KEY', 'sk-env-key-must-not-leak');
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push({
            authorization: new Headers(init?.headers).get('authorization'),
            url: String(input),
          });
          throw captured;
        });
        const router = new ModelRouterLanguageModel(config);
        await expect(
          router.doStream({ prompt: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }] })
        ).rejects.toBe(captured);
        return { modelId: router.modelId, provider: router.provider, requests };
      }

      it('routes to the configured URL with the explicit local key', async () => {
        const config = createProvider(runtime, undefined, model);
        if (config instanceof ModelRouterLanguageModel || !('providerId' in config)) {
          throw new Error('Expected the canonical OpenAI-compatible model config');
        }
        const routed = await route(config);
        expect(routed).toEqual({
          modelId: model,
          provider: runtime,
          requests: [{ authorization: `Bearer ${runtime}`, url: `${url}/chat/completions` }],
        });
        // The route the previous `{ id, url, apiKey }` shape produced.
        expect(await route({ apiKey: runtime, id: `${runtime}/${model}`, url })).toEqual(routed);
      });
    });

    it('throws when local runtime provider has no selected model', () => {
      expect(() => createProvider('ollama')).toThrowError();
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
        /requires an explicit API key/i
      );
    });

    it('rejects providers outside the persistent-memory model boundary', () => {
      expect(() => createLanguageModelProvider('ollama', undefined, 'qwen3:latest')).toThrow(
        /does not support provider: ollama/i
      );
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
