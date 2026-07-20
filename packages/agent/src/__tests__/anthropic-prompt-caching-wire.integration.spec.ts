import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamMastraAgent } from '../mastra/agent-runtime';
import type { StreamChunk } from '../types';

/**
 * Keyless wire proof for BST-587 (review nit 4): drives the REAL Mastra loop +
 * REAL @ai-sdk/anthropic serialization with a stubbed global fetch, asserting
 * the exact HTTP body sent to api.anthropic.com carries BOTH cache breakpoints
 * (stable system block + conversation tail) and that a response reporting
 * cache usage flows back into the finish chunk's cache token classes.
 */

interface CapturedAnthropicRequest {
  readonly apiKeyHeader: string | null;
  readonly body: Record<string, unknown>;
  readonly url: string;
}

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeAnthropicSseResponse(): Response {
  const events =
    sseEvent('message_start', {
      message: {
        content: [],
        id: 'msg_wire_test',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        stop_reason: null,
        stop_sequence: null,
        type: 'message',
        usage: {
          cache_creation_input_tokens: 60,
          cache_read_input_tokens: 40,
          input_tokens: 7,
          output_tokens: 0,
        },
      },
      type: 'message_start',
    }) +
    sseEvent('content_block_start', {
      content_block: { text: '', type: 'text' },
      index: 0,
      type: 'content_block_start',
    }) +
    sseEvent('content_block_delta', {
      delta: { text: 'cached hello', type: 'text_delta' },
      index: 0,
      type: 'content_block_delta',
    }) +
    sseEvent('content_block_stop', { index: 0, type: 'content_block_stop' }) +
    sseEvent('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      type: 'message_delta',
      usage: { output_tokens: 3 },
    }) +
    sseEvent('message_stop', { type: 'message_stop' });
  return new Response(events, {
    headers: { 'content-type': 'text/event-stream' },
    status: 200,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anthropic prompt caching wire contract', () => {
  it('sends both cache breakpoints and maps cache usage into the finish chunk', async () => {
    const captured: CapturedAnthropicRequest[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('api.anthropic.com')) {
        return realFetch(input as RequestInfo, init);
      }
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      const rawBody =
        typeof init?.body === 'string'
          ? init.body
          : await new Request(input as RequestInfo, init).text();
      captured.push({
        apiKeyHeader: headers.get('x-api-key'),
        body: JSON.parse(rawBody) as Record<string, unknown>,
        url,
      });
      return makeAnthropicSseResponse();
    });

    const iterator = await streamMastraAgent(
      [{ id: 'user-1', parts: [{ text: 'Reply briefly.', type: 'text' }], role: 'user' }],
      {
        model: 'claude-sonnet-4-6',
        runtime: {
          apiKey: 'test-key',
          provider: 'anthropic',
          taskList: [{ content: 'Verify the wire', id: 'task-1', status: 'pending' }],
        },
      }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(captured).toHaveLength(1);
    const request = captured[0];
    if (!request) {
      throw new Error('No Anthropic request captured');
    }
    expect(request.url).toContain('/v1/messages');
    expect(request.apiKeyHeader).toBe('test-key');

    // Instructions split: TWO system blocks — the stable block carries the
    // cache breakpoint; the volatile task-list note follows it uncached.
    const system = request.body['system'] as Record<string, unknown>[];
    expect(Array.isArray(system)).toBe(true);
    expect(system.length).toBe(2);
    expect(system[0]?.['cache_control']).toEqual({ type: 'ephemeral' });
    expect(String(system[1]?.['text'])).toContain('<current-task-list');
    expect(system[1]?.['cache_control']).toBeUndefined();

    // Tail breakpoint: the final content block of the final message.
    const messages = request.body['messages'] as Record<string, unknown>[];
    const lastMessage = messages.at(-1);
    const lastContent = (lastMessage?.['content'] as Record<string, unknown>[]).at(-1);
    expect(lastContent?.['cache_control']).toEqual({ type: 'ephemeral' });

    // Response cache usage survives to the finish chunk (Anthropic-gated path).
    const finish = chunks.at(-1) as Extract<StreamChunk, { type: 'message-finish' }>;
    expect(finish.type).toBe('message-finish');
    expect(finish.usage).toEqual({
      cacheCreationInputTokens: 60,
      cacheReadInputTokens: 40,
      completionTokens: 3,
      // Mastra flattens the provider's structured usage to the TOTAL the
      // model saw: 7 uncached + 40 cache-read + 60 cache-write.
      promptTokens: 107,
    });
  });
});
