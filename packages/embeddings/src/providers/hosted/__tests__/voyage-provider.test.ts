/**
 * Unit tests for Voyage AI embedding provider
 */

import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingInput } from '../../../provider-types';
import { VoyageEmbeddingProvider } from '../voyage-provider';

// Mock fetch implementation
const createMockFetch = (response: Response) => vi.fn(() => Promise.resolve(response));

describe('VoyageEmbeddingProvider', () => {
  const mockApiKey = 'test-voyage-api-key';
  const mockModelId = 'voyage-3';

  describe('initialization', () => {
    it('should initialize with required parameters', () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      expect(provider.runtime).toBe('hosted');
      expect(provider.provider).toBe('voyage');
      expect(provider.hasApiKey()).toBe(true);
    });

    it('should initialize with optional inputType', () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        inputType: 'query',
        modelId: mockModelId,
      });

      expect(provider.hasApiKey()).toBe(true);
    });

    it('should handle empty API key', () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: '',
        modelId: mockModelId,
      });

      expect(provider.hasApiKey()).toBe(false);
    });

    it('should trim and normalize API key', () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: '  test-key  ',
        modelId: mockModelId,
      });

      expect(provider.hasApiKey()).toBe(true);
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is present', async () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('should return false when API key is missing', async () => {
      const provider = new VoyageEmbeddingProvider({
        modelId: mockModelId,
      });

      const available = await provider.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe('setApiKey', () => {
    it('should update API key', () => {
      const provider = new VoyageEmbeddingProvider({
        modelId: mockModelId,
      });

      expect(provider.hasApiKey()).toBe(false);

      provider.setApiKey('new-api-key');
      expect(provider.hasApiKey()).toBe(true);
    });

    it('should handle empty string', () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      provider.setApiKey('');
      expect(provider.hasApiKey()).toBe(false);
    });
  });

  describe('getModelInfo', () => {
    it('should return model info for known model', () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const info = provider.getModelInfo('voyage-3');
      expect(info).toBeDefined();
      expect(info?.id).toBe('voyage-3');
      expect(info?.dimensions).toBe(1024);
    });

    it('should return model info for voyage-3-lite', () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: 'voyage-3-lite',
      });

      const info = provider.getModelInfo('voyage-3-lite');
      expect(info).toBeDefined();
      expect(info?.id).toBe('voyage-3-lite');
      expect(info?.dimensions).toBe(512);
    });

    it('should return null for unknown model', () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const info = provider.getModelInfo('unknown-model');
      expect(info).toBeNull();
    });
  });

  describe('getMetadata (BST-167)', () => {
    it('should return unified provider metadata for voyage-3', () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const metadata = provider.getMetadata('voyage-3');
      expect(metadata).toBeDefined();
      expect(metadata?.providerId).toBe('voyage');
      expect(metadata?.modelKey).toBe('voyage-3');
      expect(metadata?.dimensions).toBe(1024);
      expect(metadata?.distance).toBe('cosine');
      expect(metadata?.displayName).toBe('Voyage 3');
    });

    it('should return metadata for voyage-3-lite with correct dimensions', () => {
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: 'voyage-3-lite',
      });

      const metadata = provider.getMetadata('voyage-3-lite');
      expect(metadata).toBeDefined();
      expect(metadata?.providerId).toBe('voyage');
      expect(metadata?.modelKey).toBe('voyage-3-lite');
      expect(metadata?.dimensions).toBe(512);
      expect(metadata?.displayName).toBe('Voyage 3 Lite');
    });

    it('should return null for unknown model', () => {
      const provider = new VoyageEmbeddingProvider({
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
          data: [{ embedding: mockEmbedding, index: 0 }],
          model: mockModelId,
          usage: { total_tokens: 10 },
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
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
        expect(result.value.provider).toBe('voyage');
        expect(result.value.usage?.inputTokens).toBe(10);
      }

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.voyageai.com/v1/embeddings',
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
      const provider = new VoyageEmbeddingProvider({
        modelId: mockModelId,
      });

      const input: EmbeddingInput = {
        modelId: mockModelId,
        text: 'test text',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'missing_api_key') {
        expect(result.error.provider).toBe('voyage');
      }
    });

    it('should return error when fetch is unavailable', async () => {
      // Create a provider that will use globalThis.fetch which exists but will fail
      const mockFetch = vi.fn(() => Promise.reject(new Error('Fetch not available')));
      const provider = new VoyageEmbeddingProvider({
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
        expect(result.error.provider).toBe('voyage');
      }
    });

    it('should handle 429 rate limit error with numeric Retry-After', async () => {
      const mockResponse = new Response(
        JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
        {
          headers: { 'Retry-After': '60' },
          status: 429,
        }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
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
        expect(result.error.provider).toBe('voyage');
        expect(result.error.retryAfter).toBe(60);
      }
    });

    it('should handle 429 rate limit error with date Retry-After', async () => {
      const futureDate = new Date(Date.now() + 60_000).toUTCString();
      const mockResponse = new Response(
        JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
        {
          headers: { 'Retry-After': futureDate },
          status: 429,
        }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
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
        expect(result.error.provider).toBe('voyage');
        expect(result.error.retryAfter).toBeGreaterThan(0);
      }
    });

    it('should handle 429 rate limit error without Retry-After', async () => {
      const mockResponse = new Response(
        JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
        {
          status: 429,
        }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
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
        expect(result.error.provider).toBe('voyage');
        expect(result.error.retryAfter).toBeUndefined();
      }
    });

    it('should handle 401 unauthorized error', async () => {
      const mockResponse = new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401,
      });

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
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
        expect(result.error.provider).toBe('voyage');
        expect(result.error.statusCode).toBe(401);
        expect(result.error.message).toContain('Invalid API key');
      }
    });

    it('should handle generic API error', async () => {
      const mockResponse = new Response(JSON.stringify({ error: { message: 'Server error' } }), {
        status: 500,
      });

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
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
        expect(result.error.statusCode).toBe(500);
      }
    });

    it('should handle network error', async () => {
      const mockFetch = vi.fn(() => Promise.reject(new Error('Network failure')));
      const provider = new VoyageEmbeddingProvider({
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
        expect(result.error.provider).toBe('voyage');
        expect(result.error.originalError.message).toBe('Network failure');
      }
    });

    it('should handle missing embedding in response', async () => {
      const mockResponse = new Response(JSON.stringify({ data: [] }), { status: 200 });

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
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
        expect(result.error.message).toContain('did not include data array');
      }
    });

    it('should handle dimension mismatch', async () => {
      const wrongDimensions = new Array(512).fill(0).map(() => Math.random());
      const mockResponse = new Response(
        JSON.stringify({
          data: [{ embedding: wrongDimensions }],
        }),
        { status: 200 }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
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
      }
    });

    it('should include inputType in request when specified', async () => {
      const mockEmbedding = new Array(1024).fill(0).map(() => Math.random());
      const mockResponse = new Response(
        JSON.stringify({
          data: [{ embedding: mockEmbedding }],
        }),
        { status: 200 }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        fetch: mockFetch as typeof fetch,
        inputType: 'query',
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
      expect(requestBody.input_type).toBe('query');
    });

    it('should not include inputType in request when not specified', async () => {
      const mockEmbedding = new Array(1024).fill(0).map(() => Math.random());
      const mockResponse = new Response(
        JSON.stringify({
          data: [{ embedding: mockEmbedding }],
        }),
        { status: 200 }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        fetch: mockFetch as typeof fetch,
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
      expect(requestBody.input_type).toBeUndefined();
    });

    it('should support all inputType options', async () => {
      const mockEmbedding = new Array(1024).fill(0).map(() => Math.random());
      const inputTypes = ['document', 'query'] as const;

      for (const inputType of inputTypes) {
        const mockResponse = new Response(
          JSON.stringify({
            data: [{ embedding: mockEmbedding }],
          }),
          { status: 200 }
        );

        const mockFetch = createMockFetch(mockResponse);
        const provider = new VoyageEmbeddingProvider({
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
      const customEndpoint = 'https://custom.endpoint.com/embeddings';
      const mockEmbedding = new Array(1024).fill(0).map(() => Math.random());
      const mockResponse = new Response(
        JSON.stringify({
          data: [{ embedding: mockEmbedding }],
        }),
        { status: 200 }
      );

      const mockFetch = createMockFetch(mockResponse);
      const provider = new VoyageEmbeddingProvider({
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
      const provider = new VoyageEmbeddingProvider({
        apiKey: mockApiKey,
        modelId: mockModelId,
      });

      const embedding = new Array(1024).fill(0);
      const result = provider.validateDimensions(embedding, 1024);

      expect(result.ok).toBe(true);
    });

    it('should detect dimension mismatch', () => {
      const provider = new VoyageEmbeddingProvider({
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
