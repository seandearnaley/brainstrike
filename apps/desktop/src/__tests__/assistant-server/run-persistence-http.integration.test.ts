import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { desktopAssistantServerLogger, handleAssistantRequest } from '../../assistant-server';
import { resetDesktopMastraMemoryCacheForTests } from '../../assistant-server/mastra-memory';
import { mockDesktopDatabase, mockSecretsService } from './_assistant-server-mocks';
import { createRunRequest } from './_harness';

// Mock dependencies: per-file vi.mock call sites (hoisting is
// per-importing-module) over the shared factory bodies + fixtures in
// _assistant-server-mocks.ts (BST-1029). The DYNAMIC import is LOAD-BEARING
// (both alternatives verified red): a bare imported factory reference is
// evaluated at hoist time, and even a lazy arrow over the STATIC import
// breaks because '../../assistant-server' initializes first in import order
// and triggers these factories before the mocks module's bindings exist. The
// dynamic import shares the same per-file module instance as the static
// fixture imports below.
// vi.hoisted lifts the accessor above the hoisted vi.mock calls; the dynamic
// import inside stays lazy.
const mocks = vi.hoisted(() => () => import('./_assistant-server-mocks'));
vi.mock('../../assistant-server/http', async () => (await mocks()).makeAssistantServerHttpMock());
vi.mock('../../mcp-loader', async () => (await mocks()).makeMcpLoaderMock());
vi.mock('../../agent-client-loader', async () => (await mocks()).makeAgentClientLoaderMock());
vi.mock('../../secrets', async () => (await mocks()).makeSecretsMock());
vi.mock('@brainstrike/agent/hosted-web', async () => (await mocks()).makeHostedWebAgentMock());
vi.mock('@brainstrike/agent', async () => (await mocks()).makeAgentMock());
vi.mock('@brainstrike/agent/pglite-mastra-memory', async () =>
  (await mocks()).makePgliteMastraMemoryMock()
);
vi.mock('../../assistant-server/assistant-tools', async () =>
  (await mocks()).makeAssistantToolsMock()
);
vi.mock('../../assistant-server/workspace-text-file-reader', async () =>
  (await mocks()).makeWorkspaceTextFileReaderMock()
);
vi.mock('../../db-main', async () => (await mocks()).makeDbMainMock());

const runRequest = createRunRequest(handleAssistantRequest);

beforeEach(() => {
  mockDesktopDatabase.exec.mockReset();
  mockDesktopDatabase.query.mockReset();
  // Default: workspace-roots enrichment (runs first on every assistant
  // stream init) sees no roots and cleanly falls back. Tests that exercise
  // other queries override this.
  mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
  resetDesktopMastraMemoryCacheForTests();
  mockSecretsService.getCredential
    .mockReset()
    .mockResolvedValue({ key: 'test-api-key', type: 'api_key' });
  mockSecretsService.getKey.mockReset().mockResolvedValue('test-api-key');
  mockSecretsService.listProviders.mockReset().mockResolvedValue(['openai']);
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
});

afterEach(() => {
  vi.clearAllMocks();
  // Restores vi.spyOn spies only (never the vi.mock factory mocks): the four
  // logger.error spies in this file would otherwise stack no-ops file-wide,
  // since clearAllMocks clears calls but leaves installed stubs in place.
  vi.restoreAllMocks();
  resetDesktopMastraMemoryCacheForTests();
}, 15_000);
describe('run persistence through the HTTP path', () => {
  it('marks assistant thread runs completed after desktop streams finish', async () => {
    const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            runId: 'run-1',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [
          {
            id: 'user-client-id',
            parts: [{ text: 'Hello', type: 'text' }],
            role: 'user',
          },
        ],
        unstable_assistantMessageId: 'assistant-client-id',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE brainstrike_assistant_thread_runs'),
      expect.arrayContaining(['run-1', 'completed', null])
    );
    expect(toAiSdkStyleStream).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ assistantMessageId: 'assistant-client-id' }),
      expect.any(Object)
    );
    const [, , streamOptions] = (toAiSdkStyleStream as Mock).mock.calls[0] as [
      unknown,
      unknown,
      {
        toolOutputArtifactInlineMaxSerializedCharsByToolName?: ReadonlyMap<string, number>;
        toolOutputArtifactStore?: {
          store: (input: {
            content: string;
            format: 'text';
            toolCallId: string;
          }) => Promise<unknown>;
        };
      },
    ];
    expect(streamOptions.toolOutputArtifactStore).toBeDefined();
    expect(
      streamOptions.toolOutputArtifactInlineMaxSerializedCharsByToolName?.get(
        'brainstrike.webExtract'
      )
    ).toBe(2400);
    mockDesktopDatabase.query.mockResolvedValueOnce({
      rows: [
        {
          byteLength: 8,
          expiresAt: '2026-07-27T12:00:00.000Z',
          format: 'text',
          id: '019f7d67-7165-7c23-8e99-d70c2a2f168d',
        },
      ],
    });
    await expect(
      streamOptions.toolOutputArtifactStore?.store({
        content: 'complete',
        format: 'text',
        toolCallId: 'call-artifact-1',
      })
    ).resolves.toMatchObject({
      byteLength: 8,
      format: 'text',
    });
    expect(mockDesktopDatabase.query).toHaveBeenLastCalledWith(
      expect.stringContaining('brainstrike_assistant_tool_output_artifacts'),
      expect.arrayContaining(['workspace-a', 'thread-1', 'run-1', 'call-artifact-1', 'text'])
    );
    expect(convertAssistantUiMessages).toHaveBeenCalledWith([
      {
        id: 'user-client-id',
        parts: [{ text: 'Hello', type: 'text' }],
        role: 'user',
      },
    ]);
    expect(assistantDataStreamSessions.create).toHaveBeenCalledWith(expect.any(Object), {
      messageId: 'assistant-client-id',
    });
  });

  it('persists a model output-limit terminal outcome as failed', async () => {
    const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    const terminalError =
      'Assistant stopped because the model reached its output token limit before completing the response.';

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Finish the task', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          finishReason: 'length',
          path: [],
          type: 'message-finish',
          usage: { completionTokens: 32_000, promptTokens: 100 },
        };
      },
    });
    (assistantDataStreamSessions.create as Mock).mockReturnValueOnce({
      createResponse: vi.fn(() => ({
        body: null,
        headers: new Headers(),
        status: 200,
      })),
      getTerminalOutcome: vi.fn(() => ({ error: terminalError, status: 'failed' })),
      whenClosed: vi.fn(() => Promise.resolve()),
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            runId: 'run-output-limit',
            threadId: 'thread-1',
          },
          provider: 'openrouter',
        },
        messages: [{ parts: [{ text: 'Finish the task', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE brainstrike_assistant_thread_runs'),
      expect.arrayContaining(['run-output-limit', 'failed', terminalError])
    );
  });

  it('persists run-event chunks while desktop streams are consumed', async () => {
    const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    let capturedStream: AsyncIterable<unknown> | null = null;

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          event: {
            id: 'event-1',
            kind: 'run.started',
            label: 'Assistant run started',
            sequence: 5,
            status: 'running',
            timestamp: '2026-04-24T10:00:00.000Z',
          },
          type: 'run-event',
        };
        yield {
          event: {
            id: 'event-2',
            kind: 'run.step.started',
            label: 'Step started',
            status: 'running',
            timestamp: '2026-04-24T10:00:01.000Z',
          },
          type: 'run-event',
        };
        yield {
          event: {
            id: 'event-3',
            kind: 'tool.completed',
            label: 'Tool completed',
            metadata: {
              toolCallId: 'call-1',
              toolName: 'brainstrike.queryEmbeddingSpace',
            },
            status: 'completed',
            timestamp: '2026-04-24T10:00:02.000Z',
          },
          type: 'run-event',
        };
        yield { type: 'text-delta', value: 'Response' };
      },
    });
    (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
      (stream: AsyncIterable<unknown>) => {
        capturedStream = stream;
        return {
          createResponse: vi.fn(() => ({
            body: null,
            headers: new Headers(),
            status: 200,
          })),
          getTerminalOutcome: vi.fn(() => ({ error: null, status: 'completed' })),
          whenClosed: vi.fn(() => Promise.resolve()),
        };
      }
    );
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      if (!capturedStream) {
        throw new Error('Expected stream to be captured.');
      }
      for await (const _chunk of capturedStream) {
        // consume stream to trigger run-event persistence
      }
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            runId: 'run-1',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO brainstrike_assistant_run_events'),
      expect.arrayContaining(['event-1', 'run-1', 5, 'run.started', 'running'])
    );
    expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO brainstrike_assistant_run_events'),
      expect.arrayContaining(['event-2', 'run-1', 6, 'run.step.started', 'running'])
    );
    expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO brainstrike_assistant_run_events'),
      expect.arrayContaining(['event-3', 'run-1', 7, 'tool.completed', 'completed'])
    );
  });

  it('persists structured provider forensics from a failed run event', async () => {
    const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    let capturedStream: AsyncIterable<unknown> | null = null;

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    mockDesktopDatabase.query.mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO brainstrike_assistant_run_errors')) {
        return Promise.resolve({
          rows: [
            {
              cause_chain: ['APICallError: Rate limited'],
              code: 'mastra_agent_stream_provider_error',
              http_status: 429,
              message: 'Rate limited',
              occurred_at: '2026-07-26T19:00:00.000Z',
              provider_request_id: 'req-safe-123',
              resource_id: 'workspace-a',
              response_headers: {
                'retry-after': '3',
                'x-request-id': 'req-safe-123',
              },
              run_id: 'run-provider-failure',
              thread_id: 'thread-1',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          event: {
            detail: 'The provider rejected the request.',
            id: 'event-provider-failure',
            kind: 'run.failed',
            label: 'Assistant run failed',
            metadata: {
              runError: {
                causeChain: ['APICallError: Rate limited'],
                code: 'mastra_agent_stream_provider_error',
                httpStatus: 429,
                message: 'Rate limited',
                providerRequestId: 'req-safe-123',
                responseHeaders: {
                  'retry-after': '3',
                  'x-request-id': 'req-safe-123',
                },
              },
            },
            status: 'failed',
            timestamp: '2026-07-26T19:00:00.000Z',
          },
          type: 'run-event',
        };
      },
    });
    (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
      (stream: AsyncIterable<unknown>) => {
        capturedStream = stream;
        return {
          createResponse: vi.fn(() => ({
            body: null,
            headers: new Headers(),
            status: 200,
          })),
          getTerminalOutcome: vi.fn(() => ({
            error: 'The provider rejected the request.',
            status: 'failed',
          })),
          whenClosed: vi.fn(() => Promise.resolve()),
        };
      }
    );
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      if (!capturedStream) {
        throw new Error('Expected stream to be captured.');
      }
      for await (const _chunk of capturedStream) {
        // consume stream to trigger run-event and run-error persistence
      }
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            runId: 'run-provider-failure',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO brainstrike_assistant_run_errors'),
      expect.arrayContaining([
        'run-provider-failure',
        'mastra_agent_stream_provider_error',
        'Rate limited',
        429,
        'req-safe-123',
      ])
    );
  });

  it('logs missing-parent provider forensics without replacing the provider failure stream', async () => {
    const loggerErrorSpy = vi
      .spyOn(desktopAssistantServerLogger, 'error')
      .mockImplementation(() => {});
    const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    let capturedStream: AsyncIterable<unknown> | null = null;

    mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          event: {
            detail: 'The provider rejected the request.',
            id: 'event-provider-missing-parent',
            kind: 'run.failed',
            label: 'Assistant run failed',
            metadata: {
              runError: {
                code: 'mastra_agent_stream_provider_error',
                httpStatus: 503,
                message: 'The provider rejected the request.',
              },
            },
            status: 'failed',
            timestamp: '2026-07-26T19:00:00.000Z',
          },
          type: 'run-event',
        };
      },
    });
    (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
      (stream: AsyncIterable<unknown>) => {
        capturedStream = stream;
        return {
          createResponse: vi.fn(() => ({
            body: null,
            headers: new Headers(),
            status: 200,
          })),
          getTerminalOutcome: vi.fn(() => ({
            error: 'The provider rejected the request.',
            status: 'failed',
          })),
          whenClosed: vi.fn(() => Promise.resolve()),
        };
      }
    );
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      if (!capturedStream) {
        throw new Error('Expected stream to be captured.');
      }
      for await (const _chunk of capturedStream) {
        // Drain the original provider-failure stream.
      }
      const response = res as { end?: () => void };
      response.end?.();
    });

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            runId: 'run-provider-missing-parent',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(200);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Failed to persist assistant provider failure forensics',
      expect.objectContaining({
        eventId: 'event-provider-missing-parent',
        runId: 'run-provider-missing-parent',
      })
    );
  });

  it('streams run-event chunks before desktop persistence settles', async () => {
    const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    let capturedStream: AsyncIterable<unknown> | null = null;
    let resolveInsert: (() => void) | undefined;
    let insertSettled = false;
    let eventYieldedBeforeInsertSettled = false;

    mockDesktopDatabase.query.mockImplementation(((sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO brainstrike_assistant_run_events')) {
        return new Promise<void>((resolve) => {
          resolveInsert = () => {
            insertSettled = true;
            resolve();
          };
        });
      }
      return Promise.resolve({ rows: [] });
    }) as unknown as (...args: unknown[]) => Promise<{ rows: unknown[] }>);
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          event: {
            id: 'event-nonblocking',
            kind: 'run.started',
            label: 'Assistant run started',
            status: 'running',
            timestamp: '2026-04-24T10:00:00.000Z',
          },
          type: 'run-event',
        };
      },
    });
    (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
      (stream: AsyncIterable<unknown>) => {
        capturedStream = stream;
        return {
          createResponse: vi.fn(() => ({
            body: null,
            headers: new Headers(),
            status: 200,
          })),
          getTerminalOutcome: vi.fn(() => ({ error: null, status: 'completed' })),
          whenClosed: vi.fn(() => Promise.resolve()),
        };
      }
    );
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      if (!capturedStream) {
        throw new Error('Expected stream to be captured.');
      }
      for await (const chunk of capturedStream) {
        if (
          typeof chunk === 'object' &&
          chunk !== null &&
          'type' in chunk &&
          chunk.type === 'run-event'
        ) {
          eventYieldedBeforeInsertSettled = !insertSettled;
          resolveInsert?.();
        }
      }
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            runId: 'run-1',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(eventYieldedBeforeInsertSettled).toBe(true);
  });

  it('logs suppressed run-event persistence failures before failing the run', async () => {
    const loggerErrorSpy = vi
      .spyOn(desktopAssistantServerLogger, 'error')
      .mockImplementation(() => {});
    const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    let capturedStream: AsyncIterable<unknown> | null = null;
    let insertAttempt = 0;

    mockDesktopDatabase.query.mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO brainstrike_assistant_run_events')) {
        insertAttempt += 1;
        return Promise.reject(new Error(`insert failed ${insertAttempt}`));
      }
      return Promise.resolve({ rows: [] });
    });
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          event: {
            id: 'event-failure-1',
            kind: 'run.started',
            label: 'Assistant run started',
            status: 'running',
            timestamp: '2026-04-24T10:00:00.000Z',
          },
          type: 'run-event',
        };
        yield {
          event: {
            id: 'event-failure-2',
            kind: 'run.step.started',
            label: 'Step started',
            status: 'running',
            timestamp: '2026-04-24T10:00:01.000Z',
          },
          type: 'run-event',
        };
      },
    });
    (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
      (stream: AsyncIterable<unknown>) => {
        capturedStream = stream;
        return {
          createResponse: vi.fn(() => ({
            body: null,
            headers: new Headers(),
            status: 200,
          })),
          getTerminalOutcome: vi.fn(() => ({ error: null, status: 'completed' })),
          whenClosed: vi.fn(() => Promise.resolve()),
        };
      }
    );
    (streamResponse as Mock).mockImplementationOnce(async () => {
      if (!capturedStream) {
        throw new Error('Expected stream to be captured.');
      }
      for await (const _chunk of capturedStream) {
        // consume stream to trigger run-event persistence
      }
    });

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            runId: 'run-persistence-failed',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(500);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Multiple assistant run events failed to persist',
      expect.objectContaining({
        failureCount: 2,
        runId: 'run-persistence-failed',
        suppressedFailureCount: 1,
      })
    );
  });

  it('flushes run-event persistence failures when the source stream throws', async () => {
    const loggerErrorSpy = vi
      .spyOn(desktopAssistantServerLogger, 'error')
      .mockImplementation(() => {});
    const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    let capturedStream: AsyncIterable<unknown> | null = null;

    mockDesktopDatabase.query.mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO brainstrike_assistant_run_events')) {
        return Promise.reject(new Error('insert failed before stream error'));
      }
      return Promise.resolve({ rows: [] });
    });
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          event: {
            id: 'event-before-source-error',
            kind: 'run.started',
            label: 'Assistant run started',
            status: 'running',
            timestamp: '2026-04-24T10:00:00.000Z',
          },
          type: 'run-event',
        };
        throw new Error('agent stream failed');
      },
    });
    (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
      (stream: AsyncIterable<unknown>) => {
        capturedStream = stream;
        return {
          createResponse: vi.fn(() => ({
            body: null,
            headers: new Headers(),
            status: 200,
          })),
          getTerminalOutcome: vi.fn(() => ({ error: null, status: 'completed' })),
          whenClosed: vi.fn(() => Promise.resolve()),
        };
      }
    );
    (streamResponse as Mock).mockImplementationOnce(async () => {
      if (!capturedStream) {
        throw new Error('Expected stream to be captured.');
      }
      for await (const _chunk of capturedStream) {
        // consume stream until source error
      }
    });

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            runId: 'run-source-error',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(500);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Failed to flush assistant run event persistence after stream error',
      expect.objectContaining({
        runId: 'run-source-error',
        sourceError: expect.any(Error),
      })
    );
    expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE brainstrike_assistant_thread_runs'),
      expect.arrayContaining(['run-source-error', 'failed', 'agent stream failed'])
    );
  });

  it('marks assistant thread runs failed when response streaming fails', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockRejectedValueOnce(new Error('stream pipeline failed'));

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            runId: 'run-failed',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(500);
    expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE brainstrike_assistant_thread_runs'),
      expect.arrayContaining(['run-failed', 'failed', 'stream pipeline failed'])
    );
  });

  it('preserves the stream error when failing to mark an assistant thread run failed', async () => {
    const loggerErrorSpy = vi
      .spyOn(desktopAssistantServerLogger, 'error')
      .mockImplementation(() => {});
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockRejectedValueOnce(new Error('stream pipeline failed'));
    // Roots enrichment queries first and must succeed; only the run-status
    // write should fail (SQL-aware so the rejection targets the right query).
    mockDesktopDatabase.query.mockImplementation((sql: unknown) =>
      typeof sql === 'string' && sql.includes('FROM roots')
        ? Promise.resolve({ rows: [] })
        : Promise.reject(new Error('run status write failed'))
    );

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            runId: 'run-failed-status-write',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(500);
    const data = JSON.parse(response.body) as { error: string; message: string };
    expect(data).toEqual({
      error: 'assistant_stream_failed',
      message: 'Assistant stream failed.',
    });
    expect(response.body).not.toContain('stream pipeline failed');
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Failed to update assistant thread run status',
      expect.objectContaining({
        runId: 'run-failed-status-write',
        status: 'failed',
      })
    );

    loggerErrorSpy.mockRestore();
  });
});
