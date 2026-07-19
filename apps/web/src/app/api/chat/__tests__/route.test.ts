import type { StreamChunk } from '@brainstrike/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  return {
    ...actual,
    toAiSdkStyleStream: vi.fn(),
  };
});

vi.mock('@brainstrike/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logger')>(
    '@brainstrike/utils/logger'
  );
  return {
    ...actual,
    createLogger: () => loggerMocks,
  };
});

import {
  createMastraAgentError,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { __resetRateLimiterForTests, __setRateLimiterEntryForTests, POST } from '../route';

const streamMock = vi.mocked(toAiSdkStyleStream);

const API_KEY_ENV_VARS = [
  'OPENAI_API_KEY',
  'BRAINSTRIKE_OPENAI_API_KEY',
  'BS_OPENAI_API_KEY',
] as const;

let originalEnv: Partial<Record<(typeof API_KEY_ENV_VARS)[number], string | undefined>> = {};

beforeEach(() => {
  __resetRateLimiterForTests();
  originalEnv = {};
  for (const key of API_KEY_ENV_VARS) {
    originalEnv[key] = process.env[key];
    process.env[key] = 'test-key';
  }
});

function createStream(...chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

afterEach(() => {
  streamMock.mockReset();
  loggerMocks.error.mockReset();
  loggerMocks.warn.mockReset();
  for (const key of API_KEY_ENV_VARS) {
    const value = originalEnv[key];
    if (typeof value === 'string') {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
  originalEnv = {};
});

describe('chat route schema', () => {
  it('returns canonical typed 400 for malformed JSON', async () => {
    const req = new Request('http://localhost/api/chat', {
      body: '{"messages":[',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_json',
      message: 'Request body must be valid JSON.',
    });
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('returns typed 400 for deeply nested tool input before streaming', async () => {
    let nested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 3000; depth += 1) {
      nested = { content: nested };
    }
    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify({
        messages: [
          {
            id: 'm1',
            parts: [
              {
                input: nested,
                state: 'input-available',
                type: 'tool-test',
              },
            ],
            role: 'assistant',
          },
        ],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_messages',
      message: 'Assistant message payload exceeds the nesting depth limit.',
    });
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('bounds unknown message fields before any schema can strip them', async () => {
    let nested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 100; depth += 1) {
      nested = { child: nested };
    }
    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify({
        messages: [
          {
            id: 'm1',
            parts: [
              {
                hidden: nested,
                state: 'input-available',
                type: 'tool-test',
              },
            ],
            role: 'assistant',
          },
        ],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_messages',
      message: 'Assistant message payload exceeds the nesting depth limit.',
    });
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('accepts the same valid image file parts as the Vite assistant boundary', async () => {
    streamMock.mockResolvedValue(
      createStream({ type: 'text-delta', value: 'I can inspect that image.' })
    );
    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify({
        messages: [
          {
            id: 'm1',
            parts: [
              { text: 'Describe this image', type: 'text' },
              {
                data: 'data:image/png;base64,iVBORw0KGgo=',
                filename: 'pixel.png',
                mediaType: 'image/png',
                type: 'file',
              },
            ],
            role: 'user',
          },
        ],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(streamMock).toHaveBeenCalledWith(
      [
        {
          id: 'm1',
          parts: [
            { text: 'Describe this image', type: 'text' },
            {
              data: 'data:image/png;base64,iVBORw0KGgo=',
              filename: 'pixel.png',
              mediaType: 'image/png',
              type: 'file',
            },
          ],
          role: 'user',
        },
      ],
      expect.any(Object)
    );
  });

  it('returns the canonical attachment error for malformed file parts', async () => {
    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify({
        messages: [
          {
            id: 'm1',
            parts: [
              { text: 'Describe this image', type: 'text' },
              {
                data: 'data:application/pdf;base64,AAAA',
                mediaType: 'application/pdf',
                type: 'file',
              },
            ],
            role: 'user',
          },
        ],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_attachment',
      message: 'Assistant attachment payload is invalid.',
      reason: 'unsupported-media-type',
    });
    expect(streamMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a whitespace-only user prompt',
      [{ id: 'm1', parts: [{ text: '   ', type: 'text' }], role: 'user' }],
    ],
    [
      'an assistant prompt',
      [{ id: 'm1', parts: [{ text: 'continue', type: 'text' }], role: 'assistant' }],
    ],
    [
      'a system prompt',
      [{ id: 'm1', parts: [{ text: 'continue', type: 'text' }], role: 'system' }],
    ],
    [
      'history whose final message is not the user',
      [
        { id: 'm1', parts: [{ text: 'question', type: 'text' }], role: 'user' },
        { id: 'm2', parts: [{ text: 'answer', type: 'text' }], role: 'assistant' },
      ],
    ],
    [
      'history whose blank final assistant message would normalize away',
      [
        { id: 'm1', parts: [{ text: 'question', type: 'text' }], role: 'user' },
        { id: 'm2', parts: [{ text: '   ', type: 'text' }], role: 'assistant' },
      ],
    ],
    [
      'history whose blank final user message would normalize away',
      [
        { id: 'm1', parts: [{ text: 'question', type: 'text' }], role: 'user' },
        { id: 'm2', parts: [{ text: '   ', type: 'text' }], role: 'user' },
      ],
    ],
  ])('requires the final message to be a non-empty user prompt for %s', async (_case, messages) => {
    streamMock.mockResolvedValue(
      createStream({ type: 'text-delta', value: 'This must not stream.' })
    );
    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify({ messages }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'empty_prompt' });
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('rejects invalid bodies with 400', async () => {
    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify({ messages: [{ id: '', parts: [], role: 'user' }] }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const data = await res.json();
    expect(data).toEqual({ error: 'empty_prompt' });
  });

  it('accepts valid bodies and streams', async () => {
    const body = {
      data: { model: 'attacker-model', projectId: 'p1', provider: 'ollama' },
      messages: [{ id: 'm1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
    } as const;

    streamMock.mockResolvedValue(
      createStream({ type: 'text-delta', value: 'Hello from mock stream' })
    );

    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(streamMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ apiKey: 'test-key', projectId: 'p1', provider: 'openai' })
    );
    expect(streamMock.mock.calls[0]?.[1]).not.toHaveProperty('model');
    const text = await res.text();
    // should contain newline-delimited JSON with at least one chunk
    const firstLine = text.split('\n').find(Boolean);
    expect(firstLine).toBeDefined();
    const chunk = JSON.parse(firstLine ?? '{}');
    expect(['tool-event', 'text-delta']).toContain(chunk.type);
  });

  it('returns 503 when assistant provider key is missing', async () => {
    process.env['OPENAI_API_KEY'] = '';
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = '';
    process.env['BS_OPENAI_API_KEY'] = '';

    const body = {
      messages: [{ id: 'm1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
    } as const;

    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(503);
    const payload = await res.json();
    expect(payload).toMatchObject({ error: 'assistant_disabled' });
  });

  it('streams tool events emitted by the assistant runtime', async () => {
    const body = {
      messages: [
        {
          id: 'm1',
          parts: [{ text: 'Search docs for telemetry checklist', type: 'text' }],
          role: 'user',
        },
      ],
    } as const;

    streamMock.mockResolvedValue(
      createStream(
        {
          name: 'brainstrike.readWorkspaceDirectory',
          payload: { callId: 'abc', input: { depth: 1, path: '/src' } },
          status: 'start',
          type: 'tool-event',
        },
        {
          name: 'brainstrike.readWorkspaceDirectory',
          payload: {
            callId: 'abc',
            results: [
              {
                id: 'guardrails-and-telemetry',
                summary: 'Checklist for validating tool input/output schemas.',
                title: 'Guardrails & Telemetry Checklist',
              },
            ],
          },
          status: 'success',
          type: 'tool-event',
        }
      )
    );

    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const start = lines.find(
      (chunk) =>
        chunk['name'] === 'brainstrike.readWorkspaceDirectory' && chunk['status'] === 'start'
    );
    expect(start).toBeDefined();

    const success = lines.find(
      (chunk) =>
        chunk['name'] === 'brainstrike.readWorkspaceDirectory' && chunk['status'] === 'success'
    );
    expect(success).toBeDefined();

    const payload = (success?.['payload'] ?? {}) as Record<string, unknown>;
    const results = Array.isArray(payload['results']) ? (payload['results'] as unknown[]) : [];
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns 429 when rate limit is exceeded for a client', async () => {
    streamMock.mockImplementation(async () =>
      createStream({ type: 'text-delta', value: 'Hello from mock stream' })
    );

    const headers = {
      'Content-Type': 'application/json',
      'x-forwarded-for': '203.0.113.1',
    } as const;

    const body = {
      messages: [{ id: 'm1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
    } as const;

    for (let i = 0; i < 10; i += 1) {
      const req = new Request('http://localhost/api/chat', {
        body: JSON.stringify(body),
        headers,
        method: 'POST',
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      await res.text();
    }

    const limitedReq = new Request('http://localhost/api/chat', {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
    });
    const limitedRes = await POST(limitedReq);
    expect(limitedRes.status).toBe(429);
    expect(limitedRes.headers.get('Retry-After')).not.toBeNull();
    const payload = await limitedRes.json();
    expect(payload.error).toBe('rate_limited');
    expect(typeof payload.retryAfterMs).toBe('number');
  });

  it('keeps chat available to new clients when rate limiter state is full', async () => {
    for (let i = 0; i < 1024; i += 1) {
      const req = new Request('http://localhost/api/chat', {
        body: '{}',
        headers: {
          'brainstrike-client-id': `client-${i}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    }

    streamMock.mockResolvedValue(
      createStream({ type: 'text-delta', value: 'Hello from mock stream' })
    );

    const limitedReq = new Request('http://localhost/api/chat', {
      body: JSON.stringify({
        messages: [{ id: 'm1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      }),
      headers: {
        'brainstrike-client-id': 'client-over-limit',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    const limitedRes = await POST(limitedReq);

    expect(limitedRes.status).toBe(200);
  });

  it('prunes expired clients before admitting a new client at capacity', async () => {
    const now = Date.now();
    for (let i = 0; i < 1024; i += 1) {
      __setRateLimiterEntryForTests(`expired-client-${i}`, {
        count: 1,
        windowStartedAt: now - 60_000,
      });
    }

    streamMock.mockResolvedValue(
      createStream({ type: 'text-delta', value: 'Hello from mock stream' })
    );

    const res = await POST(
      new Request('http://localhost/api/chat', {
        body: JSON.stringify({
          messages: [{ id: 'm1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
        }),
        headers: {
          'brainstrike-client-id': 'client-after-expiry',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );

    expect(res.status).toBe(200);
  });

  it('keeps actively blocked clients rate-limited when evicting full state', async () => {
    streamMock.mockResolvedValue(
      createStream({ type: 'text-delta', value: 'Hello from mock stream' })
    );
    const blockedHeaders = {
      'brainstrike-client-id': 'blocked-client',
      'Content-Type': 'application/json',
    };
    const validBody = JSON.stringify({
      messages: [{ id: 'm1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
    });

    for (let i = 0; i < 10; i += 1) {
      const res = await POST(
        new Request('http://localhost/api/chat', {
          body: validBody,
          headers: blockedHeaders,
          method: 'POST',
        })
      );
      expect(res.status).toBe(200);
      await res.text();
    }

    const blockedRes = await POST(
      new Request('http://localhost/api/chat', {
        body: validBody,
        headers: blockedHeaders,
        method: 'POST',
      })
    );
    expect(blockedRes.status).toBe(429);

    for (let i = 0; i < 1024; i += 1) {
      await POST(
        new Request('http://localhost/api/chat', {
          body: '{}',
          headers: {
            'brainstrike-client-id': `churn-client-${i}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
        })
      );
    }

    const stillBlockedRes = await POST(
      new Request('http://localhost/api/chat', {
        body: validBody,
        headers: blockedHeaders,
        method: 'POST',
      })
    );

    expect(stillBlockedRes.status).toBe(429);
  });

  it('logs once per window when all tracked clients are actively blocked', async () => {
    const now = Date.now();
    for (let i = 0; i < 1024; i += 1) {
      __setRateLimiterEntryForTests(`blocked-${i}`, {
        blockedUntil: now + 60_000,
        count: 10,
        windowStartedAt: now,
      });
    }

    const res = await POST(
      new Request('http://localhost/api/chat', {
        body: '{}',
        headers: {
          'brainstrike-client-id': 'new-client',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );

    expect(res.status).toBe(429);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'Chat rate limiter rejected a new client because all entries are blocked',
      {
        maxClients: 1024,
        windowMs: 60_000,
      }
    );

    const secondRes = await POST(
      new Request('http://localhost/api/chat', {
        body: '{}',
        headers: {
          'brainstrike-client-id': 'another-new-client',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );

    expect(secondRes.status).toBe(429);
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
  });

  it('returns 413 when a chunked request body exceeds the default byte limit', async () => {
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });

    const res = await POST(
      new Request('http://localhost/api/chat', {
        body: oversizedBody,
        duplex: 'half',
        method: 'POST',
      } as RequestInit & { duplex: 'half' })
    );

    expect(streamMock).not.toHaveBeenCalled();
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: 'request_body_too_large',
      message: `Assistant request body exceeds ${DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES} bytes.`,
    });
  });

  it('returns 413 before reading a declared oversized body', async () => {
    const res = await POST({
      body: null,
      headers: new Headers({
        'content-length': String(DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES + 1),
      }),
      method: 'POST',
      url: 'http://localhost/api/chat',
    } as Request);

    expect(streamMock).not.toHaveBeenCalled();
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: 'request_body_too_large' });
  });

  it('returns 502 when assistant stream fails to initialize', async () => {
    streamMock.mockRejectedValue(
      createMastraAgentError('mastra_agent_missing_api_key', { detail: 'no key' })
    );

    const body = {
      messages: [{ id: 'm1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
    } as const;

    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const res = await POST(req);
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const payload = await res.json();
    expect(payload.error).toBe('agent_stream_init_failed');
    expect(payload.code).toBeUndefined();
    expect(payload.message).toBe('Assistant stream initialization failed');
  });

  it('returns the canonical 502 when assistant stream initialization throws a plain error', async () => {
    streamMock.mockRejectedValue(new Error('adapter initialization failed'));

    const req = new Request('http://localhost/api/chat', {
      body: JSON.stringify({
        messages: [{ id: 'm1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({
      error: 'agent_stream_init_failed',
      message: 'Assistant stream initialization failed',
    });
  });
});
