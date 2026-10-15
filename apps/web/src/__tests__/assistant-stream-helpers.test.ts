import { EventEmitter, once } from 'node:events';
import http from 'node:http';
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
  };
});

vi.mock('@brainstrike/agent/hosted-web', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent/hosted-web')>(
    '@brainstrike/agent/hosted-web'
  );
  return {
    ...actual,
    createStatelessAssistantDataStreamResponse: vi.fn(),
    streamHostedWebTurn: vi.fn(),
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

// The handler builds normal stateless hosted-Web turns through this seam.
vi.mock('../server/web-assistant-stream', () => ({
  buildWebAssistantStreamFromPrepared: vi.fn(),
}));

import type { AssistantDataStreamSession, RuntimeData, StreamChunk } from '@brainstrike/agent';
import {
  ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS,
  ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS,
  AssistantRequestBodyTooLargeError,
  resolveDataStreamSession,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/agent';
import {
  createStatelessAssistantDataStreamResponse,
  streamHostedWebTurn,
} from '@brainstrike/agent/hosted-web';
import {
  handleAssistantEndpoint,
  readBody,
  sendAssistantStatusResponse,
} from '../assistant-stream-helpers';
import { resolveAssistantProviderConfig } from '../server/assistant-config';
import { InvalidWebAssistantRuntimeDataError } from '../server/web-assistant-runtime';
import { buildWebAssistantStreamFromPrepared } from '../server/web-assistant-stream';

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

function requestBody(value: unknown): string {
  return JSON.stringify(value);
}

const NORMAL_ASSISTANT_REQUEST_BODY = requestBody({
  data: { provider: 'openai' },
  messages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
});

function mockDisabledAssistantProviders(): void {
  vi.mocked(resolveAssistantProviderConfig).mockImplementation((provider = 'openai') => ({
    disabledReason: 'missing_api_key',
    enabled: false,
    provider,
  }));
}

function mockOpenAiAssistantProvider(): void {
  vi.mocked(resolveAssistantProviderConfig).mockImplementation((provider = 'openai') => {
    if (provider === 'openai') {
      return {
        apiKey: 'key',
        enabled: true,
        provider,
        source: 'OPENAI_API_KEY',
      };
    }
    return { disabledReason: 'missing_api_key', enabled: false, provider };
  });
}

async function listenOnLoopback(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!(address && typeof address === 'object')) {
    throw new Error('Expected the test HTTP server to listen on a TCP port.');
  }
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function postToServer(port: number, body = NORMAL_ASSISTANT_REQUEST_BODY): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const request = http.request(
      {
        headers: {
          'Content-Length': Buffer.byteLength(body),
          'Content-Type': 'application/json',
        },
        host: '127.0.0.1',
        method: 'POST',
        path: '/api/assistant',
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.once('error', reject);
      }
    );
    request.once('error', reject);
    request.end(body);
  });
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

describe('assistant-stream-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveDataStreamSession).mockReturnValue(undefined);
  });

  it('reads the request body as a string', async () => {
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {};
    const bodyPromise = readBody(req);

    req.emit('data', Buffer.from('hello '));
    req.emit('data', Buffer.from('world'));
    req.emit('end');

    await expect(bodyPromise).resolves.toBe('hello world');
  });

  it('rejects a declared request body larger than the configured byte limit before reading', async () => {
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = { 'content-length': '6' };
    req.resume = vi.fn().mockReturnValue(req);
    const dataListener = vi.fn();
    req.on('data', dataListener);

    await expect(readBody(req, 5)).rejects.toEqual(new AssistantRequestBodyTooLargeError(5));
    expect(dataListener).not.toHaveBeenCalled();
    expect(req.resume).toHaveBeenCalledOnce();
  });

  it('rejects a chunked request as soon as its accumulated bytes exceed the limit', async () => {
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {};
    req.resume = vi.fn().mockReturnValue(req);
    const bodyPromise = readBody(req, 5);

    req.emit('data', Buffer.from('abc'));
    req.emit('data', Buffer.from('def'));

    await expect(bodyPromise).rejects.toEqual(new AssistantRequestBodyTooLargeError(5));
    expect(req.resume).toHaveBeenCalledOnce();
  });

  it('sends assistant status payload', async () => {
    mockDisabledAssistantProviders();

    const res = new ResponseSink();
    sendAssistantStatusResponse(res as unknown as http.ServerResponse);

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ enabled: false, reason: 'missing_api_key' });
  });

  it('rejects a non-empty last-event-id even when the process-local registry resolves it', async () => {
    const createResponse = vi.fn(() => new Response('must-not-resume'));
    mockDisabledAssistantProviders();
    vi.mocked(resolveDataStreamSession).mockReturnValue({
      createResponse,
    } as unknown as AssistantDataStreamSession);

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = { 'last-event-id': 'evt-1' } as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, '{');

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'stream_resume_unavailable',
      message:
        'Hosted Web stream replay requires durable storage and is unavailable for this deployment.',
    });
    expect(resolveDataStreamSession).not.toHaveBeenCalled();
    expect(createResponse).not.toHaveBeenCalled();
  });

  it('fails closed when last-event-id cannot be resolved on this Vite server instance', async () => {
    mockOpenAiAssistantProvider();

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {
      'last-event-id': 'evt-from-another-instance',
    } as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        messages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'stream_resume_unavailable',
      message:
        'Hosted Web stream replay requires durable storage and is unavailable for this deployment.',
    });
    expect(resolveDataStreamSession).not.toHaveBeenCalled();
    expect(resolveAssistantProviderConfig).not.toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it('returns 502 when streaming initialization fails', async () => {
    mockOpenAiAssistantProvider();
    vi.mocked(buildWebAssistantStreamFromPrepared).mockRejectedValue(new Error('boom'));

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: { provider: 'openai' },
        messages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'agent_stream_init_failed',
      message: 'Assistant stream initialization failed',
    });
  });

  it('returns 400 when assistant data contains a server-only runtime field', async () => {
    mockOpenAiAssistantProvider();
    vi.mocked(buildWebAssistantStreamFromPrepared).mockRejectedValue(
      new InvalidWebAssistantRuntimeDataError('mcpConfig')
    );

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: { mcpConfig: { servers: [] } },
        messages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_runtime_data',
      message: 'Unsupported web assistant runtime field: mcpConfig',
    });
  });

  it('creates a stateless assistant response for streaming', async () => {
    mockOpenAiAssistantProvider();

    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'hello' } as StreamChunk;
      },
    };

    vi.mocked(buildWebAssistantStreamFromPrepared).mockResolvedValue(stream);
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(new Response('ok'));

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: { provider: 'openai' },
        messages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(res.status).toBe(200);
    expect(res.body).toContain('ok');
  });

  it('accepts shared-transport image-elision metadata on the Vite assistant route', async () => {
    mockOpenAiAssistantProvider();
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'hello' } as StreamChunk;
      },
    };
    let receivedRuntime: RuntimeData | undefined;
    vi.mocked(buildWebAssistantStreamFromPrepared).mockImplementation(async (params) => {
      receivedRuntime = params.runtimeData;
      return stream;
    });
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(new Response('ok'));

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;
    const res = new ResponseSink();
    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: {
          provider: 'openai',
          transportImageElision: {
            elidedImageBytes: 5_242_880,
            elidedImageCount: 1,
            keptImageBytes: 6_291_456,
            strategy: 'newest-first-combined-image-budget',
          },
        },
        messages: [
          { id: 'current-user', parts: [{ text: 'continue', type: 'text' }], role: 'user' },
        ],
      })
    );

    expect(res.status).toBe(200);
    expect(buildWebAssistantStreamFromPrepared).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { key: 'key', source: 'env', type: 'api_key' } })
    );
    expect(receivedRuntime).toEqual({ provider: 'openai' });
  });

  it('fails closed for a valid tool approval action in stateless Vite', async () => {
    mockOpenAiAssistantProvider();

    const approvalAction = {
      action: 'decline',
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
      toolName: 'workspace.writeFile',
    };
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: { provider: 'openai' },
        messages: [{ id: '1', parts: [], role: 'user' }],
        runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction } },
      })
    );

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'tool_approval_unavailable',
      message: 'Hosted Web tool approval requires durable workflow storage.',
    });
    // Convergence (BST-973-2): the server-config 503 gate precedes request
    // validation, so provider configs are resolved before any 400/409.
    expect(resolveAssistantProviderConfig).toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it('fails closed for a valid tool suspend resume action in stateless Vite', async () => {
    mockOpenAiAssistantProvider();

    const resumeAction = {
      resumeData: { action: 'approved' },
      runId: 'run-suspend-1',
      toolCallId: 'tool-call-1',
      toolName: 'brainstrike.submitPlan',
    };
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: { provider: 'openai' },
        messages: [],
        runConfig: { custom: { [TOOL_SUSPEND_RUN_CONFIG_KEY]: resumeAction } },
      })
    );

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'tool_resume_unavailable',
      message: 'Hosted Web tool resume requires durable workflow storage.',
    });
    // Convergence (BST-973-2): the server-config 503 gate precedes request
    // validation, so provider configs are resolved before any 400/409.
    expect(resolveAssistantProviderConfig).toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it('rejects malformed tool approval actions on the web assistant helper route', async () => {
    mockOpenAiAssistantProvider();

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        messages: [{ id: '1', parts: [], role: 'user' }],
        runConfig: {
          custom: {
            [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
              action: 'decline',
              runId: 'run-approval-1',
            },
          },
        },
      })
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'invalid_tool_approval_action',
    });
    expect(streamHostedWebTurn).not.toHaveBeenCalled();
  });

  it('rejects malformed tool suspend resume actions on the web assistant helper route', async () => {
    mockOpenAiAssistantProvider();

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        messages: [],
        runConfig: {
          custom: {
            [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
              resumeData: { action: 'approved' },
              runId: 'run-suspend-1',
            },
          },
        },
      })
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_tool_resume_action',
      message:
        'Tool resume action must contain only resumeData, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
    });
    // Convergence (BST-973-2): the server-config 503 gate precedes request
    // validation, so provider configs are resolved before any 400/409.
    expect(resolveAssistantProviderConfig).toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an extra own field',
      {
        injected: true,
        resumeData: 'answer',
        runId: 'run-suspend-1',
        toolCallId: 'tool-call-1',
      },
    ],
    [
      'an oversized identifier',
      {
        resumeData: 'answer',
        runId: 'r'.repeat(ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS + 1),
        toolCallId: 'tool-call-1',
      },
    ],
    [
      'an oversized tool name',
      {
        resumeData: 'answer',
        runId: 'run-suspend-1',
        toolCallId: 'tool-call-1',
        toolName: 't'.repeat(ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS + 1),
      },
    ],
    [
      'a blank tool name',
      {
        resumeData: 'answer',
        runId: 'run-suspend-1',
        toolCallId: 'tool-call-1',
        toolName: '   ',
      },
    ],
  ])('returns typed 400 for a resume action with %s on the Vite route', async (_case, action) => {
    mockOpenAiAssistantProvider();
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;
    const res = new ResponseSink();

    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        messages: [],
        runConfig: { custom: { [TOOL_SUSPEND_RUN_CONFIG_KEY]: action } },
      })
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_tool_resume_action',
      message:
        'Tool resume action must contain only resumeData, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
    });
    // Convergence (BST-973-2): the server-config 503 gate precedes request
    // validation, so provider configs are resolved before any 400/409.
    expect(resolveAssistantProviderConfig).toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it.each([
    [
      'extra own fields',
      {
        action: 'decline',
        injected: true,
        runId: 'run-approval-1',
        toolCallId: 'tool-call-1',
      },
    ],
    [
      'oversized identifiers',
      {
        action: 'decline',
        runId: 'r'.repeat(ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS + 1),
        toolCallId: 'tool-call-1',
      },
    ],
  ])('returns typed 400 for approval actions with %s on the Vite route', async (_case, action) => {
    mockOpenAiAssistantProvider();
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;
    const res = new ResponseSink();

    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        messages: [],
        runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: action } },
      })
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'invalid_tool_approval_action',
      message:
        'Tool approval action must contain only action, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
    });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('returns empty_prompt when a normal assistant turn has no effective prompt', async () => {
    mockOpenAiAssistantProvider();
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {};
    const res = new ResponseSink();

    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: { provider: 'openai' },
        messages: [{ id: 'empty-1', parts: [{ text: '   ', type: 'text' }], role: 'user' }],
      })
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'empty_prompt' });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('accepts an image-only user turn on the Vite assistant route', async () => {
    mockOpenAiAssistantProvider();
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'a tiny image' } as StreamChunk;
      },
    };
    vi.mocked(buildWebAssistantStreamFromPrepared).mockResolvedValue(stream);
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(new Response('ok'));
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {};
    const res = new ResponseSink();

    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: { provider: 'openai' },
        messages: [
          {
            id: 'image-only',
            parts: [
              {
                data: 'data:image/png;base64,aGVsbG8=',
                mediaType: 'image/png',
                type: 'file',
              },
            ],
            role: 'user',
          },
        ],
      })
    );

    expect(res.status).toBe(200);
    expect(buildWebAssistantStreamFromPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        agentMessages: [
          {
            id: 'image-only',
            parts: [
              {
                data: 'data:image/png;base64,aGVsbG8=',
                mediaType: 'image/png',
                type: 'file',
              },
            ],
            role: 'user',
          },
        ],
      })
    );
  });

  it.each([
    [
      'assistant',
      [{ id: 'assistant-1', parts: [{ text: 'continue', type: 'text' }], role: 'assistant' }],
    ],
    ['system', [{ id: 'system-1', parts: [{ text: 'continue', type: 'text' }], role: 'system' }]],
    [
      'trailing assistant history',
      [
        { id: 'user-1', parts: [{ text: 'question', type: 'text' }], role: 'user' },
        { id: 'assistant-1', parts: [{ text: 'answer', type: 'text' }], role: 'assistant' },
      ],
    ],
    [
      'blank trailing assistant history',
      [
        { id: 'user-1', parts: [{ text: 'question', type: 'text' }], role: 'user' },
        { id: 'assistant-1', parts: [{ text: '   ', type: 'text' }], role: 'assistant' },
      ],
    ],
  ])('rejects a normal assistant turn whose final prompt role is %s', async (_case, messages) => {
    mockOpenAiAssistantProvider();
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {};
    const res = new ResponseSink();

    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({ data: { provider: 'openai' }, messages })
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'empty_prompt' });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('returns typed 400 for an invalid assistant attachment', async () => {
    mockOpenAiAssistantProvider();
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {};
    const res = new ResponseSink();

    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        messages: [
          {
            content: [
              {
                data: 'data:application/pdf;base64,AAAA',
                mediaType: 'application/pdf',
                type: 'file',
              },
            ],
            id: 'attachment-1',
            role: 'user',
          },
        ],
      })
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_attachment',
      message: 'Assistant attachment payload is invalid.',
      reason: 'unsupported-media-type',
    });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('rejects a non-empty last-event-id array without consulting the session registry', async () => {
    mockOpenAiAssistantProvider();

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = { 'last-event-id': ['evt-1', 'evt-2'] } as unknown as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(req, res as unknown as http.ServerResponse, '{');

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'stream_resume_unavailable',
      message:
        'Hosted Web stream replay requires durable storage and is unavailable for this deployment.',
    });
    expect(resolveDataStreamSession).not.toHaveBeenCalled();
    expect(resolveAssistantProviderConfig).not.toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it('creates a stateless response when no last-event-id header is present', async () => {
    mockOpenAiAssistantProvider();

    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'new' } as StreamChunk;
      },
    };

    vi.mocked(buildWebAssistantStreamFromPrepared).mockResolvedValue(stream);
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(
      new Response('fresh-session')
    );

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: { provider: 'openai' },
        messages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(resolveDataStreamSession).not.toHaveBeenCalled();
    expect(vi.mocked(createStatelessAssistantDataStreamResponse)).toHaveBeenCalled();
    expect(res.body).toContain('fresh-session');
  });

  it('calls res.end() when response body is null', async () => {
    mockOpenAiAssistantProvider();
    vi.mocked(buildWebAssistantStreamFromPrepared).mockResolvedValue(
      (async function* stream() {})() as AsyncIterable<StreamChunk>
    );
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(
      new Response(null, { status: 200 })
    );

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

    const res = new ResponseSink();
    const endSpy = vi.spyOn(res, 'end');

    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: { provider: 'openai' },
        messages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(endSpy).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('waits for drain event when write returns false (backpressure)', async () => {
    mockOpenAiAssistantProvider();

    // Create a response that has a body with content
    const encoder = new TextEncoder();
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('chunk-data'));
        controller.close();
      },
    });
    const response = new Response(bodyStream, { status: 200 });

    vi.mocked(buildWebAssistantStreamFromPrepared).mockResolvedValue(
      (async function* stream() {})() as AsyncIterable<StreamChunk>
    );
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(response);

    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {} as http.IncomingHttpHeaders;

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

    await handleAssistantEndpoint(
      req,
      res as unknown as http.ServerResponse,
      requestBody({
        data: { provider: 'openai' },
        messages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(drainResolved).toBe(true);
    expect(res.body).toContain('chunk-data');
  });

  it('does not abort the runtime when a real Node request closes after a complete body', async () => {
    mockOpenAiAssistantProvider();

    let runtimeSignal: AbortSignal | undefined;
    let requestWasComplete: boolean | undefined;
    let resolveHandler!: () => void;
    let rejectHandler!: (error: unknown) => void;
    const handlerFinished = new Promise<void>((resolve, reject) => {
      resolveHandler = resolve;
      rejectHandler = reject;
    });

    const server = http.createServer((req, res) => {
      const requestClosed = once(req, 'close').then(() => {
        requestWasComplete = req.complete;
      });
      req.resume();

      vi.mocked(buildWebAssistantStreamFromPrepared).mockImplementationOnce(async ({ signal }) => {
        runtimeSignal = signal;
        await requestClosed;
        return (async function* stream() {})() as AsyncIterable<StreamChunk>;
      });
      vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValueOnce(
        new Response('normal-close-ok')
      );

      handleAssistantEndpoint(req, res, NORMAL_ASSISTANT_REQUEST_BODY).then(
        resolveHandler,
        rejectHandler
      );
    });

    try {
      const port = await listenOnLoopback(server);

      await expect(postToServer(port)).resolves.toContain('normal-close-ok');
      await handlerFinished;

      expect(requestWasComplete).toBe(true);
      expect(runtimeSignal).toBeDefined();
      expect(runtimeSignal?.aborted).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it('aborts the runtime when a real Node client aborts an incomplete request body', async () => {
    mockOpenAiAssistantProvider();

    let runtimeSignal: AbortSignal | undefined;
    let requestWasComplete: boolean | undefined;
    let resolveSignalCaptured!: () => void;
    const signalCaptured = new Promise<void>((resolve) => {
      resolveSignalCaptured = resolve;
    });
    let handlerError: unknown;
    let resolveHandler!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    const server = http.createServer((req, res) => {
      req.once('close', () => {
        requestWasComplete = req.complete;
      });
      vi.mocked(buildWebAssistantStreamFromPrepared).mockImplementationOnce(async ({ signal }) => {
        if (!signal) {
          throw new Error('Expected the Hosted Web runtime to receive a cancellation signal.');
        }
        runtimeSignal = signal;
        resolveSignalCaptured();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return (async function* stream() {})() as AsyncIterable<StreamChunk>;
      });
      vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValueOnce(new Response(null));

      handleAssistantEndpoint(req, res, NORMAL_ASSISTANT_REQUEST_BODY).then(
        resolveHandler,
        (error: unknown) => {
          handlerError = error;
          resolveHandler();
        }
      );
    });

    try {
      const port = await listenOnLoopback(server);
      const request = http.request({
        headers: { 'Content-Length': 1024 },
        host: '127.0.0.1',
        method: 'POST',
        path: '/api/assistant',
        port,
      });
      request.on('error', () => {
        // ECONNRESET is expected after destroying the intentionally incomplete request.
      });
      request.write('{');

      await signalCaptured;
      const requestClosed = new Promise<void>((resolve) => {
        request.once('close', () => resolve());
      });
      request.destroy();
      await requestClosed;
      await handlerFinished;

      expect(requestWasComplete).toBe(false);
      expect(runtimeSignal).toBeDefined();
      expect(runtimeSignal?.aborted).toBe(true);
      expect(handlerError).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('aborts and releases real Node response backpressure when the downstream closes', async () => {
    mockOpenAiAssistantProvider();

    let runtimeSignal: AbortSignal | undefined;
    let responseWritableEndedAtClose: boolean | undefined;
    let responseBodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let serverResponseForCleanup: http.ServerResponse | undefined;
    let resolveBackpressure!: () => void;
    const backpressureObserved = new Promise<void>((resolve) => {
      resolveBackpressure = resolve;
    });
    let resolveResponseClose!: () => void;
    const responseClosed = new Promise<void>((resolve) => {
      resolveResponseClose = resolve;
    });
    let resolveHandler!: () => void;
    let rejectHandler!: (error: unknown) => void;
    const handlerFinished = new Promise<void>((resolve, reject) => {
      resolveHandler = resolve;
      rejectHandler = reject;
    });

    const server = http.createServer((req, res) => {
      const requestClosed = once(req, 'close');
      req.resume();

      void requestClosed.then(() => {
        serverResponseForCleanup = res;
        const write = res.write.bind(res);
        res.write = ((chunk: Uint8Array) => {
          const accepted = write(chunk);
          if (!accepted) {
            resolveBackpressure();
          }
          return accepted;
        }) as typeof res.write;
        res.once('close', () => {
          responseWritableEndedAtClose = res.writableEnded;
          resolveResponseClose();
        });

        vi.mocked(buildWebAssistantStreamFromPrepared).mockImplementationOnce(
          async ({ signal }) => {
            runtimeSignal = signal;
            return (async function* stream() {})() as AsyncIterable<StreamChunk>;
          }
        );
        vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                responseBodyController = undefined;
              },
              start(controller) {
                responseBodyController = controller;
                controller.enqueue(new Uint8Array(8 * 1024 * 1024));
              },
            })
          )
        );

        handleAssistantEndpoint(req, res, NORMAL_ASSISTANT_REQUEST_BODY).then(
          resolveHandler,
          rejectHandler
        );
      });
    });

    try {
      const port = await listenOnLoopback(server);
      let resolveClientResponse!: (response: http.IncomingMessage) => void;
      const clientResponse = new Promise<http.IncomingMessage>((resolve) => {
        resolveClientResponse = resolve;
      });
      const request = http.request(
        {
          headers: {
            'Content-Length': Buffer.byteLength(NORMAL_ASSISTANT_REQUEST_BODY),
            'Content-Type': 'application/json',
          },
          host: '127.0.0.1',
          method: 'POST',
          path: '/api/assistant',
          port,
        },
        (response) => {
          response.on('error', () => {
            // ECONNRESET is expected after destroying the downstream response.
          });
          response.pause();
          resolveClientResponse(response);
        }
      );
      request.on('error', () => {
        // The client is intentionally destroyed while the response is streaming.
      });
      request.end(NORMAL_ASSISTANT_REQUEST_BODY);

      const response = await clientResponse;
      await backpressureObserved;
      response.destroy();
      request.destroy();
      await responseClosed;

      const completed = await settlesWithin(handlerFinished, 1000);

      expect(responseWritableEndedAtClose).toBe(false);
      expect(runtimeSignal).toBeDefined();
      expect(runtimeSignal?.aborted).toBe(true);
      expect(completed).toBe(true);
    } finally {
      responseBodyController?.close();
      serverResponseForCleanup?.emit('drain');
      await closeServer(server);
    }
  });

  it('sends enabled: true status when provider is enabled', async () => {
    mockOpenAiAssistantProvider();

    const res = new ResponseSink();
    sendAssistantStatusResponse(res as unknown as http.ServerResponse);

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({
      enabled: true,
      model: 'gpt-5.6-terra',
      provider: 'openai',
      providerKeySources: [{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' }],
      providers: ['openai'],
    });
  });
});
