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
  toolCallId?: string;
  type: string;
}

async function* completedToolInput(): AsyncIterableIterator<TestPart> {
  yield { toolCallId: 'call-1', type: 'tool-call-input-streaming-start' };
  yield { argsTextDelta: '{"path":"index.html"}', toolCallId: 'call-1', type: 'tool-call-delta' };
  yield { toolCallId: 'call-1', type: 'tool-call-input-streaming-end' };
}

async function* endlessToolInput(): AsyncIterableIterator<TestPart> {
  yield { toolCallId: 'call-stuck', type: 'tool-call-input-streaming-start' };
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    yield { argsTextDelta: 'x', toolCallId: 'call-stuck', type: 'tool-call-delta' };
  }
}

async function* endlessNestedToolInput(): AsyncIterableIterator<TestPart> {
  yield {
    payload: { toolCallId: 'call-nested' },
    type: 'tool-call-input-streaming-start',
  };
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
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

  it('does not let partial argument deltas extend the absolute deadline', async () => {
    const parts: TestPart[] = [];

    await expect(async () => {
      for await (const part of withToolCallInputTimeout(endlessToolInput(), 30)) {
        parts.push(part);
      }
    }).rejects.toMatchObject({
      code: 'tool_call_input_streaming_timeout',
      timeoutMs: 30,
      toolCallId: 'call-stuck',
    });

    expect(parts.filter((part) => part.type === 'tool-call-delta').length).toBeGreaterThan(1);
  });

  it('notifies the owner with the distinct timeout before source cancellation can mask it', async () => {
    let timeoutError: ToolCallInputStreamingTimeoutError | undefined;

    await expect(async () => {
      for await (const _part of withToolCallInputTimeout(endlessToolInput(), 30, (error) => {
        timeoutError = error;
      })) {
        // Drain until the absolute tool-input deadline expires.
      }
    }).rejects.toBeInstanceOf(ToolCallInputStreamingTimeoutError);

    expect(timeoutError).toMatchObject({
      timeoutMs: 30,
      toolCallId: 'call-stuck',
    });
  });

  it('recognizes Mastra tool-call ids nested in payloads', async () => {
    await expect(async () => {
      for await (const _part of withToolCallInputTimeout(endlessNestedToolInput(), 30)) {
        // Drain until the absolute tool-input deadline expires.
      }
    }).rejects.toMatchObject({
      code: 'tool_call_input_streaming_timeout',
      timeoutMs: 30,
      toolCallId: 'call-nested',
    });
  });

  it('does not reopen a completed call when late progress markers arrive', async () => {
    async function* completedBeforeProgress(): AsyncIterableIterator<TestPart> {
      yield { toolCallId: 'call-complete', type: 'tool-call' };
      yield { toolCallId: 'call-complete', type: 'tool-call-input-streaming-start' };
      await new Promise((resolve) => setTimeout(resolve, 35));
      yield { argsTextDelta: 'late', toolCallId: 'call-complete', type: 'tool-call-delta' };
    }

    const parts: TestPart[] = [];
    for await (const part of withToolCallInputTimeout(completedBeforeProgress(), 30)) {
      parts.push(part);
    }

    expect(parts).toHaveLength(3);
  });

  it('does not reopen an ended input when late progress markers arrive', async () => {
    async function* endedBeforeProgress(): AsyncIterableIterator<TestPart> {
      yield { toolCallId: 'call-ended', type: 'tool-call-input-streaming-start' };
      yield { toolCallId: 'call-ended', type: 'tool-call-input-streaming-end' };
      yield { argsTextDelta: 'late', toolCallId: 'call-ended', type: 'tool-call-delta' };
      await new Promise((resolve) => setTimeout(resolve, 35));
      yield { argsTextDelta: 'later', toolCallId: 'call-ended', type: 'tool-call-delta' };
    }

    const parts: TestPart[] = [];
    for await (const part of withToolCallInputTimeout(endedBeforeProgress(), 30)) {
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

    const iterator = withToolCallInputTimeout(bufferedToolInput(), 30);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'tool-call-input-streaming-start' },
    });
    await new Promise((resolve) => setTimeout(resolve, 35));

    await expect(iterator.next()).rejects.toMatchObject({
      code: 'tool_call_input_streaming_timeout',
      timeoutMs: 30,
      toolCallId: 'call-buffered',
    });
  });
});
