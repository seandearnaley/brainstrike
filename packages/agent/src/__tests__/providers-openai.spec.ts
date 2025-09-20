import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '../index';
import { toOpenAIStream } from '../providers/openai';

const encoder = new TextEncoder();

function streamFromStrings(chunks: string[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield encoder.encode(chunk);
      }
    },
  };
}

describe('toOpenAIStream', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('streams deltas from an SSE response', async () => {
    const messages: AgentMessage[] = [
      {
        id: '1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'world' },
        ],
      },
    ];

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as string;
      const parsed = JSON.parse(body);
      expect(parsed.messages[0]).toEqual({ role: 'user', content: 'Hello world' });

      return {
        ok: true,
        status: 200,
        body: streamFromStrings([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      } as unknown as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const iterator = await toOpenAIStream(messages, { apiKey: 'test-key' });
    const deltas: string[] = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'text-delta') {
        deltas.push(chunk.value);
      }
    }

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns an error chunk when the provider response is not ok', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      body: null,
      text: async () => 'Service unavailable',
    }));

    global.fetch = fetchMock as unknown as typeof fetch;

    const iterator = await toOpenAIStream(
      [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'Ping' }] }],
      { apiKey: 'test-key' }
    );

    const chunks: string[] = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'text-delta') {
        chunks.push(chunk.value);
      }
    }

    expect(chunks[0]).toContain('[provider_error 503] Service unavailable');
  });
});
