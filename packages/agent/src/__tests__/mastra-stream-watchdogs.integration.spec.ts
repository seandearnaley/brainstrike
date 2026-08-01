/**
 * BST-1047: elapsed-time watchdog behavior belongs in the uncached integration
 * lane. These cases retain the shared fake-Mastra stream harness because they
 * verify the production stream ordering, but their verdicts depend on real
 * timer progress and un-hashed CPU contention.
 *
 * See docs/agents/assistant-runtime.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { streamMastraAgent } from '../mastra/agent-streaming';
import {
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

describe('mastra streaming: wall-clock watchdog termination', () => {
  beforeEach(() => {
    resetMastraStreamHarness();
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
});
