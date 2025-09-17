import type { StreamChunk } from '@brainstrike/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  return {
    ...actual,
    toAiSdkStyleStream: vi.fn(),
  };
});

import { toAiSdkStyleStream } from '@brainstrike/agent';
import { __parseChatBodyForTests, POST } from '../route';

const streamMock = vi.mocked(toAiSdkStyleStream);

const API_KEY_ENV_VARS = [
  'OPENAI_API_KEY',
  'BRAINSTRIKE_OPENAI_API_KEY',
  'BS_OPENAI_API_KEY',
] as const;

let originalEnv: Partial<Record<(typeof API_KEY_ENV_VARS)[number], string | undefined>> = {};

beforeEach(() => {
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
    expect(parsed.messages[0].role).toBe('user');

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
    const firstLine = text.split('\n').filter(Boolean)[0];
    const chunk = JSON.parse(firstLine);
    expect(['tool-event', 'text-delta']).toContain(chunk.type);
  });

  it('returns 503 when assistant provider key is missing', async () => {
    process.env.OPENAI_API_KEY = '';
    process.env.BRAINSTRIKE_OPENAI_API_KEY = '';
    process.env.BS_OPENAI_API_KEY = '';

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

  it('streams web.searchDocs tool events for documentation queries', async () => {
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
          name: 'web.searchDocs',
          status: 'start',
          payload: { callId: 'abc', input: { query: 'telemetry checklist' } },
        },
        {
          type: 'tool-event',
          name: 'web.searchDocs',
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
      (chunk) => chunk['name'] === 'web.searchDocs' && chunk['status'] === 'start'
    );
    expect(start).toBeDefined();

    const success = lines.find(
      (chunk) => chunk['name'] === 'web.searchDocs' && chunk['status'] === 'success'
    );
    expect(success).toBeDefined();

    const payload = (success?.['payload'] ?? {}) as Record<string, unknown>;
    const results = Array.isArray(payload['results']) ? (payload['results'] as unknown[]) : [];
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns 502 when assistant stream fails to initialize', async () => {
    streamMock.mockRejectedValue(new Error('mastra_agent_missing_api_key: no key'));

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
    expect(payload.message).toContain('mastra_agent_missing_api_key');
  });
});
