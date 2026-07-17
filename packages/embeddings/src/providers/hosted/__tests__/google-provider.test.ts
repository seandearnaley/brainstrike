import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingInput } from '../../../provider-types';
import { GoogleEmbeddingProvider } from '../google-provider';

const createMockFetch = (response: Response) => vi.fn(() => Promise.resolve(response));

describe('GoogleEmbeddingProvider', () => {
  it('uses embedContent for single inputs', async () => {
    const payload = { embedding: { values: [0.1, 0.2] } };
    const response = new Response(JSON.stringify(payload), { status: 200 });
    const mockFetch = createMockFetch(response);

    const provider = new GoogleEmbeddingProvider({
      apiKey: 'test-api-key',
      fetch: mockFetch as typeof fetch,
      modelId: 'gemini-embedding-001',
      outputDimensions: 2,
    });

    const signal = new AbortController().signal;
    const input: EmbeddingInput = { modelId: 'gemini-embedding-001', signal, text: 'hello' };
    const result = await provider.embed(input);
    expect(result.ok).toBe(true);

    const call = mockFetch.mock.calls.at(0);
    if (!call) {
      throw new Error('Expected fetch to be called for single input.');
    }
    const [url, init] = call as unknown as [RequestInfo | URL, RequestInit | undefined];
    expect(String(url)).toContain(':embedContent');
    expect(init?.signal).toBe(signal);
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      model?: string;
      content?: { parts?: Array<{ text?: string }> };
      outputDimensionality?: number;
    };
    expect(body.model).toBe('models/gemini-embedding-001');
    expect(body.content?.parts?.[0]?.text).toBe('hello');
    expect(body.outputDimensionality).toBe(2);
  });

  it('uses batchEmbedContents for multiple inputs', async () => {
    const payload = {
      embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
    };
    const response = new Response(JSON.stringify(payload), { status: 200 });
    const mockFetch = createMockFetch(response);

    const provider = new GoogleEmbeddingProvider({
      apiKey: 'test-api-key',
      fetch: mockFetch as typeof fetch,
      modelId: 'gemini-embedding-001',
      outputDimensions: 2,
    });

    const signal = new AbortController().signal;
    const input: EmbeddingInput = {
      modelId: 'gemini-embedding-001',
      signal,
      text: ['a', 'b'],
    };
    const result = await provider.embed(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.embeddings).toHaveLength(2);
    }

    const call = mockFetch.mock.calls.at(0);
    if (!call) {
      throw new Error('Expected fetch to be called for batch input.');
    }
    const [url, init] = call as unknown as [RequestInfo | URL, RequestInit | undefined];
    expect(String(url)).toContain(':batchEmbedContents');
    expect(init?.signal).toBe(signal);
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      model?: string;
      requests?: Array<{
        model?: string;
        content?: { parts?: Array<{ text?: string }> };
        outputDimensionality?: number;
      }>;
    };
    expect(body.model).toBe('models/gemini-embedding-001');
    expect(body.requests?.length).toBe(2);
    expect(body.requests?.[0]?.model).toBe('models/gemini-embedding-001');
    expect(body.requests?.[0]?.content?.parts?.[0]?.text).toBe('a');
    expect(body.requests?.[1]?.model).toBe('models/gemini-embedding-001');
    expect(body.requests?.[1]?.content?.parts?.[0]?.text).toBe('b');
    expect(body.requests?.[0]?.outputDimensionality).toBe(2);
  });

  it('returns a validation error for empty inputs', async () => {
    const mockFetch = createMockFetch(new Response('{}', { status: 200 }));
    const provider = new GoogleEmbeddingProvider({
      apiKey: 'test-api-key',
      fetch: mockFetch as typeof fetch,
      modelId: 'gemini-embedding-001',
      outputDimensions: 2,
    });

    const input: EmbeddingInput = { modelId: 'gemini-embedding-001', text: [] };
    const result = await provider.embed(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('validation_error');
    }
  });
});
