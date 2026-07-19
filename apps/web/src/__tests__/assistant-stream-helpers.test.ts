import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Partial mocks: spread real module, only override I/O-bound functions.
// This preserves v8 coverage for pure functions (convertAssistantUiMessages,
// sanitizeStreamChunk) while mocking functions that make HTTP calls or manage state.
vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value));
  return {
    ...actual,
    assistantDataStreamSessions: { create: vi.fn() },
    readToolApprovalRunConfigAction: (runConfig: unknown) => {
      if (!isRecord(runConfig)) {
        return;
      }
      const custom = runConfig['custom'];
      if (!isRecord(custom)) {
        return;
      }
      const action = custom[actual.TOOL_APPROVAL_RUN_CONFIG_KEY];
      if (action === undefined) {
        return;
      }
      return actual.isAssistantToolApprovalAction(action) ? { action } : { invalid: true };
    },
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

// The handler builds its stream (normal turn OR approval resume) through this
// seam, which owns the in-process workflow storage. Mock it so the unit test
// never spins up a real PGlite store.
vi.mock('../server/web-mastra-storage', () => ({
  buildWebAssistantStream: vi.fn(),
}));

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
import { InvalidWebAssistantRuntimeDataError } from '../server/web-assistant-runtime';
import { buildWebAssistantStream } from '../server/web-mastra-storage';

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
      apiKey: '',
      disabledReason: 'missing_api_key',
      enabled: false,
    });

    const res = new ResponseSink();
    sendAssistantStatusResponse(res as unknown as http.ServerResponse);

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ enabled: false, reason: 'missing_api_key' });
  });

  it('handles chat endpoint when provider disabled', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: '',
      disabledReason: 'missing_api_key',
      enabled: false,
    });

    const res = new ResponseSink();
    await handleChatEndpoint({ messages: [] }, res as unknown as http.ServerResponse);

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'assistant_disabled' });
  });

  it('streams assistant response using existing session', async () => {
    const response = new Response('resume');
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });
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
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });
    vi.mocked(buildWebAssistantStream).mockRejectedValue(new Error('boom'));

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

  it('returns 400 when assistant data contains a server-only runtime field', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });
    vi.mocked(buildWebAssistantStream).mockRejectedValue(
      new InvalidWebAssistantRuntimeDataError('mcpConfig')
    );

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, {
      data: { mcpConfig: { servers: [] } },
      messages: [],
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_runtime_data',
      message: 'Unsupported web assistant runtime field: mcpConfig',
    });
  });

  it('creates a new assistant session for streaming', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });

    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'hello' } as StreamChunk;
      },
    };

    vi.mocked(buildWebAssistantStream).mockResolvedValue(stream);
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

  it('resumes a tool approval action through workflow storage (no longer 501)', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'resumed' } as StreamChunk;
      },
    };
    vi.mocked(buildWebAssistantStream).mockResolvedValue(stream);
    vi.mocked(assistantDataStreamSessions.create).mockImplementation(
      () =>
        ({
          createResponse: () => new Response('resumed'),
        }) as unknown as AssistantDataStreamSession
    );

    const approvalAction = {
      action: 'decline',
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
      toolName: 'workspace.writeFile',
    };
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, {
      messages: [{ id: '1', parts: [], role: 'user' }],
      runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction } },
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain('resumed');
    expect(buildWebAssistantStream).toHaveBeenCalledWith(
      expect.objectContaining({ toolApprovalAction: approvalAction })
    );
  });

  it('rejects malformed tool approval actions on the web assistant helper route', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, {
      messages: [{ id: '1', parts: [], role: 'user' }],
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
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });

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
    await handleChatEndpoint(
      {
        data: {
          agentLoop: { inputTokenLimit: 1_000_000, maxSteps: 999 },
          mcpEnabled: true,
          model: 'attacker-model',
          modelSettings: { maxOutputTokens: 1_000_000 },
          provider: 'ollama',
          providerOptions: { ollama: { baseUrl: 'https://attacker.example' } },
        },
        messages: [],
      },
      res as unknown as http.ServerResponse
    );

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(toAiSdkStyleStream).toHaveBeenCalledWith(expect.any(Array), {
      apiKey: 'key',
      provider: 'openai',
    });

    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    // sanitizeStreamChunk now runs real — verify output matches sanitized input
    expect(JSON.parse(lines[0]!)).toEqual(chunks[0]);
    expect(JSON.parse(lines[1]!)).toEqual(chunks[1]);
  });

  it('rejects server-only runtime data on the chat endpoint', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });
    vi.mocked(toAiSdkStyleStream).mockResolvedValue(
      (async function* stream() {})() as AsyncIterable<StreamChunk>
    );

    const res = new ResponseSink();
    await handleChatEndpoint(
      { data: { mcpConfig: { servers: [] } }, messages: [] },
      res as unknown as http.ServerResponse
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_runtime_data',
      message: 'Unsupported web assistant runtime field: mcpConfig',
    });
    expect(toAiSdkStyleStream).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong type', { projectId: 42 }, 'projectId'],
    ['oversized string', { mainRootPath: 'x'.repeat(4097) }, 'mainRootPath'],
    ['invalid enum', { workspaceIndexStatusState: 'ready' }, 'workspaceIndexStatusState'],
  ])('rejects a known runtime field with %s', async (_case, data, field) => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });
    vi.mocked(toAiSdkStyleStream).mockResolvedValue(
      (async function* stream() {})() as AsyncIterable<StreamChunk>
    );

    const res = new ResponseSink();
    await handleChatEndpoint({ data, messages: [] }, res as unknown as http.ServerResponse);

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_runtime_data',
      message: `Invalid web assistant runtime field: ${field}`,
    });
    expect(toAiSdkStyleStream).not.toHaveBeenCalled();
  });

  it('resolves last-event-id from array header using the last element', async () => {
    const response = new Response('resumed-from-array');
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });
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
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });

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
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });
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
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });

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
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({ apiKey: 'key', enabled: true });

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
      apiKey: 'key',
      enabled: true,
    });

    const res = new ResponseSink();
    sendAssistantStatusResponse(res as unknown as http.ServerResponse);

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ enabled: true });
  });
});
