/**
 * BST-988: how a run ENDS — the abnormal endings owned by
 * `mastra/stream-termination.ts` (BST-986) plus the finish-reason terminal
 * policy that decides `run.finished` vs `run.failed`.
 *
 * The termination module covers provider-error and tripwire endings: flush
 * pending tool-output run-events, emit the reason as visible text, emit
 * `run.failed` carrying that reason as its durable `detail`, then an ERROR
 * finish — never a throw.
 *
 * The finish-reason cases (`length` / absent / `unknown` / unrecognized) are
 * here DELIBERATELY even though the decision itself is split across
 * `agent-streaming.ts` and `makeFinishChunk` in `tool-lifecycle-processors.ts`:
 * they answer the same question — does this run reach the timeline as completed
 * or failed — and separating them would scatter one policy over three files.
 *
 * The wall-clock watchdog cases live in
 * `mastra-stream-watchdogs.integration.spec.ts`; every remaining test here was
 * MOVED unchanged from `mastra-streaming.spec.ts`.
 *
 * See docs/agents/assistant-runtime.md.
 */

import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { logRecordToDiagnosticEvent } from '@brainstrike/utils/diagnostics';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { streamMastraAgent } from '../mastra/agent-streaming';
import {
  expectLeadingContextBreakdown,
  resetMastraStreamHarness,
  setMockStreamParts,
} from './fixtures/mastra-stream-harness';

vi.mock(
  '@ai-sdk/openai',
  async () => (await import('./fixtures/mastra-stream-harness')).openAiSdkMock
);

vi.mock(
  '@ai-sdk/anthropic',
  async () => (await import('./fixtures/mastra-stream-harness')).anthropicSdkMock
);

vi.mock(
  '@ai-sdk/google',
  async () => (await import('./fixtures/mastra-stream-harness')).googleSdkMock
);

vi.mock(
  '@mastra/core/agent',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraAgentModuleMock
);

vi.mock(
  '@mastra/core/mastra',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraCoreModuleMock
);

vi.mock(
  '../mcp/explicit-stdio-client',
  async () => (await import('./fixtures/mastra-stream-harness')).explicitStdioMcpClientModuleMock
);

describe('mastra streaming: termination and finish-reason policy', () => {
  beforeEach(() => {
    resetMastraStreamHarness();
  });

  it('applies deterministic context-overflow recovery before surfacing the terminal retry message', async () => {
    const recover = vi.fn(async () => ({ applied: true }));
    setMockStreamParts([
      {
        error: { code: 'context_length_exceeded', message: 'context window exceeded' },
        type: 'error',
      },
    ]);
    const iterator = await streamMastraAgent(
      [{ id: 'user-overflow', parts: [{ text: 'continue' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          contextOverflowRecovery: recover,
          provider: 'openai',
        },
      }
    );
    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(recover).toHaveBeenCalledOnce();
    expect(JSON.stringify(chunks)).toContain('deterministic compaction');
    expect(JSON.stringify(chunks)).toContain('resend');
  });

  it('puts durable run, thread, resource, and root correlation in provider-error diagnostic context', async () => {
    setMockStreamParts([{ error: { message: 'upstream failed', statusCode: 503 }, type: 'error' }]);
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'user-correlated-error', parts: [{ text: 'hi' }], role: 'user' }],
        {
          memory: {
            getMergedThreadConfig: (config?: object) => config ?? {},
            id: 'memory-instance',
          } as never,
          runtime: {
            apiKey: 'test-key',
            boundWorkspaceRootId: 'root-a',
            memory: {
              resourceId: 'resource-a',
              runId: 'run-a',
              threadId: 'thread-a',
            },
            provider: 'openai',
          },
        }
      );
      for await (const _chunk of iterator) {
        // Drain the provider-error termination.
      }
    } finally {
      removeLogListener();
    }

    const providerErrorLog = logRecords.find((record) =>
      record.args.some(
        (arg) =>
          typeof arg === 'object' &&
          arg !== null &&
          (arg as { code?: unknown }).code === 'mastra_agent_stream_provider_error:503'
      )
    );
    expect(providerErrorLog).toBeDefined();
    if (!providerErrorLog) {
      throw new Error('Expected the provider-error diagnostic log.');
    }

    const event = logRecordToDiagnosticEvent(providerErrorLog, {
      appVersion: 'test',
      makeId: () => 'diagnostic-a',
      platform: 'test',
      sessionId: 'session-a',
      source: 'electron-main',
    });
    expect(event).toMatchObject({
      code: 'mastra_agent_stream_provider_error:503',
      resourceId: 'resource-a',
      rootId: 'root-a',
      runId: 'run-a',
      threadId: 'thread-a',
    });
    expect(providerErrorLog.bindings).not.toMatchObject({
      resourceId: 'resource-a',
      rootId: 'root-a',
      runId: 'run-a',
      threadId: 'thread-a',
    });
  });

  it('logs bounded, sanitized Mastra 1.51 tripwire diagnostics with durable correlation', async () => {
    setMockStreamParts([
      {
        payload: {
          metadata: {
            apiKey: 'must-not-reach-diagnostics',
            category: 'copyright',
            score: 0.98,
          },
          processorId: 'regex-filter',
          reason: 'Content policy violation',
          retry: false,
        },
        type: 'tripwire',
      },
    ]);
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'user-correlated-tripwire', parts: [{ text: 'hi' }], role: 'user' }],
        {
          memory: {
            getMergedThreadConfig: (config?: object) => config ?? {},
            id: 'memory-instance',
          } as never,
          runtime: {
            apiKey: 'test-key',
            boundWorkspaceRootId: 'root-a',
            memory: {
              resourceId: 'resource-a',
              runId: 'run-a',
              threadId: 'thread-a',
            },
            provider: 'openai',
          },
        }
      );
      for await (const _chunk of iterator) {
        // Drain the tripwire termination.
      }
    } finally {
      removeLogListener();
    }

    const tripwireLog = logRecords.find((record) =>
      record.args.some(
        (arg) =>
          typeof arg === 'object' &&
          arg !== null &&
          (arg as { code?: unknown }).code === 'mastra_agent_stream_tripwire'
      )
    );
    expect(tripwireLog).toBeDefined();
    if (!tripwireLog) {
      throw new Error('Expected the tripwire diagnostic log.');
    }

    const diagnosticFields = tripwireLog.args.find(
      (arg): arg is Record<string, unknown> =>
        typeof arg === 'object' &&
        arg !== null &&
        (arg as { code?: unknown }).code === 'mastra_agent_stream_tripwire'
    );
    expect(diagnosticFields).toMatchObject({
      code: 'mastra_agent_stream_tripwire',
      detail: 'Content policy violation',
      resourceId: 'resource-a',
      rootId: 'root-a',
      runId: 'run-a',
      threadId: 'thread-a',
      tripwire: {
        metadata: {
          category: 'copyright',
          score: 0.98,
        },
        processorId: 'regex-filter',
        retry: false,
        source: 'mastra-1.51',
      },
    });
    expect(JSON.stringify(diagnosticFields)).not.toContain('must-not-reach-diagnostics');
  });

  it('reports output-token exhaustion as a failed run instead of completed', async () => {
    setMockStreamParts([
      {
        payload: {
          output: { usage: { completionTokens: 4, inputTokens: 20 } },
          stepResult: { reason: 'length' },
        },
        type: 'finish',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'write a long answer', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'run.failed',
          metadata: expect.objectContaining({ finishReason: 'length' }),
          status: 'failed',
        }),
        type: 'run-event',
      })
    );
    expect(chunks).not.toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'run.finished' }),
        type: 'run-event',
      })
    );
    expect(chunks).toContainEqual({
      finishReason: 'length',
      path: [],
      type: 'message-finish',
      usage: {
        completionTokens: 4,
        contextInputTokens: 20,
        contextOutputTokens: 4,
        promptTokens: 20,
      },
    });
  });

  it('marks finish chunks without an explicit reason as absent and completes the run', async () => {
    setMockStreamParts([
      { textDelta: 'reasonless answer', type: 'text-delta' },
      { type: 'finish', usage: { completionTokens: 5, promptTokens: 3 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'finish without reason', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'run.finished',
          metadata: expect.objectContaining({ finishReason: 'absent' }),
          status: 'completed',
        }),
        type: 'run-event',
      })
    );
    expect(chunks).toContainEqual({
      finishReason: 'absent',
      path: [],
      type: 'message-finish',
      usage: {
        completionTokens: 5,
        contextInputTokens: 3,
        contextOutputTokens: 5,
        promptTokens: 3,
      },
    });
  });

  it('keeps the AI SDK unknown sentinel completed because it includes provider absence', async () => {
    setMockStreamParts([
      { textDelta: 'sdk-unknown answer', type: 'text-delta' },
      {
        finishReason: 'unknown',
        type: 'finish',
        usage: { completionTokens: 5, promptTokens: 3 },
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'finish with SDK unknown', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'run.finished',
          metadata: expect.objectContaining({ finishReason: 'unknown' }),
          status: 'completed',
        }),
        type: 'run-event',
      })
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({ finishReason: 'unknown', type: 'message-finish' })
    );
  });

  it('normalizes an unrecognized non-empty finish reason to a failing sentinel', async () => {
    setMockStreamParts([
      {
        finishReason: 'future-provider-reason',
        type: 'finish',
        usage: { completionTokens: 5, promptTokens: 3 },
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'finish with unknown reason', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'run.failed',
          metadata: expect.objectContaining({ finishReason: 'unrecognized' }),
          status: 'failed',
        }),
        type: 'run-event',
      })
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({ finishReason: 'unrecognized', type: 'message-finish' })
    );
  });

  it('throws a typed error when Mastra closes after tool activity without a terminal finish', async () => {
    setMockStreamParts([
      {
        args: { query: 'database config' },
        toolCallId: 'call-context',
        toolName: 'brainstrike.queryEmbeddingSpace',
        type: 'tool-call',
      },
      {
        result: { context: 'database config result' },
        toolCallId: 'call-context',
        toolName: 'brainstrike.queryEmbeddingSpace',
        type: 'tool-result',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'find database config', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      expect.objectContaining({
        name: 'brainstrike.queryEmbeddingSpace',
        status: 'start',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool.started',
          status: 'running',
        }),
        type: 'run-event',
      }),
      expect.objectContaining({
        name: 'brainstrike.queryEmbeddingSpace',
        status: 'success',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool.completed',
          status: 'completed',
        }),
        type: 'run-event',
      }),
      expect.objectContaining({
        finishReason: 'other',
        type: 'message-finish',
      }),
    ]);
  });
});
