/**
 * BST-988: how a run ENDS — the abnormal endings owned by
 * `mastra/stream-termination.ts` (BST-986) plus the finish-reason terminal
 * policy that decides `run.finished` vs `run.failed`.
 *
 * The termination module covers provider-error, tripwire, and watchdog
 * (stall / tool-call-input) endings: flush pending tool-output run-events, emit
 * the reason as visible text, emit `run.failed` carrying that reason as its
 * durable `detail`, then an ERROR finish — never a throw.
 *
 * The finish-reason cases (`length` / absent / `unknown` / unrecognized) are
 * here DELIBERATELY even though the decision itself is split across
 * `agent-streaming.ts` and `makeFinishChunk` in `tool-lifecycle-processors.ts`:
 * they answer the same question — does this run reach the timeline as completed
 * or failed — and separating them would scatter one policy over three files.
 *
 * Every test here was MOVED unchanged from `mastra-streaming.spec.ts`.
 *
 * See docs/agents/assistant-runtime.md.
 */
import { logRecordToDiagnosticEvent } from '@brainstrike/utils/diagnostics';
import { addLogListener, type LogRecord } from '@brainstrike/utils/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { streamMastraAgent } from '../mastra/agent-streaming';
import {
  expectLeadingContextBreakdown,
  resetMastraStreamHarness,
  setMockStreamParts,
  setStreamPartDelayMs,
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

  it('puts durable run, thread, resource, and root correlation in provider-error diagnostic context', async () => {
    setMockStreamParts([{ error: { message: 'upstream failed', statusCode: 503 }, type: 'error' }]);
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'user-correlated-error', parts: [{ text: 'hi' }], role: 'user' }],
        {
          memory: { id: 'memory-instance' } as never,
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
          memory: { id: 'memory-instance' } as never,
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

  it('terminates an incomplete streamed tool input even while argument deltas continue', async () => {
    const previousToolTimeout = process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'];
    const previousStreamInactivity = process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'];
    const previousToolCallInput = process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'];
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '10';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '35';
    process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'] = '35';
    setStreamPartDelayMs(5);
    setMockStreamParts([
      {
        payload: { toolCallId: 'call-stuck-input' },
        type: 'tool-call-input-streaming-start',
      },
      ...Array.from({ length: 20 }, () => ({
        payload: { argsTextDelta: 'x', toolCallId: 'call-stuck-input' },
        type: 'tool-call-delta',
      })),
      {
        payload: { toolCallId: 'call-stuck-input' },
        type: 'tool-call-input-streaming-end',
      },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u-stuck-input', parts: [{ text: 'write a file', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );
      const chunks = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      expect(JSON.stringify(chunks)).toContain('tool_call_input_streaming_timeout');
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: 'text-delta',
          value: expect.stringMatching(/tool call.*arguments.*35ms/i),
        })
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            // `detail` carries the SPECIFIC reason. The label is the same
            // generic "Assistant run failed" for every termination, and the
            // mapper derives `thread_runs.error` from this event — so without a
            // detail here a failed run persists a signal-free string. Pinned
            // end-to-end because the mapper's own tests build this event by
            // hand and would stay green if the helper stopped populating it.
            detail: expect.stringMatching(/arguments within 35ms/i),
            kind: 'run.failed',
            metadata: expect.objectContaining({
              code: 'tool_call_input_streaming_timeout',
              toolCallId: 'call-stuck-input',
            }),
          }),
          type: 'run-event',
        })
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({ finishReason: 'error', type: 'message-finish' })
      );
    } finally {
      setStreamPartDelayMs(0);
      if (previousToolTimeout === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_TOOL_TIMEOUT_MS');
      } else {
        process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = previousToolTimeout;
      }
      if (previousStreamInactivity === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_INACTIVITY_MS');
      } else {
        process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = previousStreamInactivity;
      }
      if (previousToolCallInput === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_TOOL_CALL_INPUT_MS');
      } else {
        process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'] = previousToolCallInput;
      }
    }
  });

  it('lets a long streamed tool input finish past the inactivity window (BST-839)', async () => {
    // A large file write streams argument deltas continuously for far longer
    // than the inactivity window. Deltas keep the transport demonstrably alive,
    // so the wider tool-call-input budget must govern — not the inactivity one.
    const previousToolTimeout = process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'];
    const previousStreamInactivity = process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'];
    const previousToolCallInput = process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'];
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '10';
    // This test asserts a NEGATIVE (no timeout), so slowness can only break it
    // — the opposite direction from the timeout test above. Scaled for ~10x
    // per-gap headroom against the inactivity watchdog: 20 deltas x 20ms is
    // ~400ms of streaming, which still exceeds the 200ms window that the old
    // coupled behaviour would have applied, so the regression proof holds.
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '200';
    process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'] = '5000';
    setStreamPartDelayMs(20);
    setMockStreamParts([
      {
        payload: { toolCallId: 'call-long-input' },
        type: 'tool-call-input-streaming-start',
      },
      ...Array.from({ length: 20 }, () => ({
        payload: { argsTextDelta: 'x', toolCallId: 'call-long-input' },
        type: 'tool-call-delta',
      })),
      {
        payload: { toolCallId: 'call-long-input' },
        type: 'tool-call-input-streaming-end',
      },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u-long-input', parts: [{ text: 'write a big file', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );
      const chunks = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      expect(JSON.stringify(chunks)).not.toContain('tool_call_input_streaming_timeout');
      expect(chunks).toContainEqual(
        expect.objectContaining({ finishReason: 'stop', type: 'message-finish' })
      );
    } finally {
      setStreamPartDelayMs(0);
      if (previousToolTimeout === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_TOOL_TIMEOUT_MS');
      } else {
        process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = previousToolTimeout;
      }
      if (previousStreamInactivity === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_INACTIVITY_MS');
      } else {
        process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = previousStreamInactivity;
      }
      if (previousToolCallInput === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_TOOL_CALL_INPUT_MS');
      } else {
        process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'] = previousToolCallInput;
      }
    }
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
    setMockStreamParts([{ type: 'finish', usage: { completionTokens: 5, promptTokens: 3 } }]);

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
