import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingInput } from '../../../provider-types';
import { OpenAIEmbeddingProvider } from '../openai-provider';

const createMockFetch = (response: Response) => vi.fn(() => Promise.resolve(response));

describe('OpenAIEmbeddingProvider', () => {
  describe('getMetadata (BST-167)', () => {
    it('should return unified provider metadata for text-embedding-3-small', () => {
      const provider = new OpenAIEmbeddingProvider({
        modelId: 'text-embedding-3-small',
        apiKey: 'test-api-key',
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
        modelId: 'text-embedding-3-small',
        apiKey: 'test-api-key',
        targetDimensions: 512,
      });

      const metadata = provider.getMetadata('text-embedding-3-small');
      expect(metadata).toBeDefined();
      expect(metadata?.dimensions).toBe(512);
    });

    it('should return metadata for text-embedding-3-large', () => {
      const provider = new OpenAIEmbeddingProvider({
        modelId: 'text-embedding-3-large',
        apiKey: 'test-api-key',
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
        modelId: 'text-embedding-3-small',
        apiKey: 'test-api-key',
        targetDimensions: 1536,
      });

      const metadata = provider.getMetadata('unknown-model');
      expect(metadata).toBeNull();
    });
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
      modelId: 'text-embedding-3-small',
      apiKey: 'test-api-key',
      fetch: mockFetch as typeof fetch,
      targetDimensions: 3,
    });

    const input: EmbeddingInput = {
      text: 'hello world',
      modelId: 'text-embedding-3-small',
    };

    const result = await provider.embed(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.usage?.inputTokens).toBe(12);
      expect(result.value.usage?.totalTokens).toBe(20);
    }
  });
});
