import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  return {
    ...actual,
    assistantDataStreamSessions: { create: vi.fn() },
    resolveDataStreamSession: vi.fn(),
    toAiSdkStyleStream: vi.fn(),
  };
});

vi.mock('../../../../server/assistant-config', async () => {
  const actual = await vi.importActual<typeof import('../../../../server/assistant-config')>(
    '../../../../server/assistant-config'
  );
  return {
    ...actual,
    resolveAssistantProviderConfig: vi.fn(),
  };
});

import type { AssistantDataStreamSession, StreamChunk } from '@brainstrike/agent';
import {
  assistantDataStreamSessions,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  resolveDataStreamSession,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { resolveAssistantProviderConfig } from '../../../../server/assistant-config';
import { POST } from '../route';

describe('assistant route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveDataStreamSession).mockReturnValue(undefined);
  });

  it('returns a session response when last-event-id resumes', async () => {
    const response = new Response('resume', { status: 200 });
    vi.mocked(resolveDataStreamSession).mockReturnValue({
      createResponse: () => response,
    } as unknown as AssistantDataStreamSession);

    const req = new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'last-event-id': 'evt-1' },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('resume');
  });

  it('returns 503 when provider is disabled', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      enabled: false,
      apiKey: '',
      disabledReason: 'missing_api_key',
    });

    const req = new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(503);
    const payload = await res.json();
    expect(payload).toMatchObject({ error: 'assistant_disabled' });
  });

  it('returns 400 when request body is invalid JSON', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      enabled: true,
      apiKey: 'test-key',
    });
    vi.mocked(toAiSdkStyleStream).mockResolvedValue((async function* stream() {})());
    vi.mocked(assistantDataStreamSessions.create).mockReturnValue({
      createResponse: () => new Response('unexpected', { status: 200 }),
    } as unknown as AssistantDataStreamSession);

    const req = new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"messages":[',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload).toEqual({
      error: 'invalid_json',
      message: 'Request body must be valid JSON.',
    });
    expect(toAiSdkStyleStream).not.toHaveBeenCalled();
  });

  it('returns 400 when request body has no non-empty prompt', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      enabled: true,
      apiKey: 'test-key',
    });
    vi.mocked(toAiSdkStyleStream).mockResolvedValue((async function* stream() {})());
    vi.mocked(assistantDataStreamSessions.create).mockReturnValue({
      createResponse: () => new Response('unexpected', { status: 200 }),
    } as unknown as AssistantDataStreamSession);

    const req = new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: '   ' }] }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload).toEqual({ error: 'empty_prompt' });
    expect(toAiSdkStyleStream).not.toHaveBeenCalled();
  });

  it('returns 413 when a chunked request body exceeds the default byte limit', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      enabled: true,
      apiKey: 'test-key',
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });

    const req = new Request('http://localhost/api/assistant', {
      body: stream,
      duplex: 'half',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    } as RequestInit & { duplex: 'half' });

    const res = await POST(req);
    expect(res.status).toBe(413);
    const payload = await res.json();
    expect(payload).toEqual({
      error: 'request_body_too_large',
      message: `Assistant request body exceeds ${DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES} bytes.`,
    });
    expect(toAiSdkStyleStream).not.toHaveBeenCalled();
  });

  it('returns 502 when stream initialization fails', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      enabled: true,
      apiKey: 'test-key',
    });
    vi.mocked(toAiSdkStyleStream).mockRejectedValue(new Error('boom'));

    const req = new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
    const payload = await res.json();
    expect(payload).toMatchObject({ error: 'agent_stream_init_failed' });
    expect(payload.message).toBe('Assistant stream initialization failed');
  });

  it('creates a new session when provider is enabled', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      enabled: true,
      apiKey: 'test-key',
    });

    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'hi' } as StreamChunk;
      },
    };

    vi.mocked(toAiSdkStyleStream).mockResolvedValue(stream);
    vi.mocked(assistantDataStreamSessions.create).mockImplementation(
      () =>
        ({
          createResponse: () => new Response('ok', { status: 200 }),
        }) as unknown as AssistantDataStreamSession
    );

    const req = new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    // convertAssistantUiMessages runs real (not mocked) — verify via toAiSdkStyleStream receiving converted messages
    expect(toAiSdkStyleStream).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ apiKey: 'test-key' })
    );
  });
});
