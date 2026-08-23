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
  findRunEventChunks,
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

/**
 * Restore one env var to its pre-test value, deleting it when it was unset.
 *
 * These cases drive the REAL resilience-config resolver, which reads
 * `process.env` at stream start, so a leaked variable silently reconfigures
 * every later case in the file.
 */
function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = previous;
}

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
  it('tolerates a slow first output, then reports the streaming stall with its breadcrumb', async () => {
    // BST-1408, both halves in one case.
    //
    // POSITIVE half: the first output arrives far later than the inter-output
    // window allows. Under the old single-window watchdog that alone killed the
    // turn; a reasoning request routinely spends minutes there.
    //
    // NEGATIVE half: once the ANSWER is flowing, the tighter inter-output window
    // governs, and the resulting `run.failed` must name WHICH silence fired,
    // what the provider last sent, and how far the stream got. The 2026-08-22
    // incident had to be reconstructed by inference for want of exactly that.
    //
    // The answering part here is a `text-delta`, NOT a `reasoning-delta`. This
    // case used to use the latter, which encoded the very bug that killed
    // google/gemini-3.7-flash: a reasoning delta says the model is thinking,
    // so it now opens the wide `reasoning` window instead of the tight one.
    // The sibling case below covers that direction.
    //
    // NOTE: this harness feeds a hand-written part list with NO framework
    // prologue, so `step-start` here stands in for provider output. The
    // prologue's real effect on the phase boundary is covered by
    // mastra-stream-first-output.integration.spec.ts, which drives the real
    // Mastra loop — the mocked harness structurally cannot see it.
    const previousToolTimeout = process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'];
    const previousStreamInactivity = process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'];
    const previousFirstOutput = process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'];
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '10';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '30';
    // ~33x headroom on the half that asserts a NEGATIVE (the first output must
    // NOT trip), because only slowness can break that direction. The stall half
    // asserts a POSITIVE, which host contention can only make more certain.
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '2000';
    setStreamPartDelayMs(60);
    setMockStreamParts([
      { type: 'step-start' },
      { payload: { text: 'answering' }, type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u-slow-start', parts: [{ text: 'think hard', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );
      const chunks = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      const failures = findRunEventChunks(chunks, 'run.failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]?.event.metadata).toEqual(
        expect.objectContaining({
          code: 'stream_inactivity_timeout',
          inactivityMs: 30,
          // `step-start` is scaffolding, so the wide window covered the gap
          // after it and the stream reached the text delta; the tight window
          // then governed the NEXT gap. Two parts seen, and the breadcrumb
          // names the last real provider output.
          lastPartType: 'text-delta',
          partsSeen: 2,
          phase: 'streaming',
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
      if (previousFirstOutput === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS');
      } else {
        process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = previousFirstOutput;
      }
    }
  });

  it('lets a high-effort reasoning pause outlive the inter-output window', async () => {
    // The google/gemini-3.7-flash failure, end to end through the real loop.
    //
    // That model at `reasoning.effort: 'high'` emits a burst of thought, pauses
    // to think further, then continues. Both attempts of run-352bcf33 died in
    // that pause with `lastPartType: 'reasoning-delta'` and `phase: 'streaming'`
    // — the first delta had been counted as "the provider started answering",
    // arming the tight window against the pauses reasoning is made of.
    //
    // Every gap here is 2x the inter-output window and well inside the reasoning
    // one, so the ONLY way this run fails is a regression that reclassifies
    // reasoning as an answer.
    //
    // The stream deliberately ends on reasoning rather than emitting a final
    // text delta: once an answer starts, the tight window SHOULD govern again,
    // and a trailing text part would stall on that correct behaviour instead of
    // on the one under test. The reasoning to streaming transition has its own
    // case in with-inactivity-timeout.spec.ts.
    const previousToolTimeout = process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'];
    const previousStreamInactivity = process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'];
    const previousReasoningGap = process.env['BRAINSTRIKE_STREAM_REASONING_GAP_MS'];
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '10';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '30';
    // ~33x headroom: this asserts a NEGATIVE (no stall), so only host slowness
    // could break it, never host speed.
    process.env['BRAINSTRIKE_STREAM_REASONING_GAP_MS'] = '2000';
    setStreamPartDelayMs(60);
    setMockStreamParts([
      { type: 'step-start' },
      { payload: { text: 'let me think' }, type: 'reasoning-delta' },
      { payload: { text: 'still thinking' }, type: 'reasoning-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u-reasoning', parts: [{ text: 'think hard', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );
      const chunks = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      expect(findRunEventChunks(chunks, 'run.failed')).toHaveLength(0);
      expect(chunks).toContainEqual(
        expect.objectContaining({ finishReason: 'stop', type: 'message-finish' })
      );
    } finally {
      setStreamPartDelayMs(0);
      restoreEnv('BRAINSTRIKE_TOOL_TIMEOUT_MS', previousToolTimeout);
      restoreEnv('BRAINSTRIKE_STREAM_INACTIVITY_MS', previousStreamInactivity);
      restoreEnv('BRAINSTRIKE_STREAM_REASONING_GAP_MS', previousReasoningGap);
    }
  });
});
