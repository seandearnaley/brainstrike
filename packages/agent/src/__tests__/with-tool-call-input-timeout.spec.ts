import { describe, expect, it } from 'vitest';
import {
  ToolCallInputStreamingTimeoutError,
  withToolCallInputTimeout,
} from '../stream/with-tool-call-input-timeout';

interface TestPart {
  argsTextDelta?: string;
  payload?: {
    argsTextDelta?: string;
    toolCallId?: string;
  };
  toolCallId?: string | undefined;
  type: string;
}

const TOOL_INPUT_TEST_TIMEOUT_MS = 200;
const TOOL_INPUT_DELTA_CADENCE_MS = 20;
const TOOL_INPUT_LATE_DELTA_DELAY_MS = 250;
const TOOL_INPUT_DELTA_RUNTIME_MULTIPLIER = 2;
const TOOL_INPUT_DELTA_COUNT = Math.ceil(
  (TOOL_INPUT_TEST_TIMEOUT_MS * TOOL_INPUT_DELTA_RUNTIME_MULTIPLIER) / TOOL_INPUT_DELTA_CADENCE_MS
);

async function* completedToolInput(): AsyncIterableIterator<TestPart> {
  yield { toolCallId: 'call-1', type: 'tool-call-input-streaming-start' };
  yield { argsTextDelta: '{"path":"index.html"}', toolCallId: 'call-1', type: 'tool-call-delta' };
  yield { toolCallId: 'call-1', type: 'tool-call-input-streaming-end' };
}

async function* stuckToolInput(): AsyncIterableIterator<TestPart> {
  yield { toolCallId: 'call-stuck', type: 'tool-call-input-streaming-start' };
  for (let index = 0; index < TOOL_INPUT_DELTA_COUNT; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, TOOL_INPUT_DELTA_CADENCE_MS));
    yield { argsTextDelta: 'x', toolCallId: 'call-stuck', type: 'tool-call-delta' };
  }
}

async function* stuckNestedToolInput(): AsyncIterableIterator<TestPart> {
  yield {
    payload: { toolCallId: 'call-nested' },
    type: 'tool-call-input-streaming-start',
  };
  for (let index = 0; index < TOOL_INPUT_DELTA_COUNT; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, TOOL_INPUT_DELTA_CADENCE_MS));
    yield {
      payload: { argsTextDelta: 'x', toolCallId: 'call-nested' },
      type: 'tool-call-delta',
    };
  }
}

describe('withToolCallInputTimeout', () => {
  it('passes through a tool input that completes inside the absolute deadline', async () => {
    const parts: TestPart[] = [];
    for await (const part of withToolCallInputTimeout(completedToolInput(), 1000)) {
      parts.push(part);
    }

    expect(parts.map((part) => part.type)).toEqual([
      'tool-call-input-streaming-start',
      'tool-call-delta',
      'tool-call-input-streaming-end',
    ]);
  });

  it('does not inspect tool-call ids on unrelated stream parts', async () => {
    const textPartCount = 10_000;
    let toolCallIdReads = 0;
    const textPart = {
      get toolCallId(): string {
        toolCallIdReads += 1;
        return 'not-a-tool-call';
      },
      type: 'text-delta',
    };

    async function* textStream(): AsyncIterableIterator<TestPart> {
      for (let index = 0; index < textPartCount; index += 1) {
        yield textPart;
      }
    }

    let observedPartCount = 0;
    for await (const _part of withToolCallInputTimeout(textStream(), 1000)) {
      observedPartCount += 1;
    }

    expect(observedPartCount).toBe(textPartCount);
    expect(toolCallIdReads).toBe(0);
  });

  it('reads a relevant tool-call id accessor exactly once', async () => {
    let toolCallIdReads = 0;
    const toolPart = {
      get toolCallId(): string | undefined {
        toolCallIdReads += 1;
        return toolCallIdReads === 1 ? 'call-accessor' : undefined;
      },
      type: 'tool-call',
    };

    async function* toolStream(): AsyncIterableIterator<TestPart> {
      yield toolPart;
    }

    const parts: TestPart[] = [];
    for await (const part of withToolCallInputTimeout(toolStream(), 1000)) {
      parts.push(part);
    }

    expect(parts).toEqual([toolPart]);
    expect(toolCallIdReads).toBe(1);
  });

  it('does not let partial argument deltas extend the absolute deadline', async () => {
    const parts: TestPart[] = [];

    await expect(async () => {
      for await (const part of withToolCallInputTimeout(
        stuckToolInput(),
        TOOL_INPUT_TEST_TIMEOUT_MS
      )) {
        parts.push(part);
      }
    }).rejects.toMatchObject({
      code: 'tool_call_input_streaming_timeout',
      timeoutMs: TOOL_INPUT_TEST_TIMEOUT_MS,
      toolCallId: 'call-stuck',
    });

    // Positive timeout assertions are helped by scheduler slowness, but this
    // cadence assertion is hurt by it. The 200ms / 20ms ratio gives loaded
    // runners ~10x per-gap headroom while still proving deltas cannot reset the
    // absolute deadline.
    expect(parts.filter((part) => part.type === 'tool-call-delta').length).toBeGreaterThan(1);
  });

  it('notifies the owner with the distinct timeout before source cancellation can mask it', async () => {
    let timeoutError: ToolCallInputStreamingTimeoutError | undefined;

    await expect(async () => {
      for await (const _part of withToolCallInputTimeout(
        stuckToolInput(),
        TOOL_INPUT_TEST_TIMEOUT_MS,
        (error) => {
          timeoutError = error;
        }
      )) {
        // Drain until the absolute tool-input deadline expires.
      }
    }).rejects.toBeInstanceOf(ToolCallInputStreamingTimeoutError);

    expect(timeoutError).toMatchObject({
      timeoutMs: TOOL_INPUT_TEST_TIMEOUT_MS,
      toolCallId: 'call-stuck',
    });
  });

  it('recognizes Mastra tool-call ids nested in payloads', async () => {
    await expect(async () => {
      for await (const _part of withToolCallInputTimeout(
        stuckNestedToolInput(),
        TOOL_INPUT_TEST_TIMEOUT_MS
      )) {
        // Drain until the absolute tool-input deadline expires.
      }
    }).rejects.toMatchObject({
      code: 'tool_call_input_streaming_timeout',
      timeoutMs: TOOL_INPUT_TEST_TIMEOUT_MS,
      toolCallId: 'call-nested',
    });
  });

  it('does not reopen a completed call when late progress markers arrive', async () => {
    async function* completedBeforeProgress(): AsyncIterableIterator<TestPart> {
      yield { toolCallId: 'call-complete', type: 'tool-call' };
      yield { toolCallId: 'call-complete', type: 'tool-call-input-streaming-start' };
      await new Promise((resolve) => setTimeout(resolve, TOOL_INPUT_LATE_DELTA_DELAY_MS));
      yield { argsTextDelta: 'late', toolCallId: 'call-complete', type: 'tool-call-delta' };
    }

    const parts: TestPart[] = [];
    for await (const part of withToolCallInputTimeout(
      completedBeforeProgress(),
      TOOL_INPUT_TEST_TIMEOUT_MS
    )) {
      parts.push(part);
    }

    expect(parts).toHaveLength(3);
  });

  it('does not reopen an ended input when late progress markers arrive', async () => {
    async function* endedBeforeProgress(): AsyncIterableIterator<TestPart> {
      yield { toolCallId: 'call-ended', type: 'tool-call-input-streaming-start' };
      yield { toolCallId: 'call-ended', type: 'tool-call-input-streaming-end' };
      yield { argsTextDelta: 'late', toolCallId: 'call-ended', type: 'tool-call-delta' };
      await new Promise((resolve) => setTimeout(resolve, TOOL_INPUT_LATE_DELTA_DELAY_MS));
      yield { argsTextDelta: 'later', toolCallId: 'call-ended', type: 'tool-call-delta' };
    }

    const parts: TestPart[] = [];
    for await (const part of withToolCallInputTimeout(
      endedBeforeProgress(),
      TOOL_INPUT_TEST_TIMEOUT_MS
    )) {
      parts.push(part);
    }

    expect(parts).toHaveLength(4);
  });

  it('rejects an expired deadline before consuming an already-buffered delta', async () => {
    async function* bufferedToolInput(): AsyncIterableIterator<TestPart> {
      yield { toolCallId: 'call-buffered', type: 'tool-call-input-streaming-start' };
      yield {
        argsTextDelta: 'already buffered',
        toolCallId: 'call-buffered',
        type: 'tool-call-delta',
      };
    }

    const iterator = withToolCallInputTimeout(bufferedToolInput(), TOOL_INPUT_TEST_TIMEOUT_MS);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'tool-call-input-streaming-start' },
    });
    await new Promise((resolve) => setTimeout(resolve, TOOL_INPUT_LATE_DELTA_DELAY_MS));

    await expect(iterator.next()).rejects.toMatchObject({
      code: 'tool_call_input_streaming_timeout',
      timeoutMs: TOOL_INPUT_TEST_TIMEOUT_MS,
      toolCallId: 'call-buffered',
    });
  });
});
