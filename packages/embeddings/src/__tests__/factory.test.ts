import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingProviderFactory } from '../factory.js';
import type { EmbeddingProviderConfig } from '../provider-types.js';

const originalFetch = globalThis.fetch;

describe('EmbeddingProviderFactory', () => {
  beforeEach(async () => {
    // Clear cache before each test
    await EmbeddingProviderFactory.clearCache();
    EmbeddingProviderFactory.clearHostedApiKeyCache();
  });

  afterEach(async () => {
    // Clean up after each test
    await EmbeddingProviderFactory.clearCache();
    EmbeddingProviderFactory.clearHostedApiKeyCache();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('provider caching', () => {
    beforeEach(() => {
      vi.stubEnv('BRAINSTRIKE_OPENAI_API_KEY', 'test-openai-key');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns cached instance for same config', async () => {
      const config: EmbeddingProviderConfig = {
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      const result1 = await EmbeddingProviderFactory.createProvider(config);
      const result2 = await EmbeddingProviderFactory.createProvider(config);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Should be the same instance
        expect(result1.value).toBe(result2.value);
      }
    });

    it('creates different instances for different models', async () => {
      const config1: EmbeddingProviderConfig = {
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      const config2: EmbeddingProviderConfig = {
        dimensions: 3072,
        modelId: 'text-embedding-3-large',
        provider: 'openai',
      };

      const result1 = await EmbeddingProviderFactory.createProvider(config1);
      const result2 = await EmbeddingProviderFactory.createProvider(config2);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Should be different instances
        expect(result1.value).not.toBe(result2.value);
      }
    });
  });

  describe('hosted provider creation', () => {
    const OPENAI_ENV_KEY = 'BRAINSTRIKE_OPENAI_API_KEY';
    const GOOGLE_ENV_KEY = 'GOOGLE_GENERATIVE_AI_API_KEY';

    afterEach(() => {
      process.env[OPENAI_ENV_KEY] = undefined;
      process.env['GOOGLE_API_KEY'] = undefined;
      process.env[GOOGLE_ENV_KEY] = undefined;
      EmbeddingProviderFactory.clearHostedApiKeyCache();
    });

    it('returns missing_api_key when no credentials are configured', async () => {
      const config: EmbeddingProviderConfig = {
        dimensions: DEFAULT_EMBEDDING_DIMENSION,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          provider: 'openai',
          type: 'missing_api_key',
        });
      }
    });

    it('creates an OpenAI provider and generates embeddings', async () => {
      process.env[OPENAI_ENV_KEY] = 'test-openai-key';
      EmbeddingProviderFactory.clearHostedApiKeyCache('openai');

      const mockEmbedding = new Array(DEFAULT_EMBEDDING_DIMENSION).fill(0.1);
      const fetchMock = vi.fn().mockResolvedValue({
        headers: new Headers(),
        json: async () => ({
          data: [{ embedding: mockEmbedding }],
          usage: { prompt_tokens: 12 },
        }),
        ok: true,
        status: 200,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const config: EmbeddingProviderConfig = {
        dimensions: DEFAULT_EMBEDDING_DIMENSION,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);
      expect(result.ok).toBe(true);

      if (result.ok) {
        const embedResult = await result.value.embed({
          modelId: 'text-embedding-3-small',
          text: 'Hello world',
        });

        expect(embedResult.ok).toBe(true);
        if (embedResult.ok) {
          expect(embedResult.value.provider).toBe('openai');
          expect(embedResult.value.embedding).toHaveLength(DEFAULT_EMBEDDING_DIMENSION);
          expect(embedResult.value.usage?.inputTokens).toBe(12);
        }

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const callArgs = fetchMock.mock.calls[0];
        expect(callArgs).toBeDefined();
        const [url, init] = callArgs as [RequestInfo | URL, RequestInit | undefined];
        expect(url).toBe('https://api.openai.com/v1/embeddings');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSION);
        expect(body.model).toBe('text-embedding-3-small');
      }
    });

    it('creates a Google provider with output dimensionality override', async () => {
      process.env[GOOGLE_ENV_KEY] = 'test-google-key';
      EmbeddingProviderFactory.clearHostedApiKeyCache('google');

      const targetDimensions = 768;
      const mockEmbedding = new Array(targetDimensions).fill(0.05);
      const fetchMock = vi.fn().mockResolvedValue({
        headers: new Headers(),
        json: async () => ({
          embedding: { values: mockEmbedding },
          usageMetadata: { totalTokenCount: 8 },
        }),
        ok: true,
        status: 200,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const config: EmbeddingProviderConfig = {
        modelId: 'gemini-embedding-001',
        outputDimensionality: targetDimensions,
        provider: 'google',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);
      expect(result.ok).toBe(true);

      if (result.ok) {
        const embedResult = await result.value.embed({
          modelId: 'gemini-embedding-001',
          text: 'Document passage',
        });

        expect(embedResult.ok).toBe(true);
        if (embedResult.ok) {
          expect(embedResult.value.provider).toBe('google');
          expect(embedResult.value.embedding).toHaveLength(targetDimensions);
          expect(embedResult.value.usage?.inputTokens).toBe(8);
        }

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const callArgs = fetchMock.mock.calls[0];
        expect(callArgs).toBeDefined();
        const [url, init] = callArgs as [RequestInfo | URL, RequestInit | undefined];
        expect(url).toBe(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent'
        );
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe('models/gemini-embedding-001');
        expect(body.outputDimensionality).toBe(targetDimensions);
        expect(body.content.parts[0].text).toBe('Document passage');
      }
    });

    it('creates a Cohere provider with inputType and generates embeddings', async () => {
      process.env['COHERE_API_KEY'] = 'test-cohere-key';
      EmbeddingProviderFactory.clearHostedApiKeyCache('cohere');

      const mockEmbedding = new Array(1024).fill(0.1);
      const fetchMock = vi.fn().mockResolvedValue({
        headers: new Headers(),
        json: async () => ({
          embeddings: { float: [mockEmbedding] },
          texts: ['test'],
        }),
        ok: true,
        status: 200,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const config: EmbeddingProviderConfig = {
        inputType: 'search_document',
        modelId: 'embed-english-v3.0',
        provider: 'cohere',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);
      expect(result.ok).toBe(true);

      if (result.ok) {
        const embedResult = await result.value.embed({
          modelId: 'embed-english-v3.0',
          text: 'test text',
        });

        expect(embedResult.ok).toBe(true);
        if (embedResult.ok) {
          expect(embedResult.value.provider).toBe('cohere');
          expect(embedResult.value.embedding).toHaveLength(1024);
        }
      }

      process.env['COHERE_API_KEY'] = undefined;
    });

    it('creates a Voyage provider with inputType and generates embeddings', async () => {
      process.env['VOYAGE_API_KEY'] = 'test-voyage-key';
      EmbeddingProviderFactory.clearHostedApiKeyCache('voyage');

      const mockEmbedding = new Array(1024).fill(0.1);
      const fetchMock = vi.fn().mockResolvedValue({
        headers: new Headers(),
        json: async () => ({
          data: [{ embedding: mockEmbedding, index: 0 }],
          model: 'voyage-3',
          usage: { total_tokens: 5 },
        }),
        ok: true,
        status: 200,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const config: EmbeddingProviderConfig = {
        inputType: 'document',
        modelId: 'voyage-3',
        provider: 'voyage',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);
      expect(result.ok).toBe(true);

      if (result.ok) {
        const embedResult = await result.value.embed({
          modelId: 'voyage-3',
          text: 'test text',
        });

        expect(embedResult.ok).toBe(true);
        if (embedResult.ok) {
          expect(embedResult.value.provider).toBe('voyage');
          expect(embedResult.value.embedding).toHaveLength(1024);
          expect(embedResult.value.usage?.inputTokens).toBe(5);
        }
      }

      process.env['VOYAGE_API_KEY'] = undefined;
    });
  });

  describe('cache management', () => {
    beforeEach(() => {
      vi.stubEnv('BRAINSTRIKE_OPENAI_API_KEY', 'test-openai-key');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('getCachedProvider returns cached instance', async () => {
      const config: EmbeddingProviderConfig = {
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      const createResult = await EmbeddingProviderFactory.createProvider(config);
      expect(createResult.ok).toBe(true);

      // An OpenAI provider's variant is its dimensions
      const cached = EmbeddingProviderFactory.getCachedProvider(
        'openai',
        'text-embedding-3-small',
        '1536'
      );
      expect(cached).toBeDefined();

      if (createResult.ok) {
        expect(cached).toBe(createResult.value);
      }
    });

    it('getCachedProvider returns undefined for non-existent provider', () => {
      const cached = EmbeddingProviderFactory.getCachedProvider('openai', 'nonexistent', 'default');
      expect(cached).toBeUndefined();
    });

    it('removeProvider removes from cache', async () => {
      const config: EmbeddingProviderConfig = {
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      await EmbeddingProviderFactory.createProvider(config);

      const removed = await EmbeddingProviderFactory.removeProvider(
        'openai',
        'text-embedding-3-small',
        '1536'
      );
      expect(removed).toBe(true);

      const cached = EmbeddingProviderFactory.getCachedProvider(
        'openai',
        'text-embedding-3-small',
        '1536'
      );
      expect(cached).toBeUndefined();
    });

    it('removeProvider returns false for non-existent provider', async () => {
      const removed = await EmbeddingProviderFactory.removeProvider(
        'openai',
        'nonexistent',
        'default'
      );
      expect(removed).toBe(false);
    });

    it('clearCache removes all providers', async () => {
      const config1: EmbeddingProviderConfig = {
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      const config2: EmbeddingProviderConfig = {
        dimensions: 3072,
        modelId: 'text-embedding-3-large',
        provider: 'openai',
      };

      await EmbeddingProviderFactory.createProvider(config1);
      await EmbeddingProviderFactory.createProvider(config2);

      const statsBefore = EmbeddingProviderFactory.getCacheStats();
      expect(statsBefore.size).toBe(2);

      await EmbeddingProviderFactory.clearCache();

      const statsAfter = EmbeddingProviderFactory.getCacheStats();
      expect(statsAfter.size).toBe(0);
      expect(statsAfter.providers).toEqual([]);
    });

    it('getCacheStats returns correct statistics', async () => {
      const config1: EmbeddingProviderConfig = {
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      const config2: EmbeddingProviderConfig = {
        dimensions: 3072,
        modelId: 'text-embedding-3-large',
        provider: 'openai',
      };

      await EmbeddingProviderFactory.createProvider(config1);
      await EmbeddingProviderFactory.createProvider(config2);

      const stats = EmbeddingProviderFactory.getCacheStats();

      expect(stats.size).toBe(2);
      expect(stats.providers).toHaveLength(2);
      expect(stats.providers).toEqual(
        expect.arrayContaining([
          { modelId: 'text-embedding-3-small', provider: 'openai', variant: '1536' },
          { modelId: 'text-embedding-3-large', provider: 'openai', variant: '3072' },
        ])
      );
    });

    it('creates different instances for different dimension settings', async () => {
      const config1: EmbeddingProviderConfig = {
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      const config2: EmbeddingProviderConfig = {
        dimensions: 512,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      const result1 = await EmbeddingProviderFactory.createProvider(config1);
      const result2 = await EmbeddingProviderFactory.createProvider(config2);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Should be different instances due to different dimensions
        expect(result1.value).not.toBe(result2.value);
      }

      // Verify both are in cache with different keys
      const cached1 = EmbeddingProviderFactory.getCachedProvider(
        'openai',
        'text-embedding-3-small',
        '1536'
      );
      const cached2 = EmbeddingProviderFactory.getCachedProvider(
        'openai',
        'text-embedding-3-small',
        '512'
      );

      expect(cached1).toBeDefined();
      expect(cached2).toBeDefined();
      expect(cached1).not.toBe(cached2);

      const stats = EmbeddingProviderFactory.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.providers).toEqual(
        expect.arrayContaining([
          { modelId: 'text-embedding-3-small', provider: 'openai', variant: '1536' },
          { modelId: 'text-embedding-3-small', provider: 'openai', variant: '512' },
        ])
      );
    });
  });

  describe('provider interface conformance', () => {
    beforeEach(() => {
      vi.stubEnv('BRAINSTRIKE_OPENAI_API_KEY', 'test-openai-key');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('created provider implements IEmbeddingProvider', async () => {
      const config: EmbeddingProviderConfig = {
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const provider = result.value;

        // Check interface methods exist
        expect(typeof provider.embed).toBe('function');
        expect(typeof provider.isAvailable).toBe('function');
        expect(typeof provider.getModelInfo).toBe('function');
        expect(typeof provider.validateDimensions).toBe('function');
      }
    });
  });
});
