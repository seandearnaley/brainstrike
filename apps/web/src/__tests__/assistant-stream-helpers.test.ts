import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/agent', () => ({
  assistantDataStreamSessions: { create: vi.fn() },
  convertAssistantUiMessages: vi.fn((messages: unknown) => messages),
  resolveDataStreamSession: vi.fn(),
  sanitizeStreamChunk: vi.fn((chunk: unknown) => chunk),
  toAiSdkStyleStream: vi.fn(),
  webTools: { id: 'web-tools' },
}));

vi.mock('../server/assistant-config', () => ({
  resolveAssistantProviderConfig: vi.fn(),
}));

import type { AssistantDataStreamSession, StreamChunk } from '@brainstrike/agent';
import {
  assistantDataStreamSessions,
  resolveDataStreamSession,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import {
  handleAssistantEndpoint,
  handleChatEndpoint,
  readBody,
  sendAssistantStatusResponse,
} from '../assistant-stream-helpers';
import { resolveAssistantProviderConfig } from '../server/assistant-config';

class ResponseSink extends EventEmitter {
  status?: number;
  headers: Record<string, string> = {};
  body = '';
  destroyed = false;

  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: Uint8Array | string) {
    this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }

  end(chunk?: string) {
    if (chunk) {
      this.body += chunk;
    }
    this.emit('finish');
  }
}

describe('assistant-stream-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveDataStreamSession).mockReturnValue(undefined);
  });

  it('reads the request body as a string', async () => {
    const req = new EventEmitter() as http.IncomingMessage;
    const bodyPromise = readBody(req);

    req.emit('data', Buffer.from('hello '));
    req.emit('data', Buffer.from('world'));
    req.emit('end');

    await expect(bodyPromise).resolves.toBe('hello world');
  });

  it('sends assistant status payload', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      enabled: false,
      apiKey: '',
      disabledReason: 'missing_api_key',
    });

    const res = new ResponseSink();
    sendAssistantStatusResponse(res as unknown as http.ServerResponse);

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ enabled: false, reason: 'missing_api_key' });
  });

  it('handles chat endpoint when provider disabled', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      enabled: false,
      apiKey: '',
      disabledReason: 'missing_api_key',
    });

    const res = new ResponseSink();
    await handleChatEndpoint({ messages: [] }, res as unknown as http.ServerResponse);

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'assistant_disabled' });
  });

  it('streams assistant response using existing session', async () => {
    const response = new Response('resume');
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });
    vi.mocked(resolveDataStreamSession).mockReturnValue({
      createResponse: () => response,
    } as unknown as AssistantDataStreamSession);

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = { 'last-event-id': 'evt-1' } as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, { messages: [] });

    expect(res.status).toBe(200);
    expect(res.body).toContain('resume');
  });

  it('returns 502 when streaming initialization fails', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });
    vi.mocked(toAiSdkStyleStream).mockRejectedValue(new Error('boom'));

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, { messages: [] });

    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'agent_stream_init_failed' });
  });

  it('creates a new assistant session for streaming', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });

    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'hello' } as StreamChunk;
      },
    };

    vi.mocked(toAiSdkStyleStream).mockResolvedValue(stream);
    vi.mocked(assistantDataStreamSessions.create).mockImplementation(
      () =>
        ({
          createResponse: () => new Response('ok'),
        }) as unknown as AssistantDataStreamSession
    );

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, { messages: [] });

    expect(res.status).toBe(200);
    expect(res.body).toContain('ok');
  });
});
