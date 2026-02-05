import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/agent', () => ({
  assistantDataStreamSessions: { create: vi.fn() },
  convertAssistantUiMessages: vi.fn((messages: unknown) => messages),
  resolveDataStreamSession: vi.fn(),
  toAiSdkStyleStream: vi.fn(),
  webTools: { id: 'web-tools' },
}));

vi.mock('../../../../server/assistant-config', () => ({
  resolveAssistantProviderConfig: vi.fn(),
}));

import type { AssistantDataStreamSession, StreamChunk } from '@brainstrike/agent';
import {
  assistantDataStreamSessions,
  convertAssistantUiMessages,
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
      body: JSON.stringify({ messages: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(503);
    const payload = await res.json();
    expect(payload).toMatchObject({ error: 'assistant_disabled' });
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
      body: JSON.stringify({ messages: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
    const payload = await res.json();
    expect(payload).toMatchObject({ error: 'agent_stream_init_failed' });
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
      body: JSON.stringify({ messages: [{ id: '1', role: 'user', parts: [] }] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(convertAssistantUiMessages).toHaveBeenCalled();
    expect(toAiSdkStyleStream).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ apiKey: 'test-key', mastraTools: { id: 'web-tools' } })
    );
  });
});
