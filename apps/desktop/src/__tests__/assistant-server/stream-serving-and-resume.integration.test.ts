/**
 * Stream serving, abort/detach, replay cursor + resume, cancel, steer, and the
 * 413 transport half (moved verbatim from the pre-split
 * assistant-server.integration.test.ts, BST-1028 slice 3). Deltas, exactly:
 * - mock defaults prime in beforeEach (slice-1 lesson);
 * - the steering-registry reset moves into beforeEach/afterEach hooks,
 *   REPLACING the tests' own bracketing (hooks strictly dominate it for
 *   leak-proofing: a mid-test failure cannot skip them);
 * - the `@brainstrike/agent` mock is carried VERBATIM from the monolith
 *   (unlike the narrowed status/rejection suites): these full-POST flows
 *   traverse runtime construction, session creation, and stream mapping, and
 *   fidelity to the monolith's behavior beats mock minimalism here;
 * - the 413 body-limit test lives here (not the pure rejection suite) because
 *   its `Connection: close` header assertion is respondAssistantRejection's
 *   transport behavior.
 * db-main stays mocked: these POSTs genuinely call the injected getDatabase
 * for workspace-roots enrichment.
 */
import type http from 'node:http';
import { DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES } from '@brainstrike/agent';
import { resetRunSteeringRegistry } from '@brainstrike/assistant-service/steering';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { desktopAssistantServerLogger, handleAssistantRequest } from '../../assistant-server';
import { createRunRequest, MockRequest, MockResponse } from './_harness';

const mockSecretsService = vi.hoisted(() => ({
  deleteKey: vi.fn(),
  // BST-1352: the assistant POST path reads the TYPED credential.
  getCredential: vi.fn((_provider: string) =>
    Promise.resolve({ key: 'test-api-key', type: 'api_key' as const })
  ),
  getKey: vi.fn((_provider: string) => Promise.resolve('test-api-key')),
  listProviders: vi.fn(() => Promise.resolve(['openai'])),
  saveKey: vi.fn(),
}));

vi.mock('../../secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets')>();
  return {
    ...actual,
    getSecretsService: () => mockSecretsService,
  };
});

vi.mock('../../agent-client-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-client-loader')>();
  return {
    ...actual,
    getAgentProviderEnvKeys: vi.fn(() => []),
  };
});

vi.mock('../../assistant-server/http', async () => {
  const actual = await vi.importActual<typeof import('../../assistant-server/http')>(
    '../../assistant-server/http'
  );
  return {
    ...actual,
    streamResponse: vi.fn(),
    writeHeaders: vi.fn(),
  };
});

vi.mock('../../mcp-loader', () => ({
  loadMcpConfig: vi.fn(() => Promise.resolve({ config: undefined })),
}));

const { convertAssistantUiMessages } = vi.hoisted(() => ({
  convertAssistantUiMessages: vi.fn((messages) => messages),
}));

// Prep (BST-973-2) imports conversion from the slim hosted-web subpath, so the
// fixture-stabilizing override lives on THAT specifier; the hoisted spy is also
// exported from the root-specifier factory so existing assertions keep
// observing every call.
vi.mock('@brainstrike/agent/hosted-web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent/hosted-web')>();
  return {
    ...actual,
    convertAssistantUiMessagesWithFinalInput: vi.fn(
      (
        messages: Parameters<typeof actual.convertAssistantUiMessagesWithFinalInput>[0]
      ): ReturnType<typeof actual.convertAssistantUiMessagesWithFinalInput> => {
        const finalRawMessage = messages.at(-1);
        const { finalInputMessage } = actual.convertAssistantUiMessagesWithFinalInput(
          finalRawMessage ? [finalRawMessage] : []
        );
        return {
          finalInputMessage,
          messages: convertAssistantUiMessages(messages),
        };
      }
    ),
  };
});

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
    assistantDataStreamSessions: {
      create: vi.fn(() => ({
        createResponse: vi.fn(() => ({
          body: null,
          headers: new Headers(),
          status: 200,
        })),
        getTerminalOutcome: vi.fn(() => ({ error: null, status: 'completed' })),
        id: 'session-test',
        messageId: 'assistant-message-test',
        whenClosed: vi.fn(() => Promise.resolve()),
      })),
    },
    convertAssistantUiMessages,
    createEmbeddingProvider: vi.fn((provider: string, apiKey: string, model: string) => ({
      apiKey,
      model,
      provider,
      type: 'embedding-model',
    })),
    createLanguageModelProvider: vi.fn((provider: string, apiKey: string, model: string) => ({
      apiKey,
      model,
      provider,
    })),
    isSupportedProvider: (provider: string) =>
      ['openai', 'anthropic', 'google', 'openrouter', 'local', 'ollama'].includes(provider),
    listSuspendedMastraRuns: vi.fn(() => Promise.resolve({ approvals: [] })),
    resolveDataStreamSession: vi.fn(() => {}),
    sanitizeAssistantRunEventMetadata: vi.fn((metadata) => metadata),
    streamMastraToolApprovalAction: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'approval resumed' };
      },
    })),
    streamMastraToolResumeAction: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'suspend resumed' };
      },
    })),
    toAiSdkStyleStream: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { content: 'test', type: 'text' };
      },
    })),
  };
});

const mockDesktopDatabase = {
  exec: vi.fn(),
  query: vi.fn(),
};

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(() => Promise.resolve(mockDesktopDatabase)),
}));

vi.mock('../../assistant-server/assistant-tools', () => ({
  buildDesktopAssistantTools: vi.fn(() => ({})),
}));

vi.mock('../../assistant-server/workspace-text-file-reader', () => ({
  readWorkspaceTextFile: vi.fn(async () => ({ content: '', path: '', size: 0 })),
}));

const runRequest = createRunRequest(handleAssistantRequest);

beforeEach(() => {
  mockSecretsService.getCredential
    .mockReset()
    .mockResolvedValue({ key: 'test-api-key', type: 'api_key' });
  mockSecretsService.getKey.mockReset().mockResolvedValue('test-api-key');
  mockSecretsService.listProviders.mockReset().mockResolvedValue(['openai']);
  mockDesktopDatabase.query.mockReset().mockResolvedValue({ rows: [] });
  resetRunSteeringRegistry();
});

afterEach(() => {
  vi.clearAllMocks();
  resetRunSteeringRegistry();
});

describe('assistant stream serving', () => {
  it('should handle POST to assistant route with valid message', async () => {
    const loggerInfoSpy = vi
      .spyOn(desktopAssistantServerLogger, 'info')
      .mockImplementation(() => {});
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');

    // Make sure convertAssistantUiMessages actually returns messages
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);

    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });

    // Ensure streamResponse resolves immediately
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    const requestPromise = runRequest({
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    await vi.waitUntil(
      () =>
        loggerInfoSpy.mock.calls.some(
          ([message, payload]) =>
            message === 'Assistant request received' &&
            Boolean((payload as { hasApiKey?: boolean })?.hasApiKey)
        ),
      { timeout: 2000 }
    );

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      'Assistant request received',
      expect.objectContaining({ hasApiKey: true })
    );

    loggerInfoSpy.mockRestore();

    await Promise.race([requestPromise, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }, 15_000);

  it('keeps the assistant stream alive when a completed request emits close', async () => {
    const { convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    let observedSignal: AbortSignal | null | undefined;
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (streamResponse as Mock).mockImplementationOnce(
      async (
        res: http.ServerResponse,
        _response: unknown,
        signal: AbortSignal | null | undefined
      ) => {
        observedSignal = signal;
        await responseReleased;
        res.end('done');
      }
    );

    const req = new MockRequest({
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/assistant',
    });
    const res = new MockResponse();
    const finished = new Promise<void>((resolve) => res.once('finish', resolve));
    const requestPromise = handleAssistantRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      { auth: 'disabled' }
    );

    await vi.waitUntil(() => observedSignal !== undefined, { timeout: 2000 });
    Object.defineProperty(req, 'complete', { configurable: true, value: true });
    req.emit('close');
    releaseResponse?.();
    await requestPromise;
    await finished;

    expect(res.statusCode).toBe(200);
    expect(Buffer.concat(res.bodyChunks).toString('utf-8')).toBe('done');
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
  });

  it('detaches the response without aborting server-owned execution when the connection closes', async () => {
    const { convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    let observedSignal: AbortSignal | null | undefined;
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (streamResponse as Mock).mockImplementationOnce(
      async (
        res: http.ServerResponse,
        _response: unknown,
        signal: AbortSignal | null | undefined
      ) => {
        observedSignal = signal;
        await responseReleased;
        res.end();
      }
    );

    const req = new MockRequest({
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/assistant',
    });
    const res = new MockResponse();
    const finished = new Promise<void>((resolve) => res.once('finish', resolve));
    const requestPromise = handleAssistantRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      { auth: 'disabled' }
    );

    await vi.waitUntil(() => observedSignal !== undefined, { timeout: 2000 });
    res.emit('close');

    expect(observedSignal?.aborted).toBe(true);

    releaseResponse?.();
    await requestPromise;
    await finished;
  });

  it('publishes a replay cursor on the initial desktop assistant response', async () => {
    const { assistantDataStreamSessions } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    (streamResponse as Mock).mockImplementationOnce(async (res: http.ServerResponse) =>
      res.end('streamed')
    );

    const response = await runRequest({
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/assistant',
    });

    const session = (assistantDataStreamSessions.create as Mock).mock.results.at(-1)?.value;
    expect(response.status).toBe(200);
    expect(session.createResponse).toHaveBeenCalledWith({
      headers: {
        'X-Brainstrike-Assistant-Event-Id': 'session-test:-1',
        'X-Brainstrike-Assistant-Message-Id': 'assistant-message-test',
      },
    });
  });

  it('should return JSON 413 when the request body exceeds the default byte limit', async () => {
    const { streamResponse } = await import('../../assistant-server/http');
    const response = await runRequest({
      body: 'x'.repeat(DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES + 1),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/assistant',
    });

    expect(response.status).toBe(413);
    const data = JSON.parse(response.body) as { error: string; message: string };
    expect(data.error).toBe('request_body_too_large');
    expect(data.message).toBe(
      `Assistant request body exceeds ${DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES} bytes.`
    );
    expect(response.headers['connection']).toBe('close');
    expect(streamResponse).not.toHaveBeenCalled();
  }, 10_000);

  it('should accept an image-only user turn as a valid vision prompt', async () => {
    // The transport half of the vision acceptance (moved verbatim from the
    // monolith): the rejections suite keeps the fast unit signal
    // (result.ok === true), but only this end-to-end form proves an
    // attachment-only turn actually REACHES the stream.
    const { streamResponse } = await import('../../assistant-server/http');
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    const response = await runRequest({
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
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/assistant',
    });

    expect(response.status).toBe(200);
    expect(streamResponse).toHaveBeenCalledOnce();
  }, 10_000);

  it('a semantically rejected POST responds without ever constructing a stream', async () => {
    // The transport half of the rejection contract, asserted ONCE at this
    // boundary instead of 19 times through every rejection case (which now
    // prove the returned rejection directly in the pure suite): when
    // preparation rejects, handleAssistantPost responds and returns — the
    // stream pump is never reached. The empty prompt rejects DEEPEST in
    // preparation (after parse, conversion, and the credential read), so it is
    // the strongest single probe of that early return.
    const { streamResponse } = await import('../../assistant-server/http');
    const response = await runRequest({
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: '   ', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/assistant',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'empty_prompt' });
    expect(streamResponse).not.toHaveBeenCalled();
  });
});

describe('stream resume', () => {
  it('reattaches to a server-owned stream through the dedicated resume route', async () => {
    const { resolveDataStreamSession } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    const createResponse = vi.fn(() => ({
      body: null,
      headers: new Headers(),
      status: 200,
    }));
    (resolveDataStreamSession as Mock).mockReturnValueOnce({ createResponse });
    (streamResponse as Mock).mockImplementationOnce(async (res: http.ServerResponse) =>
      res.end('replayed')
    );

    const response = await runRequest({
      headers: { 'last-event-id': 'session-test:-1' },
      method: 'GET',
      url: '/assistant/resume',
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe('replayed');
    expect(createResponse).toHaveBeenCalledWith({
      resumeFromEventId: 'session-test:-1',
    });
    expect(streamResponse).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
  });

  it('rejects a resume request without a replay cursor', async () => {
    const response = await runRequest({
      method: 'GET',
      url: '/assistant/resume',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'missing_assistant_event_id',
    });
  });

  it('returns a typed missing-session response for an expired replay cursor', async () => {
    const response = await runRequest({
      headers: { 'last-event-id': 'expired:-1' },
      method: 'GET',
      url: '/assistant/resume',
    });

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'assistant_stream_unavailable',
    });
  });
});

describe('run control endpoints', () => {
  it('POST /assistant/cancel explicitly aborts an active server-owned run', async () => {
    const { registerSteerableRun } = await import('@brainstrike/assistant-service/steering');
    const controller = new AbortController();
    registerSteerableRun('run-cancel-1', controller);

    const accepted = await runRequest({
      body: JSON.stringify({ runId: 'run-cancel-1' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/assistant/cancel',
    });

    expect(accepted.status).toBe(200);
    expect(controller.signal.aborted).toBe(true);
    expect(JSON.parse(accepted.body)).toEqual({ accepted: true, runId: 'run-cancel-1' });
  });

  it('POST /assistant/steer flips a registered run control and 404s unknown runs (BST-588)', async () => {
    const { registerSteerableRun } = await import('@brainstrike/assistant-service/steering');
    const control = registerSteerableRun('run-steer-1');

    const accepted = await runRequest({
      body: JSON.stringify({ runId: 'run-steer-1' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/assistant/steer',
    });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({ accepted: true, runId: 'run-steer-1' });
    expect(control.stopRequested()).toBe(true);

    const missing = await runRequest({
      body: JSON.stringify({ runId: 'run-finished' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/assistant/steer',
    });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error).toBe('no_active_run');
  });

  it('POST /assistant/steer rejects malformed bodies with a visible 400 (BST-588)', async () => {
    for (const body of [
      'not json',
      JSON.stringify({ runId: 'x', sneaky: true }),
      JSON.stringify({ runId: '' }),
      JSON.stringify({ runId: 'y'.repeat(513) }),
      JSON.stringify([]),
    ]) {
      const response = await runRequest({
        body,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/assistant/steer',
      });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).error).toBe('invalid_steer_action');
    }
  });
});
