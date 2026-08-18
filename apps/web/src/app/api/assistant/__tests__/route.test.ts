import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/agent/hosted-web', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent/hosted-web')>(
    '@brainstrike/agent/hosted-web'
  );
  const rootAgent =
    await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value));
  return {
    ...actual,
    createStatelessAssistantDataStreamResponse: vi.fn(),
    readToolApprovalRunConfigAction: (runConfig: unknown) => {
      if (!isRecord(runConfig)) {
        return;
      }
      const custom = runConfig['custom'];
      if (!isRecord(custom)) {
        return;
      }
      const action = custom[rootAgent.TOOL_APPROVAL_RUN_CONFIG_KEY];
      if (action === undefined) {
        return;
      }
      return rootAgent.isAssistantToolApprovalAction(action) ? { action } : { invalid: true };
    },
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

// The route builds normal turns through one stateless Web stream seam.
vi.mock('../../../../server/web-assistant-stream', () => ({
  buildWebAssistantStreamFromPrepared: vi.fn(),
}));

import type { RuntimeData, StreamChunk } from '@brainstrike/agent';
import {
  ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS,
  ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/agent';
import {
  createStatelessAssistantDataStreamResponse,
  HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
} from '@brainstrike/agent/hosted-web';
import { resolveAssistantProviderConfig } from '../../../../server/assistant-config';
import { buildWebAssistantStreamFromPrepared } from '../../../../server/web-assistant-stream';
import { POST } from '../route';

function mockOpenAiProviderConfig(
  config: ReturnType<typeof resolveAssistantProviderConfig> & { readonly provider: 'openai' }
): void {
  vi.mocked(resolveAssistantProviderConfig).mockImplementation((provider = 'openai') => {
    if (provider === 'openai') {
      return config;
    }
    return { disabledReason: 'missing_api_key', enabled: false, provider };
  });
}

describe('assistant route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects every last-event-id instead of depending on process-local replay state', async () => {
    const req = new Request('http://localhost/api/assistant', {
      body: '{',
      headers: { 'last-event-id': 'evt-1' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'stream_resume_unavailable',
      message:
        'Hosted Web stream replay requires durable storage and is unavailable for this deployment.',
    });
    expect(resolveAssistantProviderConfig).not.toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it('enforces the request body cap before resuming an existing session', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const req = new Request('http://localhost/api/assistant', {
      body: stream,
      duplex: 'half',
      headers: {
        'last-event-id': 'evt-1',
      },
      method: 'POST',
    } as RequestInit & { duplex: 'half' });

    const res = await POST(req);

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: 'request_body_too_large',
      message: `Assistant request body exceeds ${HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES} bytes.`,
    });
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it('returns 503 when provider is disabled', async () => {
    mockOpenAiProviderConfig({
      apiKey: '',
      disabledReason: 'missing_api_key',
      enabled: false,
      provider: 'openai',
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

  it('returns 400 missing_provider when the request names no provider', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });

    const res = await POST(
      new Request('http://localhost/api/assistant', {
        body: JSON.stringify({
          messages: [{ id: '1', parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
    );

    // Convergence (BST-973-2): the web-only default-provider fallback is gone —
    // like desktop, every turn must name its provider.
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'missing_provider',
      message: 'No provider specified or provider is not supported.',
    });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('accepts only a client-selected provider with a configured server credential', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockImplementation((provider = 'openai') => {
      if (provider === 'anthropic') {
        return {
          apiKey: 'anthropic-server-key',
          enabled: true,
          provider,
          source: 'ANTHROPIC_API_KEY',
        };
      }
      return { disabledReason: 'missing_api_key', enabled: false, provider };
    });
    vi.mocked(buildWebAssistantStreamFromPrepared).mockResolvedValue(
      (async function* stream() {})()
    );
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(
      new Response('ok', { status: 200 })
    );

    const enabledResponse = await POST(
      new Request('http://localhost/api/assistant', {
        body: JSON.stringify({
          data: { provider: 'anthropic' },
          messages: [{ id: '1', parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
    );
    expect(enabledResponse.status).toBe(200);
    expect(buildWebAssistantStreamFromPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { key: 'anthropic-server-key', source: 'env', type: 'api_key' },
        runtimeData: expect.objectContaining({ provider: 'anthropic' }),
      })
    );

    vi.mocked(buildWebAssistantStreamFromPrepared).mockClear();
    const disabledResponse = await POST(
      new Request('http://localhost/api/assistant', {
        body: JSON.stringify({
          data: { provider: 'openrouter' },
          messages: [{ id: '2', parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
    );
    expect(disabledResponse.status).toBe(400);
    await expect(disabledResponse.json()).resolves.toEqual({
      error: 'invalid_runtime_data',
      message: 'Invalid web assistant runtime field: provider',
    });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('returns 400 when request body is invalid JSON', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(
      new Response('unexpected', { status: 200 })
    );

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
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an empty body',
      '',
      {
        error: 'invalid_json',
        message: 'Request body must be valid JSON.',
      },
    ],
    [
      'a missing messages field',
      '{}',
      {
        error: 'invalid_request_payload',
        message: 'Assistant request payload must include its own messages array.',
      },
    ],
    [
      'an unsupported top-level field',
      JSON.stringify({ messages: [], system: 'must stay server-owned' }),
      {
        error: 'invalid_request_payload',
        message: 'Assistant request payload contains an unsupported top-level field.',
      },
    ],
  ])('returns canonical typed 400 for %s', async (_name, body, expected) => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const req = new Request('http://localhost/api/assistant', {
      body,
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual(expected);
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('rejects a malformed tool resume action', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [],
        runConfig: {
          custom: {
            [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
              runId: 'run-suspend-1',
              toolCallId: 'tool-call-1',
            },
          },
        },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_tool_resume_action',
      message:
        'Tool resume action must contain only resumeData, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
    });
    // Convergence (BST-973-2): the server-config 503 gate precedes request
    // validation, so provider configs are resolved before any 400/409.
    expect(resolveAssistantProviderConfig).toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
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
  ])('returns typed 400 for a resume action with %s', async (_case, action) => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [],
        runConfig: { custom: { [TOOL_SUSPEND_RUN_CONFIG_KEY]: action } },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
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

  it('rejects conflicting approval and resume actions', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [],
        runConfig: {
          custom: {
            [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
              action: 'approve',
              runId: 'run-approval-1',
              toolCallId: 'tool-call-1',
            },
            [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
              resumeData: 'answer',
              runId: 'run-suspend-1',
              toolCallId: 'tool-call-2',
            },
          },
        },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'conflicting_tool_continuation_actions',
      message: 'Assistant request must contain at most one tool continuation action.',
    });
    // Convergence (BST-973-2): the server-config 503 gate precedes request
    // validation, so provider configs are resolved before any 400/409.
    expect(resolveAssistantProviderConfig).toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('returns typed 400 when the assistant message id is malformed', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [{ role: 'user', text: 'hello' }],
        unstable_assistantMessageId: 42,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_messages',
      message: 'Assistant message id must be a non-empty bounded string.',
    });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('returns typed 400 for a deeply nested message graph before normalization', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    let nested: Record<string, unknown> = { text: 'hello' };
    for (let depth = 0; depth < 3000; depth += 1) {
      nested = { content: nested };
    }
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [{ content: nested, id: 'deep-1', role: 'user' }],
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
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('returns typed 400 for an invalid attachment', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
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
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('returns typed invalid_attachment for an empty image', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [
          {
            content: [
              { text: 'Describe this image', type: 'text' },
              {
                data: 'data:image/png;base64,',
                mediaType: 'image/png',
                type: 'file',
              },
            ],
            id: 'attachment-1',
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
      reason: 'invalid-base64',
    });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('returns 400 when request body has no non-empty prompt', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(
      new Response('unexpected', { status: 200 })
    );

    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ id: '1', parts: [{ text: '   ', type: 'text' }], role: 'user' }],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload).toEqual({ error: 'empty_prompt' });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
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
  ])(
    'requires the final message to be a non-empty user prompt, not %s',
    async (_case, messages) => {
      mockOpenAiProviderConfig({
        apiKey: 'test-key',
        enabled: true,
        provider: 'openai',
      });

      const res = await POST(
        new Request('http://localhost/api/assistant', {
          body: JSON.stringify({ data: { provider: 'openai' }, messages }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        })
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'empty_prompt' });
      expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    }
  );

  it('returns 413 when a chunked request body exceeds the default byte limit', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES));
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
      message: `Assistant request body exceeds ${HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES} bytes.`,
    });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('returns 502 when stream initialization fails', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    vi.mocked(buildWebAssistantStreamFromPrepared).mockRejectedValue(new Error('boom'));

    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        data: { provider: 'openai' },
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
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
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

  it('returns typed 400 when known runtime metadata has an invalid nested shape', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(
      new Response('unexpected', { status: 200 })
    );

    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        data: {
          workspaceContext: {
            files: [{ injected: true, path: '/a.ts' }],
          },
        },
        messages: [{ id: '1', parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_runtime_data',
      message: 'Invalid web assistant runtime field: workspaceContext',
    });
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it('rejects malformed tool approval actions on the web assistant route', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
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
      message:
        'Tool approval action must contain only action, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
    });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it.each([
    [
      'extra own fields',
      {
        action: 'approve',
        injected: true,
        runId: 'run-approval-1',
        toolCallId: 'tool-call-1',
      },
    ],
    [
      'oversized identifiers',
      {
        action: 'approve',
        runId: 'run-approval-1',
        toolCallId: 'c'.repeat(ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS + 1),
      },
    ],
  ])('returns typed 400 for approval actions with %s', async (_case, action) => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        messages: [],
        runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: action } },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'invalid_tool_approval_action',
    });
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
  });

  it('creates a new session when provider is enabled', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });

    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'hi' } as StreamChunk;
      },
    };

    vi.mocked(buildWebAssistantStreamFromPrepared).mockResolvedValue(stream);
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(
      new Response('ok', { status: 200 })
    );

    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ id: '1', parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(createStatelessAssistantDataStreamResponse).toHaveBeenCalledWith(stream);
    // A normal turn reaches the stream with the PREPARED messages/runtime and
    // the typed credential (BST-1352); continuation actions never reach it.
    expect(buildWebAssistantStreamFromPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        agentMessages: expect.any(Array),
        credential: { key: 'test-key', source: 'env', type: 'api_key' },
        signal: req.signal,
      })
    );
    expect(vi.mocked(buildWebAssistantStreamFromPrepared).mock.calls[0]?.[0]).not.toHaveProperty(
      'toolApprovalAction'
    );
    expect(vi.mocked(buildWebAssistantStreamFromPrepared).mock.calls[0]?.[0]).not.toHaveProperty(
      'toolResumeAction'
    );
  });

  it('accepts an image-only user turn as a valid vision prompt', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'a tiny image' } as StreamChunk;
      },
    };
    vi.mocked(buildWebAssistantStreamFromPrepared).mockResolvedValue(stream);
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(
      new Response('ok', { status: 200 })
    );

    const res = await POST(
      new Request('http://localhost/api/assistant', {
        body: JSON.stringify({
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
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
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

  it('accepts the image-elision metadata emitted by the shared UI transport', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'ok' } as StreamChunk;
      },
    };
    let receivedRuntime: RuntimeData | undefined;
    vi.mocked(buildWebAssistantStreamFromPrepared).mockImplementation(async (params) => {
      receivedRuntime = params.runtimeData;
      return stream;
    });
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(
      new Response('ok', { status: 200 })
    );

    const res = await POST(
      new Request('http://localhost/api/assistant', {
        body: JSON.stringify({
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
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
    );

    expect(res.status).toBe(200);
    expect(buildWebAssistantStreamFromPrepared).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { key: 'test-key', source: 'env', type: 'api_key' } })
    );
    expect(receivedRuntime).toEqual({ provider: 'openai' });
  });

  it('forwards a valid client assistant message id into the prepared runtime', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'ok' } as StreamChunk;
      },
    };
    let receivedRuntime: RuntimeData | undefined;
    vi.mocked(buildWebAssistantStreamFromPrepared).mockImplementation(async (params) => {
      receivedRuntime = params.runtimeData;
      return stream;
    });
    vi.mocked(createStatelessAssistantDataStreamResponse).mockReturnValue(
      new Response('ok', { status: 200 })
    );

    const res = await POST(
      new Request('http://localhost/api/assistant', {
        body: JSON.stringify({
          data: { provider: 'openai' },
          messages: [
            { id: 'current-user', parts: [{ text: 'continue', type: 'text' }], role: 'user' },
          ],
          // biome-ignore lint/style/useNamingConvention: assistant-ui transport field.
          unstable_assistantMessageId: 'assistant-client-id',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
    );

    // Convergence delta (desktop parity): the validated client id is stamped
    // into the prepared runtime by the shared preparation — previously web's
    // runtime never carried assistantMessageId.
    expect(res.status).toBe(200);
    expect(receivedRuntime).toEqual({
      assistantMessageId: 'assistant-client-id',
      provider: 'openai',
    });
  });

  it('fails closed for a valid tool approval action in stateless production', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });

    const approvalAction = {
      action: 'approve',
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
      toolName: 'workspace.writeFile',
    };
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ id: '1', parts: [], role: 'user' }],
        runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction } },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'tool_approval_unavailable',
      message: 'Hosted Web tool approval requires durable workflow storage.',
    });
    // Convergence (BST-973-2): the server-config 503 gate precedes request
    // validation, so provider configs are resolved before any 400/409.
    expect(resolveAssistantProviderConfig).toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it('fails closed for a valid tool decline action in stateless production', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });

    const approvalAction = {
      action: 'decline',
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
      toolName: 'workspace.writeFile',
    };
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [],
        runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction } },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'tool_approval_unavailable',
      message: 'Hosted Web tool approval requires durable workflow storage.',
    });
    // Convergence (BST-973-2): the server-config 503 gate precedes request
    // validation, so provider configs are resolved before any 400/409.
    expect(resolveAssistantProviderConfig).toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });

  it('fails closed for a valid tool resume action in stateless production', async () => {
    mockOpenAiProviderConfig({
      apiKey: 'test-key',
      enabled: true,
      provider: 'openai',
    });
    const req = new Request('http://localhost/api/assistant', {
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [],
        runConfig: {
          custom: {
            [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
              resumeData: { action: 'approved' },
              runId: 'run-suspend-1',
              toolCallId: 'tool-call-1',
              toolName: 'submitPlan',
            },
          },
        },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const res = await POST(req);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'tool_resume_unavailable',
      message: 'Hosted Web tool resume requires durable workflow storage.',
    });
    // Convergence (BST-973-2): the server-config 503 gate precedes request
    // validation, so provider configs are resolved before any 400/409.
    expect(resolveAssistantProviderConfig).toHaveBeenCalled();
    expect(buildWebAssistantStreamFromPrepared).not.toHaveBeenCalled();
    expect(createStatelessAssistantDataStreamResponse).not.toHaveBeenCalled();
  });
});
