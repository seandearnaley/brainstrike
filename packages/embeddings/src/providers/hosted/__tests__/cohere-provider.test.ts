/**
 * Unit tests for Cohere embedding provider
 */

import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingInput } from '../../../provider-types';
import { CohereEmbeddingProvider } from '../cohere-provider';

// Mock fetch implementation
const createMockFetch = (response: Response) => vi.fn(() => Promise.resolve(response));

describe('CohereEmbeddingProvider', () => {
  const mockApiKey = 'test-cohere-api-key';
  const mockModelId = 'embed-english-v3.0';

  describe('initialization', () => {
    it('should initialize with required parameters', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      expect(provider.runtime).toBe('hosted');
      expect(provider.provider).toBe('cohere');
      expect(provider.hasApiKey()).toBe(true);
    });

    it('should initialize with optional inputType', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        inputType: 'search_query',
        modelId: mockModelId,
      });

      expect(provider.hasApiKey()).toBe(true);
    });

    it('should handle empty API key', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: '',
        modelId: mockModelId,
      });

      expect(provider.hasApiKey()).toBe(false);
    });

    it('should trim and normalize API key', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: '  test-key  ',
        modelId: mockModelId,
      });

      expect(provider.hasApiKey()).toBe(true);
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is present', async () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('should return false when API key is missing', async () => {
      const provider = new CohereEmbeddingProvider({
        modelId: mockModelId,
      });

      const available = await provider.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe('setApiKey', () => {
    it('should update API key', () => {
      const provider = new CohereEmbeddingProvider({
        modelId: mockModelId,
      });

      expect(provider.hasApiKey()).toBe(false);

      provider.setApiKey('new-api-key');
      expect(provider.hasApiKey()).toBe(true);
    });

    it('should handle empty string', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      provider.setApiKey('');
      expect(provider.hasApiKey()).toBe(false);
    });
  });

  describe('getModelInfo', () => {
    it('should return model info for known model', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const info = provider.getModelInfo('embed-english-v3.0');
      expect(info).toBeDefined();
      expect(info?.id).toBe('embed-english-v3.0');
      expect(info?.dimensions).toBe(1024);
    });

    it('should return null for unknown model', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const info = provider.getModelInfo('unknown-model');
      expect(info).toBeNull();
    });
  });

  describe('getMetadata (BST-167)', () => {
    it('should return unified provider metadata for known model', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const metadata = provider.getMetadata('embed-english-v3.0');
      expect(metadata).toBeDefined();
      expect(metadata?.providerId).toBe('cohere');
      expect(metadata?.modelKey).toBe('embed-english-v3.0');
      expect(metadata?.dimensions).toBe(1024);
      expect(metadata?.distance).toBe('cosine');
      expect(metadata?.displayName).toBe('Cohere Embed English v3');
    });

    it('should return metadata for multilingual model', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: 'embed-multilingual-v3.0',
      });

      const metadata = provider.getMetadata('embed-multilingual-v3.0');
      expect(metadata).toBeDefined();
      expect(metadata?.providerId).toBe('cohere');
      expect(metadata?.modelKey).toBe('embed-multilingual-v3.0');
      expect(metadata?.dimensions).toBe(1024);
      expect(metadata?.displayName).toBe('Cohere Embed Multilingual v3');
    });

    it('should return null for unknown model', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const metadata = provider.getMetadata('unknown-model');
      expect(metadata).toBeNull();
    });
  });

  describe('embed', () => {
    it('should successfully generate embeddings', async () => {
      const mockEmbedding = new Array(1024).fill(0).map(() => Math.random());
      const mockResponse = new Response(
        JSON.stringify({
          embeddings: { float: [mockEmbedding] },
          texts: ['test text'],
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        fetch: mockFetch as typeof fetch,
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.embedding).toEqual(mockEmbedding);
        expect(result.value.dimensions).toBe(1024);
        expect(result.value.modelId).toBe(mockModelId);
        expect(result.value.provider).toBe('cohere');
        expect(result.value.usage).toBeUndefined(); // Cohere v2 doesn't return usage in this format
      }

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cohere.com/v2/embed',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockApiKey}`,
            'Content-Type': 'application/json',
          }),
          method: 'POST',
        })
      );
    });

    it('should return error when API key is missing', async () => {
      const provider = new CohereEmbeddingProvider({
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'missing_api_key') {
        expect(result.error.provider).toBe('cohere');
      }
    });

    it('should return error when fetch fails', async () => {
      const mockFetch = vi.fn(() => Promise.reject(new Error('Fetch not available')));
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        fetch: mockFetch as typeof fetch,
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'network_error') {
        expect(result.error.provider).toBe('cohere');
      }
    });

    it('should handle 429 rate limit error', async () => {
      const mockResponse = new Response(
        JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
        {
          headers: { 'Retry-After': '60' },
          status: 429,
        }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        fetch: mockFetch as typeof fetch,
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'rate_limit_exceeded') {
        expect(result.error.provider).toBe('cohere');
        expect(result.error.retryAfter).toBe(60);
      }
    });

    it('should handle 401 unauthorized error', async () => {
      const mockResponse = new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401,
      });

      const mockFetch = createMockFetch(mockResponse);
      const provider = new CohereEmbeddingProvider({
        apiKey: 'invalid-key',
        fetch: mockFetch as typeof fetch,
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'api_error') {
        expect(result.error.provider).toBe('cohere');
        expect(result.error.statusCode).toBe(401);
        expect(result.error.message).toContain('Invalid API key');
      }
    });

    it('should handle network error', async () => {
      const mockFetch = vi.fn(() => Promise.reject(new Error('Network failure')));
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        fetch: mockFetch as typeof fetch,
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'network_error') {
        expect(result.error.provider).toBe('cohere');
        expect(result.error.originalError.message).toBe('Network failure');
      }
    });

    it('should handle missing embedding in response', async () => {
      const mockResponse = new Response(JSON.stringify({ embeddings: [] }), { status: 200 });

      const mockFetch = createMockFetch(mockResponse);
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        fetch: mockFetch as typeof fetch,
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'api_error') {
        expect(result.error.message).toContain('did not include an embedding array');
      }
    });

    it('should handle dimension mismatch', async () => {
      const wrongDimensions = new Array(512).fill(0).map(() => Math.random());
      const mockResponse = new Response(
        JSON.stringify({
          embeddings: { float: [wrongDimensions] },
        }),
        { status: 200 }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        fetch: mockFetch as typeof fetch,
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'dimension_mismatch') {
        expect(result.error.expected).toBe(1024);
        expect(result.error.received).toBe(512);
        expect(result.error.modelId).toBe(mockModelId);
      }
    });

    it('should include inputType in request when specified', async () => {
      const mockEmbedding = new Array(1024).fill(0).map(() => Math.random());
      const mockResponse = new Response(
        JSON.stringify({
          embeddings: { float: [mockEmbedding] },
        }),
        { status: 200 }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        fetch: mockFetch as typeof fetch,
        inputType: 'search_query',
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      await provider.embed(input);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0] as unknown[];
      expect(callArgs.length).toBeGreaterThan(1);
      const requestInit = callArgs[1] as RequestInit;
      const requestBody = JSON.parse(requestInit.body as string);
      expect(requestBody.input_type).toBe('search_query');
    });

    it('should support all inputType options', async () => {
      const mockEmbedding = new Array(1024).fill(0).map(() => Math.random());
      const inputTypes = [
        'search_document',
        'search_query',
        'classification',
        'clustering',
      ] as const;

      for (const inputType of inputTypes) {
        const mockResponse = new Response(
          JSON.stringify({
            embeddings: { float: [mockEmbedding] },
          }),
          { status: 200 }
        );

        const mockFetch = createMockFetch(mockResponse);
        const provider = new CohereEmbeddingProvider({
          apiKey: mockApiKey,
          fetch: mockFetch as typeof fetch,
          inputType,
          modelId: mockModelId,
        });

        const input: EmbeddingInput = {
          modelId: mockModelId,
          text: 'test text',
        };

        const result = await provider.embed(input);
        expect(result.ok).toBe(true);
      }
    });

    it('should use custom endpoint when provided', async () => {
      const customEndpoint = 'https://custom.endpoint.com/embed';
      const mockEmbedding = new Array(1024).fill(0).map(() => Math.random());
      const mockResponse = new Response(
        JSON.stringify({
          embeddings: { float: [mockEmbedding] },
        }),
        { status: 200 }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        endpoint: customEndpoint,
        fetch: mockFetch as typeof fetch,
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      await provider.embed(input);

      expect(mockFetch).toHaveBeenCalledWith(
        customEndpoint,
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('validateDimensions', () => {
    it('should validate correct dimensions', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const embedding = new Array(1024).fill(0);
      const result = provider.validateDimensions(embedding, 1024);

      expect(result.ok).toBe(true);
    });

    it('should detect dimension mismatch', () => {
      const provider = new CohereEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const embedding = new Array(512).fill(0);
      const result = provider.validateDimensions(embedding, 1024);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'dimension_mismatch') {
        expect(result.error.expected).toBe(1024);
        expect(result.error.received).toBe(512);
      }
    });
  });
});
