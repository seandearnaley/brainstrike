import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '../index';
import {
  AssistantDataStreamSession,
  assistantDataStreamSessions,
  createRandomId,
  resolveDataStreamSession,
} from '../stream/data-stream';
import { boundToolOutputForModel, TOOL_RESULT_TOO_LARGE_CODE } from '../stream/tool-output-limits';

interface Encoded {
  code: string;
  value: unknown;
}

function assertDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function createAsyncStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

async function readResponse(response: Response): Promise<string[]> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) {
    return [];
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value && value.length > 0) {
      buffer += decoder.decode(value, { stream: true });
    }
  }
  buffer += decoder.decode();
  return buffer
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseLines(lines: string[]): Encoded[] {
  return lines.map((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error(`invalid data stream line: ${line}`);
    }
    const code = line.slice(0, idx);
    const payload = line.slice(idx + 1);
    return {
      code,
      value: JSON.parse(payload),
    } satisfies Encoded;
  });
}

describe('AssistantDataStreamSession', () => {
  it('createRandomId returns a prefixed UUID-shaped value', () => {
    const firstId = createRandomId('sess');
    const secondId = createRandomId('sess');

    expect(firstId.startsWith('sess_')).toBe(true);
    expect(secondId.startsWith('sess_')).toBe(true);
    expect(firstId).not.toBe(secondId);

    const uuidSuffix = firstId.slice('sess_'.length);
    expect(uuidSuffix).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('encodes mastra chunks into AI SDK data stream lines', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Hello ' },
      { type: 'text-delta', value: 'world' },
      {
        type: 'tool-event',
        name: 'weather.lookup',
        status: 'start',
        payload: { toolCallId: 'call-1', args: { city: 'SF' } },
      },
      {
        type: 'tool-event',
        name: 'weather.lookup',
        status: 'progress',
        payload: { step: 'input_stream_delta', toolCallId: 'call-1', argsTextDelta: '{"city":' },
      },
      {
        type: 'tool-event',
        name: 'weather.lookup',
        status: 'progress',
        payload: { step: 'input_stream_delta', toolCallId: 'call-1', argsTextDelta: '"SF"}' },
      },
      {
        type: 'tool-event',
        name: 'weather.lookup',
        status: 'progress',
        payload: { step: 'input_stream_end', toolCallId: 'call-1' },
      },
      {
        type: 'tool-event',
        name: 'weather.lookup',
        status: 'success',
        payload: { toolCallId: 'call-1', output: { tempC: 18 } },
      },
      { type: 'text-delta', value: ' Done.' },
      { type: 'finish', usage: { promptTokens: 5, completionTokens: 7 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'sess-test',
      messageId: 'msg-test',
    });

    const lines = await readResponse(session.createResponse());
    const codes = lines.map((line) => line.slice(0, 1));
    expect(codes).toStrictEqual([
      'f', // start-step
      '0',
      '0',
      'b',
      'c',
      'c',
      '9',
      'a',
      'e',
      'f', // new step after tool
      '0',
      'e',
      'd',
    ]);

    const events = parseLines(lines);
    const toolResult = events.find((evt) => evt.code === 'a')?.value as {
      toolCallId: string;
      result: { tempC: number };
    };
    expect(toolResult?.result).toMatchObject({ tempC: 18 });

    const finish = events.at(-1)?.value as {
      finishReason: string;
      usage: DataStreamUsage;
    };
    expect(finish?.usage).toStrictEqual({ inputTokens: 5, outputTokens: 7 });
  });

  it('prefers data-stream usage fields over legacy prompt/completion aliases', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Hello' },
      {
        type: 'finish',
        usage: {
          inputTokens: 11,
          outputTokens: 13,
          promptTokens: 5,
          completionTokens: 7,
        },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'usage-precedence',
      messageId: 'msg-usage-precedence',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const finish = events.at(-1)?.value as {
      usage: DataStreamUsage;
    };

    expect(finish?.usage).toStrictEqual({ inputTokens: 11, outputTokens: 13 });
  });

  it('encodes assistant run events as assistant-ui named data parts', async () => {
    const chunks: StreamChunk[] = [
      {
        type: 'run-event',
        event: {
          id: 'event-1',
          kind: 'memory.configured',
          label: 'Memory configured',
          sequence: 1,
          status: 'completed',
          timestamp: '2026-04-24T12:00:00.000Z',
          metadata: {
            threadId: 'thread-1',
            resourceId: 'workspace-1',
          },
        },
      },
      { type: 'text-delta', value: 'Hello' },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'run-events',
      messageId: 'msg-run-events',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const runEvent = events.find((evt) => evt.code === 'aui-data');

    expect(runEvent?.value).toStrictEqual({
      name: 'brainstrike.run-event',
      data: {
        id: 'event-1',
        kind: 'memory.configured',
        label: 'Memory configured',
        sequence: 1,
        status: 'completed',
        timestamp: '2026-04-24T12:00:00.000Z',
        metadata: {
          threadId: 'thread-1',
          resourceId: 'workspace-1',
        },
      },
    });
  });

  it('encodes reasoning deltas and skips empty text-like chunks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: '' },
      { type: 'reasoning-delta', value: '' },
      { type: 'reasoning-delta', value: 'Checking memory state' },
      { type: 'text-delta', value: 'Visible answer' },
      { type: 'finish', usage: { promptTokens: 3, completionTokens: 4 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'reasoning',
      messageId: 'msg-reasoning',
    });

    const events = parseLines(await readResponse(session.createResponse()));

    expect(events.filter((evt) => evt.code === 'g')).toStrictEqual([
      { code: 'g', value: 'Checking memory state' },
    ]);
    expect(events.filter((evt) => evt.code === '0')).toStrictEqual([
      { code: '0', value: 'Visible answer' },
    ]);
  });

  it('emits an error finish when the source stream throws', async () => {
    async function* failingStream(): AsyncIterableIterator<StreamChunk> {
      yield { type: 'text-delta', value: 'Before failure' };
      throw new Error('stream exploded');
    }

    const session = new AssistantDataStreamSession(failingStream(), () => {}, {
      sessionId: 'source-error',
      messageId: 'msg-source-error',
    });

    const events = parseLines(await readResponse(session.createResponse()));

    expect(events.find((evt) => evt.code === '3')?.value).toBe('stream exploded');
    expect(events.at(-1)).toStrictEqual({
      code: 'd',
      value: {
        finishReason: 'error',
        usage: { inputTokens: 0, outputTokens: 0 },
        path: [],
      },
    });
  });

  it('emits a visible error when the source stream ends without a finish event', async () => {
    const chunks: StreamChunk[] = [{ type: 'text-delta', value: 'Partial answer' }];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'missing-finish',
      messageId: 'msg-missing-finish',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const error = events.find((evt) => evt.code === '3')?.value;
    const visibleText = events
      .filter((evt) => evt.code === '0')
      .map((evt) => evt.value)
      .join('');

    expect(error).toBe('Assistant stream ended without a normal stop signal.');
    expect(visibleText).toContain('Partial answer');
    expect(visibleText).toContain(
      "I couldn't complete the assistant response: Assistant stream ended without a normal stop signal."
    );
    expect(events.at(-1)).toMatchObject({
      code: 'd',
      value: { finishReason: 'error' },
    });
  });

  it('supports resuming from Last-Event-ID', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'First ' },
      { type: 'text-delta', value: 'chunk' },
      { type: 'text-delta', value: '!' },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'resume',
      messageId: 'msg-resume',
    });

    const allLines = await readResponse(session.createResponse());
    const resumeIndex = Math.max(0, allLines.length - 2);
    const resumeId = `resume:${resumeIndex}`;

    const resumedLines = await readResponse(
      session.createResponse({ resumeFromEventId: resumeId })
    );
    const expectedTail = allLines.slice(resumeIndex + 1);
    expect(resumedLines).toStrictEqual(expectedTail);
  });

  it('keeps tool execution errors recoverable instead of ending the assistant message', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Working...' },
      {
        type: 'tool-event',
        name: 'failing.tool',
        status: 'error',
        payload: { toolCallId: 'oops', error: 'boom' },
      },
      { type: 'finish', usage: { promptTokens: 2, completionTokens: 0 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'err',
      messageId: 'msg-err',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const errorChunk = events.find((evt) => evt.code === '3');
    expect(errorChunk).toBeUndefined();

    const toolResult = events.find((evt) => evt.code === 'a')?.value as {
      isError?: boolean;
      result?: unknown;
      toolCallId?: string;
    };
    expect(toolResult).toStrictEqual({
      toolCallId: 'oops',
      result: 'boom',
      isError: true,
    });

    const visibleText = events
      .filter((evt) => evt.code === '0')
      .map((evt) => evt.value)
      .join('');
    expect(visibleText).toContain('Working...');
    expect(visibleText).toContain("I couldn't complete the tool action because it failed: boom");

    const finish = events.at(-1)?.value as {
      finishReason: string;
    };
    expect(finish?.finishReason).toBe('unknown');
  });

  it('surfaces every pending tool execution error before finishing recoverably', async () => {
    const chunks: StreamChunk[] = [
      {
        type: 'tool-event',
        name: 'first.tool',
        status: 'error',
        payload: { toolCallId: 'first', error: 'first failed' },
      },
      {
        type: 'tool-event',
        name: 'second.tool',
        status: 'error',
        payload: { toolCallId: 'second', error: 'second failed' },
      },
      { type: 'finish', usage: { promptTokens: 2, completionTokens: 0 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'multi-tool-err',
      messageId: 'msg-multi-tool-err',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const visibleText = events
      .filter((evt) => evt.code === '0')
      .map((evt) => evt.value)
      .join('');

    expect(events.filter((evt) => evt.code === 'a')).toHaveLength(2);
    expect(visibleText).toContain(
      "I couldn't complete some tool actions because they failed: first failed; second failed"
    );
    expect(events.find((evt) => evt.code === '3')).toBeUndefined();
    expect(events.at(-1)?.value).toMatchObject({ finishReason: 'unknown' });
  });

  it('surfaces model length finishes after tool calls instead of ending silently', async () => {
    const chunks: StreamChunk[] = [
      {
        type: 'tool-event',
        name: 'brainstrike.queryEmbeddingSpace',
        status: 'start',
        payload: { toolCallId: 'call-context', args: { query: 'database config' } },
      },
      {
        type: 'tool-event',
        name: 'brainstrike.queryEmbeddingSpace',
        status: 'success',
        payload: { toolCallId: 'call-context', output: { context: 'result' } },
      },
      {
        type: 'message-finish',
        finishReason: 'length',
        usage: { promptTokens: 20, completionTokens: 500 },
        path: [],
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'length-after-tools',
      messageId: 'msg-length-after-tools',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const error = events.find((evt) => evt.code === '3')?.value;
    const visibleText = events
      .filter((evt) => evt.code === '0')
      .map((evt) => evt.value)
      .join('');
    const finishMessage = events.at(-1);

    expect(error).toBe(
      'Assistant stopped because the model reached its output token limit before completing the response.'
    );
    expect(visibleText).toContain(
      "I couldn't complete the assistant response: Assistant stopped because the model reached its output token limit before completing the response."
    );
    expect(finishMessage?.value).toMatchObject({ finishReason: 'error' });
  });

  it('does not surface intermediate tool-call finishes as visible errors', async () => {
    const chunks: StreamChunk[] = [
      {
        type: 'message-finish',
        finishReason: 'tool-calls',
        usage: { promptTokens: 20, completionTokens: 4 },
        path: [],
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'tool-calls-finish',
      messageId: 'msg-tool-calls-finish',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const error = events.find((evt) => evt.code === '3')?.value;
    const finishMessage = events.at(-1);

    expect(error).toBeUndefined();
    expect(finishMessage?.value).toMatchObject({ finishReason: 'tool-calls' });
  });

  it('surfaces abnormal other finishes as visible errors', async () => {
    const chunks: StreamChunk[] = [
      {
        type: 'message-finish',
        finishReason: 'other',
        usage: { promptTokens: 20, completionTokens: 4 },
        path: [],
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'abnormal-finish',
      messageId: 'msg-abnormal-finish',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const error = events.find((evt) => evt.code === '3')?.value;
    const visibleText = events
      .filter((evt) => evt.code === '0')
      .map((evt) => evt.value)
      .join('');
    const finishMessage = events.at(-1);

    expect(error).toBe('Assistant stream ended without a normal stop signal.');
    expect(visibleText).toContain(
      "I couldn't complete the assistant response: Assistant stream ended without a normal stop signal."
    );
    expect(finishMessage?.value).toMatchObject({ finishReason: 'error' });
  });

  it('stops consuming source when response stream is canceled', async () => {
    let consumedCount = 0;
    const maxChunks = 10;

    async function* slowStream(): AsyncIterableIterator<StreamChunk> {
      for (let i = 0; i < maxChunks; i++) {
        consumedCount++;
        yield { type: 'text-delta', value: `chunk${i} ` };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield { type: 'finish', usage: { promptTokens: 1, completionTokens: maxChunks } };
    }

    const session = new AssistantDataStreamSession(slowStream(), () => {}, {
      sessionId: 'abort-test',
      messageId: 'msg-abort',
    });

    const response = session.createResponse();
    const body = response.body as ReadableStream<Uint8Array> | null;
    if (!body) {
      throw new Error('body is null');
    }

    const reader = body.getReader();

    // Read first few chunks
    await reader.read();
    await reader.read();
    await reader.read();

    // Cancel the stream
    await reader.cancel();

    // Give it time to process any in-flight chunks
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should have stopped consuming well before maxChunks
    expect(consumedCount).toBeLessThan(maxChunks);
    // Should have consumed at least the chunks we read (abort is very responsive)
    expect(consumedCount).toBeGreaterThanOrEqual(2);
  });

  it('handles abort when response is canceled immediately', async () => {
    let consumedCount = 0;

    async function* longStream(): AsyncIterableIterator<StreamChunk> {
      for (let i = 0; i < 100; i++) {
        consumedCount++;
        yield { type: 'text-delta', value: `chunk${i} ` };
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      yield { type: 'finish', usage: { promptTokens: 1, completionTokens: 100 } };
    }

    const session = new AssistantDataStreamSession(longStream(), () => {}, {
      sessionId: 'immediate-abort',
      messageId: 'msg-immediate',
    });

    const response = session.createResponse();
    const body = response.body as ReadableStream<Uint8Array> | null;
    if (!body) {
      throw new Error('body is null');
    }

    const reader = body.getReader();

    // Cancel immediately without reading
    await reader.cancel();

    // Give it minimal time
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have consumed very few chunks
    expect(consumedCount).toBeLessThan(10);
  });

  it('cancels all listeners when response stream is canceled', async () => {
    let consumedCount = 0;
    const maxChunks = 20;

    async function* simpleStream(): AsyncIterableIterator<StreamChunk> {
      for (let i = 0; i < maxChunks; i++) {
        consumedCount++;
        yield { type: 'text-delta', value: `chunk${i} ` };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield { type: 'finish', usage: { promptTokens: 1, completionTokens: maxChunks } };
    }

    const session = new AssistantDataStreamSession(simpleStream(), () => {}, {
      sessionId: 'cancel-all-test',
      messageId: 'msg-cancel-all',
    });

    // Create two concurrent response streams
    const response1 = session.createResponse();
    const response2 = session.createResponse();

    const body1 = response1.body as ReadableStream<Uint8Array> | null;
    const body2 = response2.body as ReadableStream<Uint8Array> | null;
    if (!(body1 && body2)) {
      throw new Error('body is null');
    }

    const reader1 = body1.getReader();
    const reader2 = body2.getReader();

    // Read a few chunks from both
    await reader1.read();
    await reader2.read();

    // Cancel first stream - should cancel all listeners
    await reader1.cancel();

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should have stopped consuming early
    expect(consumedCount).toBeLessThan(maxChunks);
  });

  it('supports multiple concurrent response streams from same session', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Chunk 1 ' },
      { type: 'text-delta', value: 'Chunk 2 ' },
      { type: 'text-delta', value: 'Chunk 3' },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 3 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'multi-response',
      messageId: 'msg-multi',
    });

    // Create first response and read all
    const lines1 = await readResponse(session.createResponse());
    expect(lines1.length).toBeGreaterThan(0);

    // Create second response from same session (should get buffered events)
    const lines2 = await readResponse(session.createResponse());
    expect(lines2).toStrictEqual(lines1);
  });

  it('resolves session by event ID through session manager', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Test' },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 1 } },
    ];

    // Use session manager to create session
    const session = assistantDataStreamSessions.create(createAsyncStream(chunks), {
      sessionId: 'manager-test',
      messageId: 'msg-manager',
    });

    // Read first chunk to generate event ID
    const response = session.createResponse();
    const body = response.body as ReadableStream<Uint8Array> | null;
    if (!body) {
      throw new Error('body is null');
    }
    const reader = body.getReader();
    await reader.read();
    await reader.cancel();

    // Resolve session by event ID
    const eventId = 'manager-test:0';
    const resolved = resolveDataStreamSession(eventId);
    expect(resolved).toBe(session);

    // Invalid event ID should return undefined
    const invalidResolved = resolveDataStreamSession('invalid:0');
    expect(invalidResolved).toBeUndefined();

    // Null/undefined should return undefined
    expect(resolveDataStreamSession(null)).toBeUndefined();
    expect(resolveDataStreamSession(undefined)).toBeUndefined();
  });

  it('resumes stream from specific event ID with flushExisting', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'A ' },
      { type: 'text-delta', value: 'B ' },
      { type: 'text-delta', value: 'C ' },
      { type: 'text-delta', value: 'D' },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 4 } },
    ];

    const session = assistantDataStreamSessions.create(createAsyncStream(chunks), {
      sessionId: 'flush-test',
      messageId: 'msg-flush',
    });

    // Read all events
    const allLines = await readResponse(session.createResponse());
    expect(allLines.length).toBeGreaterThan(4);

    // Resume from middle
    const midIndex = 2;
    const resumeId = `flush-test:${midIndex}`;
    const resumedLines = await readResponse(
      session.createResponse({ resumeFromEventId: resumeId })
    );

    // Should get events after midIndex
    const expectedTail = allLines.slice(midIndex + 1);
    expect(resumedLines).toStrictEqual(expectedTail);
  });

  it('calls cleanup callback when session closes with no listeners', async () => {
    let cleanupCalled = false;
    let cleanupSessionId = '';

    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Quick' },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 1 } },
    ];

    const session = new AssistantDataStreamSession(
      createAsyncStream(chunks),
      (sessionId) => {
        cleanupCalled = true;
        cleanupSessionId = sessionId;
      },
      {
        sessionId: 'cleanup-test',
        messageId: 'msg-cleanup',
        cleanupDelayMs: 10, // Short delay for testing
      }
    );

    // Read full stream, which should close the session
    await readResponse(session.createResponse());

    // Wait for cleanup to be scheduled and executed
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(cleanupCalled).toBe(true);
    expect(cleanupSessionId).toBe('cleanup-test');
  });

  describe('Tool Error Handling', () => {
    it('emits ToolCall chunk before ToolCallResult on error', async () => {
      const chunks: StreamChunk[] = [
        {
          type: 'tool-event',
          name: 'testTool',
          status: 'start',
          payload: {
            callId: 'call_123',
            toolCallId: 'call_123',
            input: { param: 'value' },
          },
        },
        {
          type: 'tool-event',
          name: 'testTool',
          status: 'error',
          payload: {
            callId: 'call_123',
            toolCallId: 'call_123',
            error: 'Not connected',
          },
        },
        { type: 'finish', usage: { promptTokens: 10, completionTokens: 20 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        sessionId: 'tool-error-test',
        messageId: 'msg-tool-error',
      });

      const response = await readResponse(session.createResponse());
      const parsed = parseLines(response);

      // Find the relevant chunks
      const startToolCall = parsed.find((p) => p.code === 'b'); // StartToolCall
      const toolCall = parsed.find((p) => p.code === '9'); // ToolCall with args
      const toolResult = parsed.find((p) => p.code === 'a'); // ToolCallResult
      const errorChunk = parsed.find((p) => p.code === '3'); // Message-level error
      const fallbackText = parsed.find(
        (p) =>
          p.code === '0' &&
          p.value === "I couldn't complete the tool action because it failed: Not connected"
      );

      // Verify StartToolCall was emitted
      expect(startToolCall).toBeDefined();
      const startToolCallChunk = assertDefined(startToolCall, 'Expected StartToolCall chunk');
      expect(startToolCallChunk.value).toMatchObject({
        toolCallId: 'call_123',
        toolName: 'testTool',
      });

      // Verify ToolCall with args was emitted (critical for UI rendering!)
      expect(toolCall).toBeDefined();
      const toolCallChunk = assertDefined(toolCall, 'Expected ToolCall chunk');
      expect(toolCallChunk.value).toMatchObject({
        toolCallId: 'call_123',
        toolName: 'testTool',
        args: { param: 'value' },
      });

      // Verify ToolCallResult with error flag was emitted
      expect(toolResult).toBeDefined();
      const toolResultChunk = assertDefined(toolResult, 'Expected ToolCallResult chunk');
      expect(toolResultChunk.value).toMatchObject({
        toolCallId: 'call_123',
        result: 'Not connected',
        isError: true,
      });

      // Tool execution errors should stay attached to the tool result instead
      // of terminating the assistant message with a message-level error.
      expect(errorChunk).toBeUndefined();
      expect(fallbackText).toBeDefined();
      const fallbackTextChunk = assertDefined(fallbackText, 'Expected visible recovery text');

      // Verify correct order: StartToolCall -> ToolCall -> ToolCallResult -> recovery text
      const startIdx = parsed.indexOf(startToolCallChunk);
      const toolIdx = parsed.indexOf(toolCallChunk);
      const resultIdx = parsed.indexOf(toolResultChunk);
      const fallbackTextIdx = parsed.indexOf(fallbackTextChunk);

      expect(startIdx).toBeLessThan(toolIdx);
      expect(toolIdx).toBeLessThan(resultIdx);
      expect(resultIdx).toBeLessThan(fallbackTextIdx);
    });

    it('handles tool error without explicit input in error payload', async () => {
      const chunks: StreamChunk[] = [
        {
          type: 'tool-event',
          name: 'brokenTool',
          status: 'start',
          payload: {
            callId: 'call_456',
            toolCallId: 'call_456',
            input: { query: 'test' },
          },
        },
        {
          type: 'tool-event',
          name: 'brokenTool',
          status: 'error',
          payload: {
            callId: 'call_456',
            toolCallId: 'call_456',
            error: { message: 'Internal error', code: 500 },
          },
        },
        { type: 'finish', usage: { promptTokens: 5, completionTokens: 10 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        sessionId: 'tool-error-no-input',
        messageId: 'msg-error-no-input',
      });

      const response = await readResponse(session.createResponse());
      const parsed = parseLines(response);

      const toolCall = parsed.find((p) => p.code === '9');
      const toolResult = parsed.find((p) => p.code === 'a');

      // Should still emit ToolCall with args from the start event
      expect(toolCall).toBeDefined();
      expect(toolCall?.value).toMatchObject({
        toolCallId: 'call_456',
        toolName: 'brokenTool',
        args: { query: 'test' },
      });

      // Should emit error result with the error object
      expect(toolResult).toBeDefined();
      expect(toolResult?.value).toMatchObject({
        toolCallId: 'call_456',
        isError: true,
      });
      expect(toolResult?.value).toHaveProperty('result');
    });

    it('handles tool error with args text delta', async () => {
      const chunks: StreamChunk[] = [
        {
          type: 'tool-event',
          name: 'streamTool',
          status: 'start',
          payload: {
            callId: 'call_789',
            toolCallId: 'call_789',
          },
        },
        {
          type: 'tool-event',
          name: 'streamTool',
          status: 'progress',
          payload: {
            callId: 'call_789',
            step: 'input_stream_delta',
            argsTextDelta: '{"location"',
          },
        },
        {
          type: 'tool-event',
          name: 'streamTool',
          status: 'progress',
          payload: {
            callId: 'call_789',
            step: 'input_stream_delta',
            argsTextDelta: ':"SF"}',
          },
        },
        {
          type: 'tool-event',
          name: 'streamTool',
          status: 'error',
          payload: {
            callId: 'call_789',
            toolCallId: 'call_789',
            error: 'Connection timeout',
          },
        },
        { type: 'finish', usage: { promptTokens: 10, completionTokens: 15 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        sessionId: 'tool-error-streamed',
        messageId: 'msg-error-streamed',
      });

      const response = await readResponse(session.createResponse());
      const parsed = parseLines(response);

      const argsDeltas = parsed.filter((p) => p.code === 'c'); // ToolCallArgsTextDelta
      const toolCall = parsed.find((p) => p.code === '9'); // ToolCall
      const toolResult = parsed.find((p) => p.code === 'a'); // ToolCallResult

      // Should have emitted the args text deltas
      expect(argsDeltas).toHaveLength(2);
      expect(argsDeltas[0]?.value).toMatchObject({
        toolCallId: 'call_789',
        argsTextDelta: '{"location"',
      });
      expect(argsDeltas[1]?.value).toMatchObject({
        toolCallId: 'call_789',
        argsTextDelta: ':"SF"}',
      });

      // Should emit ToolCall with reconstructed args from deltas
      expect(toolCall).toBeDefined();
      expect(toolCall?.value).toMatchObject({
        toolCallId: 'call_789',
        toolName: 'streamTool',
        args: { location: 'SF' },
      });

      // Should emit error result
      expect(toolResult).toBeDefined();
      expect(toolResult?.value).toMatchObject({
        toolCallId: 'call_789',
        result: 'Connection timeout',
        isError: true,
      });
    });

    it('keeps the assistant message recoverable when a tool fails', async () => {
      const chunks: StreamChunk[] = [
        {
          type: 'tool-event',
          name: 'failTool',
          status: 'start',
          payload: {
            callId: 'call_error',
            toolCallId: 'call_error',
            input: { test: 'value' },
          },
        },
        {
          type: 'tool-event',
          name: 'failTool',
          status: 'error',
          payload: {
            callId: 'call_error',
            toolCallId: 'call_error',
            error: 'Tool failed',
          },
        },
        { type: 'finish', usage: { promptTokens: 1, completionTokens: 1 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        sessionId: 'step-error-test',
        messageId: 'msg-step-error',
      });

      const response = await readResponse(session.createResponse());
      const parsed = parseLines(response);

      const finishStep = parsed.find((p) => p.code === 'e'); // FinishStep
      const finishMessage = parsed.find((p) => p.code === 'd'); // FinishMessage
      const textDelta = parsed.find((p) => p.code === '0'); // TextDelta

      // Step should remain complete/recoverable; only the tool result is an error.
      expect(finishStep).toBeDefined();
      expect(finishStep?.value).toMatchObject({
        finishReason: 'unknown',
      });
      expect(textDelta?.value).toBe(
        "I couldn't complete the tool action because it failed: Tool failed"
      );

      // Message should also remain complete/recoverable so the user can continue.
      expect(finishMessage).toBeDefined();
      expect(finishMessage?.value).toMatchObject({
        finishReason: 'unknown',
      });
    });

    it('turns oversized successful tool output into a bounded recoverable tool error', async () => {
      const oversizedOutput = `${'filesystem match\n'.repeat(5000)}needle-at-tail`;
      const chunks: StreamChunk[] = [
        {
          type: 'tool-event',
          name: 'filesystem.search_files',
          status: 'start',
          payload: {
            callId: 'call_files',
            toolCallId: 'call_files',
            input: { path: '.', pattern: '*.ts' },
          },
        },
        {
          type: 'tool-event',
          name: 'filesystem.search_files',
          status: 'success',
          payload: {
            callId: 'call_files',
            toolCallId: 'call_files',
            output: oversizedOutput,
          },
        },
        { type: 'finish', usage: { promptTokens: 1, completionTokens: 1 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        sessionId: 'oversized-tool-result-test',
        messageId: 'msg-oversized-tool-result',
      });

      const parsed = parseLines(await readResponse(session.createResponse()));
      const toolResult = parsed.find((p) => p.code === 'a')?.value as
        | {
            isError?: boolean;
            result?: {
              code?: string;
              error?: string;
              preview?: string;
            };
            toolCallId?: string;
          }
        | undefined;
      const textDelta = parsed.find((p) => p.code === '0');
      const finishMessage = parsed.find((p) => p.code === 'd');
      const serializedToolResult = JSON.stringify(toolResult);

      expect(toolResult).toMatchObject({
        toolCallId: 'call_files',
        isError: true,
        result: {
          code: 'tool_result_too_large',
        },
      });
      expect(toolResult?.result?.error).toContain(
        'filesystem.search_files returned too much output'
      );
      expect(toolResult?.result?.preview).toContain('filesystem match');
      expect(serializedToolResult.length).toBeLessThan(20_000);
      expect(serializedToolResult).not.toContain('needle-at-tail');
      expect(textDelta?.value).toContain('filesystem.search_files returned too much output');
      expect(finishMessage?.value).toMatchObject({ finishReason: 'unknown' });
    });

    it('does not split surrogate pairs in oversized tool output previews', () => {
      const output = `${'a'.repeat(7999)}🙂${'tail'.repeat(2000)}`;
      const bounded = boundToolOutputForModel('filesystem.search_files', output).output as {
        preview?: string;
      };

      expect(bounded.preview).toBe(`${'a'.repeat(7999)}🙂`);
      expect(bounded.preview?.charCodeAt(bounded.preview.length - 1)).not.toBe(0xd8_3d);
    });

    it('does not iterate the entire oversized tool output when building a preview', () => {
      const originalIterator = String.prototype[Symbol.iterator];
      let yieldedCodePoints = 0;
      function countedStringIterator(this: string): IterableIterator<string> {
        const iterator = originalIterator.call(this);
        return {
          [Symbol.iterator](): IterableIterator<string> {
            return this;
          },
          next(): IteratorResult<string> {
            const nextValue = iterator.next();
            if (!nextValue.done) {
              yieldedCodePoints += 1;
            }
            return nextValue;
          },
        };
      }

      Object.defineProperty(String.prototype, Symbol.iterator, {
        configurable: true,
        value: countedStringIterator,
      });

      try {
        const oversizedOutput = 'x'.repeat(20_000);
        boundToolOutputForModel('filesystem.search_files', oversizedOutput);

        expect(yieldedCodePoints).toBeLessThanOrEqual(8001);
      } finally {
        Object.defineProperty(String.prototype, Symbol.iterator, {
          configurable: true,
          value: originalIterator,
        });
      }
    });

    it('does not reprocess an already bounded oversized tool result', () => {
      const originalStringify = JSON.stringify;
      let stringifyCalls = 0;
      const boundedResult = {
        code: TOOL_RESULT_TOO_LARGE_CODE,
        error: 'filesystem.search_files returned too much output',
        maxLength: 12_000,
        originalLength: 80_000,
        preview: 'bounded preview',
        truncated: true,
      };
      JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
        stringifyCalls += 1;
        return originalStringify(...args);
      }) as typeof JSON.stringify;

      try {
        const bounded = boundToolOutputForModel('filesystem.search_files', boundedResult);

        expect(bounded.output).toBe(boundedResult);
        expect(bounded.errorText).toBe(boundedResult.error);
        expect(stringifyCalls).toBe(0);
      } finally {
        JSON.stringify = originalStringify;
      }
    });

    it('emits a user-visible error + error-finish when the source iterator throws', async () => {
      // Regression: top-level provider errors used to surface as a synthetic
      // tool-event with no toolCallId, which the data-stream mapper silently
      // dropped. Now the agent runtime throws and we must see DataStreamCode.error
      // ('3:') followed by a finishMessage with reason 'error' so the UI can
      // surface the failure to the user.
      const failingStream: AsyncIterable<StreamChunk> = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', value: 'partial' } as StreamChunk;
          throw new Error('ollama_400_tool_calling_unsupported');
        },
      };

      const session = new AssistantDataStreamSession(failingStream, () => {}, {
        sessionId: 'iterator-throws-test',
        messageId: 'msg-iterator-throws',
      });

      const response = await readResponse(session.createResponse());
      const parsed = parseLines(response);

      const errorLine = parsed.find((p) => p.code === '3');
      const finishMessage = parsed.find((p) => p.code === 'd');

      expect(errorLine).toBeDefined();
      expect(errorLine?.value).toBe('ollama_400_tool_calling_unsupported');
      expect(finishMessage).toBeDefined();
      expect(finishMessage?.value).toMatchObject({ finishReason: 'error' });
    });
  });
});

interface DataStreamUsage {
  inputTokens: number;
  outputTokens: number;
}
