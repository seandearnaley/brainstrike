import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingInput } from '../../../provider-types';
import { OpenAIEmbeddingProvider } from '../openai-provider';

const createMockFetch = (response: Response) => vi.fn(() => Promise.resolve(response));

describe('OpenAIEmbeddingProvider', () => {
  describe('getMetadata (BST-167)', () => {
    it('should return unified provider metadata for text-embedding-3-small', () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: 'test-api-key',
        modelId: 'text-embedding-3-small',
        targetDimensions: 1536,
      });

      const metadata = provider.getMetadata('text-embedding-3-small');
      expect(metadata).toBeDefined();
      expect(metadata?.providerId).toBe('openai');
      expect(metadata?.modelKey).toBe('text-embedding-3-small');
      expect(metadata?.dimensions).toBe(1536);
      expect(metadata?.distance).toBe('cosine');
      expect(metadata?.displayName).toBe('OpenAI text-embedding-3-small');
    });

    it('should return configured targetDimensions in metadata', () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: 'test-api-key',
        modelId: 'text-embedding-3-small',
        targetDimensions: 512,
      });

      const metadata = provider.getMetadata('text-embedding-3-small');
      expect(metadata).toBeDefined();
      expect(metadata?.dimensions).toBe(512);
    });

    it('should return metadata for text-embedding-3-large', () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: 'test-api-key',
        modelId: 'text-embedding-3-large',
        targetDimensions: 3072,
      });

      const metadata = provider.getMetadata('text-embedding-3-large');
      expect(metadata).toBeDefined();
      expect(metadata?.providerId).toBe('openai');
      expect(metadata?.dimensions).toBe(3072);
      expect(metadata?.displayName).toBe('OpenAI text-embedding-3-large');
    });

    it('should return null for unknown model', () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: 'test-api-key',
        modelId: 'text-embedding-3-small',
        targetDimensions: 1536,
      });

      const metadata = provider.getMetadata('unknown-model');
      expect(metadata).toBeNull();
    });
  });

  it('supports OpenAI-compatible local runtimes without API keys', async () => {
    const mockPayload = {
      data: [
        {
          embedding: [0.1, 0.2, 0.3, 0.4],
        },
      ],
    };
    const mockResponse = new Response(JSON.stringify(mockPayload), { status: 200 });
    let capturedInit: RequestInit | undefined;
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return mockResponse;
    });

    const provider = new OpenAIEmbeddingProvider({
      endpoint: 'http://127.0.0.1:11434/v1/embeddings',
      fetch: mockFetch as typeof fetch,
      includeDimensions: false,
      modelId: 'nomic-embed-text',
      provider: 'ollama',
      requiresApiKey: false,
      targetDimensions: 4,
    });

    expect(await provider.isAvailable()).toBe(true);
    expect(provider.hasApiKey()).toBe(true);

    const result = await provider.embed({
      modelId: 'nomic-embed-text',
      text: 'hello runtime',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider).toBe('ollama');
      expect(result.value.embedding).toHaveLength(4);
    }

    if (!capturedInit) {
      throw new Error('Expected fetch init options for OpenAI-compatible runtime provider');
    }
    const body = JSON.parse(String(capturedInit.body));
    expect(body.dimensions).toBeUndefined();
  });

  it('captures total token usage from successful responses', async () => {
    const mockPayload = {
      data: [
        {
          embedding: [0.1, 0.2, 0.3],
        },
      ],
      usage: {
        prompt_tokens: 12,
        total_tokens: 20,
      },
    };
    const mockResponse = new Response(JSON.stringify(mockPayload), { status: 200 });
    const mockFetch = createMockFetch(mockResponse);

    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'test-api-key',
      fetch: mockFetch as typeof fetch,
      modelId: 'text-embedding-3-small',
      targetDimensions: 3,
    });

    const signal = new AbortController().signal;
    const input: EmbeddingInput = {
      modelId: 'text-embedding-3-small',
      signal,
      text: 'hello world',
    };

    const result = await provider.embed(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.usage?.inputTokens).toBe(12);
      expect(result.value.usage?.totalTokens).toBe(20);
    }
    const call = mockFetch.mock.calls.at(0) as unknown as
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    if (!call) {
      throw new Error('Expected OpenAI fetch to be called.');
    }
    expect(call[1]?.signal).toBe(signal);
  });
});
