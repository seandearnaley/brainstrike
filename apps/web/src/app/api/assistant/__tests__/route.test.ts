import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../../../server/assistant-config', async () => {
  const actual = await vi.importActual<typeof import('../../../../server/assistant-config')>(
    '../../../../server/assistant-config'
  );
  return {
    ...actual,
    resolveAssistantProviderConfig: vi.fn(),
  };
});

// The route now builds its stream (normal turn OR approval resume) through this
// seam, which owns the in-process workflow storage. Mock it so the unit test
// never spins up a real PGlite store.
vi.mock('../../../../server/web-mastra-storage', () => ({
  buildWebAssistantStream: vi.fn(),
}));

import type { AssistantDataStreamSession, StreamChunk } from '@brainstrike/agent';
import {
  assistantDataStreamSessions,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  resolveDataStreamSession,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { resolveAssistantProviderConfig } from '../../../../server/assistant-config';
import { InvalidWebAssistantRuntimeDataError } from '../../../../server/web-assistant-runtime';
import { buildWebAssistantStream } from '../../../../server/web-mastra-storage';
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
      headers: { 'last-event-id': 'evt-1' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('resume');
  });

  it('returns 503 when provider is disabled', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: '',
      disabledReason: 'missing_api_key',
      enabled: false,
    });

    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [{ id: '1', parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(503);
    const payload = await res.json();
    expect(payload).toMatchObject({ error: 'assistant_disabled' });
  });

  it('returns 400 when request body is invalid JSON', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
    });
    vi.mocked(toAiSdkStyleStream).mockResolvedValue((async function* stream() {})());
    vi.mocked(assistantDataStreamSessions.create).mockReturnValue({
      createResponse: () => new Response('unexpected', { status: 200 }),
    } as unknown as AssistantDataStreamSession);

    const req = new Request('http://localhost/api/assistant', {
      body: '{"messages":[',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const payload = await res.json();
    expect(payload).toEqual({
      error: 'invalid_json',
      message: 'Request body must be valid JSON.',
    });
    expect(buildWebAssistantStream).not.toHaveBeenCalled();
  });

  it('returns 400 when request body has no non-empty prompt', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
    });
    vi.mocked(toAiSdkStyleStream).mockResolvedValue((async function* stream() {})());
    vi.mocked(assistantDataStreamSessions.create).mockReturnValue({
      createResponse: () => new Response('unexpected', { status: 200 }),
    } as unknown as AssistantDataStreamSession);

    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [{ id: '1', parts: [{ text: '   ', type: 'text' }], role: 'user' }],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload).toEqual({ error: 'empty_prompt' });
    expect(buildWebAssistantStream).not.toHaveBeenCalled();
  });

  it('returns 413 when a chunked request body exceeds the default byte limit', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
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
    expect(buildWebAssistantStream).not.toHaveBeenCalled();
  });

  it('returns 502 when stream initialization fails', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
    });
    vi.mocked(buildWebAssistantStream).mockRejectedValue(new Error('boom'));

    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [{ id: '1', parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const payload = await res.json();
    expect(payload).toMatchObject({ error: 'agent_stream_init_failed' });
    expect(payload.message).toBe('Assistant stream initialization failed');
  });

  it('returns 400 when request data contains a server-only runtime field', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
    });
    vi.mocked(buildWebAssistantStream).mockRejectedValue(
      new InvalidWebAssistantRuntimeDataError('mcpConfig')
    );

    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        data: { mcpConfig: { servers: [] } },
        messages: [{ id: '1', parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_runtime_data',
      message: 'Unsupported web assistant runtime field: mcpConfig',
    });
  });

  it('rejects malformed tool approval actions on the web assistant route', async () => {
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [{ id: '1', parts: [], role: 'user' }],
        runConfig: {
          custom: {
            [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
              action: 'approve',
              runId: 'run-approval-1',
            },
          },
        },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'invalid_tool_approval_action',
    });
    expect(buildWebAssistantStream).not.toHaveBeenCalled();
  });

  it('creates a new session when provider is enabled', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
    });

    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'hi' } as StreamChunk;
      },
    };

    vi.mocked(buildWebAssistantStream).mockResolvedValue(stream);
    vi.mocked(assistantDataStreamSessions.create).mockImplementation(
      () =>
        ({
          createResponse: () => new Response('ok', { status: 200 }),
        }) as unknown as AssistantDataStreamSession
    );

    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [{ id: '1', parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    // A normal turn builds the stream with converted messages + the apiKey and
    // raw `data` (the seam resolves the trusted runtime/policy), and NO
    // toolApprovalAction (that path is the resume below).
    expect(buildWebAssistantStream).toHaveBeenCalledWith(
      expect.objectContaining({
        agentMessages: expect.any(Array),
        apiKey: 'test-key',
      })
    );
    expect(vi.mocked(buildWebAssistantStream).mock.calls[0]?.[0]).not.toHaveProperty(
      'toolApprovalAction'
    );
  });

  it('resumes a tool approval action through workflow storage (no longer 501)', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
    });
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'resumed' } as StreamChunk;
      },
    };
    vi.mocked(buildWebAssistantStream).mockResolvedValue(stream);
    vi.mocked(assistantDataStreamSessions.create).mockImplementation(
      () =>
        ({
          createResponse: () => new Response('resumed', { status: 200 }),
        }) as unknown as AssistantDataStreamSession
    );

    const approvalAction = {
      action: 'approve',
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
      toolName: 'workspace.writeFile',
    };
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [{ id: '1', parts: [], role: 'user' }],
        runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction } },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('resumed');
    expect(buildWebAssistantStream).toHaveBeenCalledWith(
      expect.objectContaining({ toolApprovalAction: approvalAction })
    );
    expect(assistantDataStreamSessions.create).toHaveBeenCalledWith(stream);
  });

  it('declines a tool approval action through workflow storage', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
    });
    vi.mocked(buildWebAssistantStream).mockResolvedValue(
      (async function* stream() {})() as AsyncIterable<StreamChunk>
    );
    vi.mocked(assistantDataStreamSessions.create).mockImplementation(
      () =>
        ({
          createResponse: () => new Response('declined', { status: 200 }),
        }) as unknown as AssistantDataStreamSession
    );

    const approvalAction = {
      action: 'decline',
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
      toolName: 'workspace.writeFile',
    };
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction } },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(buildWebAssistantStream).toHaveBeenCalledWith(
      expect.objectContaining({ toolApprovalAction: approvalAction })
    );
  });
});
