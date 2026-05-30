import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Partial mocks: spread real module, only override I/O-bound functions.
// This preserves v8 coverage for pure functions (convertAssistantUiMessages,
// sanitizeStreamChunk) while mocking functions that make HTTP calls or manage state.
vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  return {
    ...actual,
    assistantDataStreamSessions: { create: vi.fn() },
    resolveDataStreamSession: vi.fn(),
    toAiSdkStyleStream: vi.fn(),
  };
});

vi.mock('../server/assistant-config', async () => {
  const actual = await vi.importActual<typeof import('../server/assistant-config')>(
    '../server/assistant-config'
  );
  return {
    ...actual,
    resolveAssistantProviderConfig: vi.fn(),
  };
});

import type { AssistantDataStreamSession, StreamChunk } from '@brainstrike/agent';
import {
  assistantDataStreamSessions,
  resolveDataStreamSession,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
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
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'agent_stream_init_failed',
      message: 'Assistant stream initialization failed',
    });
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

  it('rejects tool approval resume actions on the web assistant helper route', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, {
      messages: [{ id: '1', role: 'user', parts: [] }],
      runConfig: {
        custom: {
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
            action: 'decline',
            runId: 'run-approval-1',
            toolCallId: 'tool-call-1',
            toolName: 'workspace.writeFile',
          },
        },
      },
    });

    expect(res.status).toBe(501);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'tool_approval_resume_unsupported',
    });
    expect(toAiSdkStyleStream).not.toHaveBeenCalled();
    expect(assistantDataStreamSessions.create).not.toHaveBeenCalled();
  });

  it('rejects malformed tool approval actions on the web assistant helper route', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, {
      messages: [{ id: '1', role: 'user', parts: [] }],
      runConfig: {
        custom: {
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
            action: 'decline',
            runId: 'run-approval-1',
          },
        },
      },
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'invalid_tool_approval_action',
    });
    expect(toAiSdkStyleStream).not.toHaveBeenCalled();
  });

  it('streams chat response as JSON lines when provider is enabled', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });

    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'hello' } as StreamChunk,
      { type: 'text-delta', value: ' world' } as StreamChunk,
    ];

    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) {
          yield c;
        }
      },
    };

    vi.mocked(toAiSdkStyleStream).mockResolvedValue(stream);

    const res = new ResponseSink();
    await handleChatEndpoint({ messages: [] }, res as unknown as http.ServerResponse);

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');

    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    // sanitizeStreamChunk now runs real — verify output matches sanitized input
    expect(JSON.parse(lines[0]!)).toEqual(chunks[0]);
    expect(JSON.parse(lines[1]!)).toEqual(chunks[1]);
  });

  it('resolves last-event-id from array header using the last element', async () => {
    const response = new Response('resumed-from-array');
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });
    vi.mocked(resolveDataStreamSession).mockImplementation((id: string | null | undefined) =>
      id === 'evt-2'
        ? ({
            createResponse: () => response,
          } as unknown as AssistantDataStreamSession)
        : undefined
    );

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = { 'last-event-id': ['evt-1', 'evt-2'] } as unknown as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, { messages: [] });

    expect(vi.mocked(resolveDataStreamSession)).toHaveBeenCalledWith('evt-2');
    expect(res.status).toBe(200);
    expect(res.body).toContain('resumed-from-array');
  });

  it('creates a new session when no last-event-id header is present', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });

    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'new' } as StreamChunk;
      },
    };

    vi.mocked(toAiSdkStyleStream).mockResolvedValue(stream);
    vi.mocked(assistantDataStreamSessions.create).mockImplementation(
      () =>
        ({
          createResponse: () => new Response('fresh-session'),
        }) as unknown as AssistantDataStreamSession
    );

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, { messages: [] });

    expect(vi.mocked(resolveDataStreamSession)).toHaveBeenCalledWith(undefined);
    expect(vi.mocked(assistantDataStreamSessions.create)).toHaveBeenCalled();
    expect(res.body).toContain('fresh-session');
  });

  it('calls res.end() when response body is null', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });
    vi.mocked(resolveDataStreamSession).mockReturnValue({
      createResponse: () => new Response(null, { status: 200 }),
    } as unknown as AssistantDataStreamSession);

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = { 'last-event-id': 'evt-null' } as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    const endSpy = vi.spyOn(res, 'end');

    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, { messages: [] });

    expect(endSpy).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('waits for drain event when write returns false (backpressure)', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });

    // Create a response that has a body with content
    const encoder = new TextEncoder();
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('chunk-data'));
        controller.close();
      },
    });
    const response = new Response(bodyStream, { status: 200 });

    vi.mocked(resolveDataStreamSession).mockReturnValue({
      createResponse: () => response,
    } as unknown as AssistantDataStreamSession);

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = { 'last-event-id': 'evt-bp' } as http.IncomingHttpHeaders;

    // Override write to return false (signal backpressure), then emit drain
    const res = new ResponseSink();
    let drainResolved = false;
    res.write = (chunk: Uint8Array | string) => {
      res.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      // Schedule drain event to unblock the writer
      setTimeout(() => {
        drainResolved = true;
        res.emit('drain');
      }, 5);
      return false; // signal backpressure
    };

    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, { messages: [] });

    expect(drainResolved).toBe(true);
    expect(res.body).toContain('chunk-data');
  });

  it('completes streaming after req emits close (abort cleanup)', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ enabled: true, apiKey: 'key' });

    let resolveChunk: (() => void) | undefined;
    const chunkReady = new Promise<void>((r) => {
      resolveChunk = r;
    });

    const encoder = new TextEncoder();
    const bodyStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Enqueue one chunk, then wait before closing so we can emit 'close'
        controller.enqueue(encoder.encode('before-abort'));
        resolveChunk!();
        // Yield control so the abort can fire
        await new Promise((r) => setTimeout(r, 10));
        controller.close();
      },
    });
    const response = new Response(bodyStream, { status: 200 });

    vi.mocked(resolveDataStreamSession).mockReturnValue({
      createResponse: () => response,
    } as unknown as AssistantDataStreamSession);

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = { 'last-event-id': 'evt-abort' } as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    const endSpy = vi.spyOn(res, 'end');

    const streamPromise = handleAssistantEndpoint(req, res as unknown as http.ServerResponse, {
      messages: [],
    });

    // Wait for the first chunk to be read, then simulate client disconnect
    await chunkReady;
    req.emit('close');

    await streamPromise;

    // Response should still end gracefully
    expect(endSpy).toHaveBeenCalled();
  });

  it('sends enabled: true status when provider is enabled', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      enabled: true,
      apiKey: 'key',
    });

    const res = new ResponseSink();
    sendAssistantStatusResponse(res as unknown as http.ServerResponse);

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ enabled: true });
  });
});
