import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingInput } from '../../../provider-types';
import { OpenAIEmbeddingProvider } from '../openai-provider';

const createMockFetch = (response: Response) => vi.fn(() => Promise.resolve(response));

describe('OpenAIEmbeddingProvider', () => {
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
