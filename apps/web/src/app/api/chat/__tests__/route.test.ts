import type { StreamChunk } from '@brainstrike/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  return {
    ...actual,
    toAiSdkStyleStream: vi.fn(),
  };
});

import {
  createMastraAgentError,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { __parseChatBodyForTests, __resetRateLimiterForTests, POST } from '../route';

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
  it('rejects invalid bodies with 400', async () => {
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: '', role: 'user', parts: [] }] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('invalid_body');
  });

  it('accepts valid bodies and streams', async () => {
    const body = {
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      data: { projectId: 'p1' },
    } as const;

    // ensure parser passes
    const parsed = __parseChatBodyForTests(body);
    expect(parsed.messages[0]?.role).toBe('user');

    streamMock.mockResolvedValue(
      createStream({ type: 'text-delta', value: 'Hello from mock stream' })
    );

    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
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
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    } as const;

    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
          role: 'user',
          parts: [{ type: 'text', text: 'Search docs for telemetry checklist' }],
        },
      ],
    } as const;

    streamMock.mockResolvedValue(
      createStream(
        {
          type: 'tool-event',
          name: 'brainstrike.readWorkspaceDirectory',
          status: 'start',
          payload: { callId: 'abc', input: { path: '/src', depth: 1 } },
        },
        {
          type: 'tool-event',
          name: 'brainstrike.readWorkspaceDirectory',
          status: 'success',
          payload: {
            callId: 'abc',
            results: [
              {
                id: 'guardrails-and-telemetry',
                title: 'Guardrails & Telemetry Checklist',
                summary: 'Checklist for validating tool input/output schemas.',
              },
            ],
          },
        }
      )
    );

    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    } as const;

    for (let i = 0; i < 10; i += 1) {
      const req = new Request('http://localhost/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      await res.text();
    }

    const limitedReq = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const limitedRes = await POST(limitedReq);
    expect(limitedRes.status).toBe(429);
    expect(limitedRes.headers.get('Retry-After')).not.toBeNull();
    const payload = await limitedRes.json();
    expect(payload.error).toBe('rate_limited');
    expect(typeof payload.retryAfterMs).toBe('number');
  });

  it('bounds rate limiter state for unique client identifiers', async () => {
    for (let i = 0; i < 1024; i += 1) {
      const req = new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'brainstrike-client-id': `client-${i}`,
        },
        body: '{}',
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    }

    const limitedReq = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'brainstrike-client-id': 'client-over-limit',
      },
      body: '{}',
    });
    const limitedRes = await POST(limitedReq);

    expect(limitedRes.status).toBe(429);
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
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    } as const;

    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    expect(res.status).toBe(502);
    const payload = await res.json();
    expect(payload.error).toBe('agent_stream_init_failed');
    expect(payload.code).toBeUndefined();
    expect(payload.message).toBe('Assistant stream initialization failed');
  });
});
