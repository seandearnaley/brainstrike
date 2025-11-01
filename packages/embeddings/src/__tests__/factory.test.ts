import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingProviderFactory } from '../factory';
import type { ILocalEmbeddingProvider } from '../interfaces/provider';
import type { EmbeddingProviderConfig } from '../provider-types';

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

  describe('local provider creation', () => {
    it('creates a local provider instance', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        const provider = result.value as ILocalEmbeddingProvider;
        expect(provider.runtime).toBe('browser');
        expect(provider.provider).toBe('local');
      }
    });

    it('creates provider with quantization config', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
        quantization: 'q8',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
      }
    });

    it('returns cached instance for same config', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
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
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const config2: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'bge-base-en-v1.5',
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
        runtime: 'hosted',
        provider: 'openai',
        modelId: 'text-embedding-3-small',
        dimensions: DEFAULT_EMBEDDING_DIMENSION,
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          type: 'missing_api_key',
          provider: 'openai',
        });
      }
    });

    it('creates an OpenAI provider and generates embeddings', async () => {
      process.env[OPENAI_ENV_KEY] = 'test-openai-key';
      EmbeddingProviderFactory.clearHostedApiKeyCache('openai');

      const mockEmbedding = Array(DEFAULT_EMBEDDING_DIMENSION).fill(0.1);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: [{ embedding: mockEmbedding }],
          usage: { prompt_tokens: 12 },
        }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const config: EmbeddingProviderConfig = {
        runtime: 'hosted',
        provider: 'openai',
        modelId: 'text-embedding-3-small',
        dimensions: DEFAULT_EMBEDDING_DIMENSION,
      };

      const result = await EmbeddingProviderFactory.createProvider(config);
      expect(result.ok).toBe(true);

      if (result.ok) {
        const embedResult = await result.value.embed({
          text: 'Hello world',
          modelId: 'text-embedding-3-small',
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
      const mockEmbedding = Array(targetDimensions).fill(0.05);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          embedding: { values: mockEmbedding },
          usageMetadata: { totalTokenCount: 8 },
        }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const config: EmbeddingProviderConfig = {
        runtime: 'hosted',
        provider: 'google',
        modelId: 'text-embedding-004',
        outputDimensionality: targetDimensions,
      };

      const result = await EmbeddingProviderFactory.createProvider(config);
      expect(result.ok).toBe(true);

      if (result.ok) {
        const embedResult = await result.value.embed({
          text: 'Document passage',
          modelId: 'text-embedding-004',
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
          'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent'
        );
        const body = JSON.parse(String(init?.body));
        expect(body.output_dimensionality).toBe(targetDimensions);
        expect(body.content.parts[0].text).toBe('Document passage');
      }
    });

    it('creates a Cohere provider with inputType and generates embeddings', async () => {
      process.env['COHERE_API_KEY'] = 'test-cohere-key';
      EmbeddingProviderFactory.clearHostedApiKeyCache('cohere');

      const mockEmbedding = Array(1024).fill(0.1);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          embeddings: { float: [mockEmbedding] },
          texts: ['test'],
        }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const config: EmbeddingProviderConfig = {
        runtime: 'hosted',
        provider: 'cohere',
        modelId: 'embed-english-v3.0',
        dimensions: 1024,
        inputType: 'search_document',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);
      expect(result.ok).toBe(true);

      if (result.ok) {
        const embedResult = await result.value.embed({
          text: 'test text',
          modelId: 'embed-english-v3.0',
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

      const mockEmbedding = Array(1024).fill(0.1);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: [{ embedding: mockEmbedding, index: 0 }],
          model: 'voyage-3',
          usage: { total_tokens: 5 },
        }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const config: EmbeddingProviderConfig = {
        runtime: 'hosted',
        provider: 'voyage',
        modelId: 'voyage-3',
        dimensions: 1024,
        inputType: 'document',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);
      expect(result.ok).toBe(true);

      if (result.ok) {
        const embedResult = await result.value.embed({
          text: 'test text',
          modelId: 'voyage-3',
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
    it('getCachedProvider returns cached instance', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const createResult = await EmbeddingProviderFactory.createProvider(config);
      expect(createResult.ok).toBe(true);

      // Default quantization is 'default'
      const cached = EmbeddingProviderFactory.getCachedProvider('local', 'jina-code', 'default');
      expect(cached).toBeDefined();

      if (createResult.ok) {
        expect(cached).toBe(createResult.value);
      }
    });

    it('getCachedProvider returns undefined for non-existent provider', () => {
      const cached = EmbeddingProviderFactory.getCachedProvider('local', 'nonexistent', 'default');
      expect(cached).toBeUndefined();
    });

    it('removeProvider removes from cache', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      await EmbeddingProviderFactory.createProvider(config);

      const removed = await EmbeddingProviderFactory.removeProvider(
        'local',
        'jina-code',
        'default'
      );
      expect(removed).toBe(true);

      const cached = EmbeddingProviderFactory.getCachedProvider('local', 'jina-code', 'default');
      expect(cached).toBeUndefined();
    });

    it('removeProvider returns false for non-existent provider', async () => {
      const removed = await EmbeddingProviderFactory.removeProvider(
        'local',
        'nonexistent',
        'default'
      );
      expect(removed).toBe(false);
    });

    it('clearCache removes all providers', async () => {
      const config1: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const config2: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'bge-base-en-v1.5',
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
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const config2: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'bge-base-en-v1.5',
      };

      await EmbeddingProviderFactory.createProvider(config1);
      await EmbeddingProviderFactory.createProvider(config2);

      const stats = EmbeddingProviderFactory.getCacheStats();

      expect(stats.size).toBe(2);
      expect(stats.providers).toHaveLength(2);
      expect(stats.providers).toEqual(
        expect.arrayContaining([
          { provider: 'local', modelId: 'jina-code', variant: 'default' },
          { provider: 'local', modelId: 'bge-base-en-v1.5', variant: 'default' },
        ])
      );
    });

    it('creates different instances for different quantization settings', async () => {
      const config1: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const config2: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
        quantization: 'q8',
      };

      const result1 = await EmbeddingProviderFactory.createProvider(config1);
      const result2 = await EmbeddingProviderFactory.createProvider(config2);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Should be different instances due to different quantization
        expect(result1.value).not.toBe(result2.value);
      }

      // Verify both are in cache with different keys
      const cached1 = EmbeddingProviderFactory.getCachedProvider('local', 'jina-code', 'default');
      const cached2 = EmbeddingProviderFactory.getCachedProvider('local', 'jina-code', 'q8');

      expect(cached1).toBeDefined();
      expect(cached2).toBeDefined();
      expect(cached1).not.toBe(cached2);

      const stats = EmbeddingProviderFactory.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.providers).toEqual(
        expect.arrayContaining([
          { provider: 'local', modelId: 'jina-code', variant: 'default' },
          { provider: 'local', modelId: 'jina-code', variant: 'q8' },
        ])
      );
    });
  });

  describe('provider interface conformance', () => {
    it('created provider implements IEmbeddingProvider', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
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

    it('local provider implements ILocalEmbeddingProvider', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const provider = result.value as ILocalEmbeddingProvider;

        // Check extended interface methods exist
        expect(typeof provider.initialize).toBe('function');
        expect(typeof provider.dispose).toBe('function');
        expect(typeof provider.getStatus).toBe('function');

        // Check discriminators
        expect(provider.runtime).toBe('browser');
        expect(provider.provider).toBe('local');
      }
    });
  });

  describe('error handling', () => {
    it('creates provider successfully (errors happen during usage)', async () => {
      // Factory doesn't validate model IDs upfront - providers are created successfully
      // and errors only occur during initialization/usage
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'potentially-invalid-model',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      // Provider creation succeeds
      expect(result.ok).toBe(true);

      // Errors would occur later when calling embed() or initialize()
      if (result.ok) {
        const provider = result.value as ILocalEmbeddingProvider;
        expect(provider).toBeDefined();

        // Try to check availability (this will attempt initialization)
        const available = await provider.isAvailable();
        // May or may not be available depending on the model
        expect(typeof available).toBe('boolean');
      }
    });
  });
});
