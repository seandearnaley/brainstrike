import {
  type AssistantMessage,
  AssistantMessageAccumulator,
  DataStreamDecoder,
} from 'assistant-stream';
import { describe, expect, it, vi } from 'vitest';
import type { StreamChunk } from '../index';
import {
  AssistantDataStreamSession,
  assistantDataStreamSessions,
  createRandomId,
  createStatelessAssistantDataStreamResponse,
  resolveDataStreamSession,
} from '../stream/data-stream';
import { SessionSubscription } from '../stream/session-subscription';
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

async function accumulateResponse(response: Response): Promise<AssistantMessage> {
  if (!response.body) {
    throw new Error('response body is required');
  }
  const messages = response.body
    .pipeThrough(new DataStreamDecoder())
    .pipeThrough(new AssistantMessageAccumulator());
  let lastMessage: AssistantMessage | undefined;
  for await (const message of messages) {
    lastMessage = message;
  }
  if (!lastMessage) {
    throw new Error('assistant-stream accumulator yielded no message');
  }
  return lastMessage;
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
  it.each([false, true])(
    'routes child frames through one normal mapper when native message identity changes (%s)',
    async (changeNativeMessage) => {
      const identity = {
        childRuntimeRunId: 'child-run',
        parentRuntimeRunId: 'parent-run',
        parentToolCallId: 'delegation',
        personaId: 'explore',
      };
      const scoped = (
        chunk: Exclude<StreamChunk, { type: 'delegated-conversation-chunk' }>,
        messageId = 'native-child-message'
      ): StreamChunk => ({
        chunk,
        identity,
        messageId,
        partId: 'native-part',
        type: 'delegated-conversation-chunk',
      });
      const session = new AssistantDataStreamSession(
        createAsyncStream([
          { type: 'text-delta', value: 'Parent before.' },
          scoped({ type: 'text-delta', value: 'Child content.' }),
          scoped(
            {
              finishReason: 'stop',
              path: [],
              type: 'message-finish',
              usage: { completionTokens: 3, promptTokens: 2 },
            },
            changeNativeMessage ? 'next-native-child-message' : 'native-child-message'
          ),
          { type: 'text-delta', value: 'Parent after.' },
          {
            finishReason: 'stop',
            path: [],
            type: 'message-finish',
            usage: { completionTokens: 7, promptTokens: 5 },
          },
        ]),
        () => {},
        { cleanupDelayMs: 0, messageId: 'parent-message' }
      );
      const lines = await readResponse(session.createResponse());
      const events = parseLines(lines);
      expect(
        events
          .filter((event) => event.code === '0')
          .map((event) => event.value)
          .join('')
      ).toBe('Parent before.Parent after.');
      expect(events.filter((event) => event.code === 'd')).toHaveLength(1);
      const childEnvelopes = events
        .flatMap((event) => {
          if (event.code !== '2') {
            return [];
          }
          return event.value as { name: string; data: { frames: Encoded[] } }[];
        })
        .filter((entry) => entry.name === 'brainstrike.delegated-conversation');
      expect(childEnvelopes).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            frames: expect.arrayContaining([{ code: '0', value: 'Child content.' }]),
            identity,
            messageId: 'native-child-message',
            partId: 'native-part',
          }),
          name: 'brainstrike.delegated-conversation',
        })
      );
      const childFrames = childEnvelopes.flatMap((entry) => entry.data.frames);
      expect(childFrames.filter((frame) => frame.code === 'f')).toHaveLength(1);
      const child = await accumulateResponse(
        new Response(
          childFrames.map((frame) => `${frame.code}:${JSON.stringify(frame.value)}\n`).join('')
        )
      );
      expect(child.parts).toContainEqual(
        expect.objectContaining({ text: 'Child content.', type: 'text' })
      );
      expect(child.status).toEqual({ reason: 'stop', type: 'complete' });
      // The existing session replays identical encoded child frames, not a new projection.
      expect(
        await readResponse(session.createResponse({ resumeFromEventId: `${session.id}:0` }))
      ).toEqual(lines.slice(1));
    }
  );

  it('removes a canceled subscription without closing an already-canceled controller', () => {
    const controller = {
      close: vi.fn(() => {
        throw new TypeError('Controller is already closed');
      }),
      enqueue: vi.fn(),
    } as unknown as ReadableStreamDefaultController<Uint8Array>;
    const session = {
      isClosed: () => false,
      pullEvent: () => undefined,
      removeSubscription: vi.fn(),
    };
    const subscription = new SessionSubscription(session, controller, 0);

    subscription.cancel();

    expect(controller.close).not.toHaveBeenCalled();
    expect(session.removeSubscription).toHaveBeenCalledWith(subscription);
  });

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
      // Streaming-args shape per tool-event-mapper: the start carries NO
      // input (`tool-call-input-streaming-start` maps to a progress event;
      // the args-carrying `tool-call` start only arrives after streaming
      // ends). A start WITH complete args is the non-streaming path and now
      // emits an eager `9` right after the `b` (BST-962), dropping any
      // out-of-spec trailing deltas.
      {
        name: 'weather.lookup',
        payload: { toolCallId: 'call-1' },
        status: 'start',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: { argsTextDelta: '{"city":', step: 'input_stream_delta', toolCallId: 'call-1' },
        status: 'progress',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: { argsTextDelta: '"SF"}', step: 'input_stream_delta', toolCallId: 'call-1' },
        status: 'progress',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: { step: 'input_stream_end', toolCallId: 'call-1' },
        status: 'progress',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: { output: { tempC: 18 }, toolCallId: 'call-1' },
        status: 'success',
        type: 'tool-event',
      },
      { type: 'text-delta', value: ' Done.' },
      { type: 'finish', usage: { completionTokens: 7, promptTokens: 5 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-test',
      sessionId: 'sess-test',
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

  it('encodes child-run-usage chunks as transient aui-data parts (BST-953)', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Working.' },
      {
        type: 'child-run-usage',
        value: {
          estimated: true,
          inputTokens: 24_000,
          outputTokens: 900,
          source: 'om-observation',
        },
      },
      { type: 'finish', usage: { completionTokens: 7, promptTokens: 5 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-child-usage',
      sessionId: 'sess-child-usage',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const usagePart = events.find(
      (event) =>
        event.code === 'aui-data' &&
        (event.value as { name?: string }).name === 'brainstrike.child-run-usage'
    );
    expect(usagePart?.value).toEqual({
      data: {
        estimated: true,
        inputTokens: 24_000,
        outputTokens: 900,
        source: 'om-observation',
      },
      name: 'brainstrike.child-run-usage',
    });
  });

  it('drops trailing args deltas after the tool call completed (renderer closes argsText on `9`)', async () => {
    // GLM-5.2 via OpenRouter emits trailing tool-call input deltas after the
    // complete tool call. A `c` frame after `9` makes assistant-stream's
    // decoder append into a CLOSED argsText controller. Through 0.3.34 that was
    // an unhandled "Cannot enqueue a chunk into a readable stream that is
    // closed" TypeError that failed the whole run; at the pinned 0.3.37 it is
    // dropped behind a console.warn. Either way the mapper must swallow them —
    // the quiet drop is harder to catch than the crash was.
    const chunks: StreamChunk[] = [
      {
        name: 'weather.lookup',
        payload: { args: {}, toolCallId: 'call-late' },
        status: 'start',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: {
          argsTextDelta: '{"city":"SF"}',
          step: 'input_stream_delta',
          toolCallId: 'call-late',
        },
        status: 'progress',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: { step: 'input_stream_end', toolCallId: 'call-late' },
        status: 'progress',
        type: 'tool-event',
      },
      // Trailing delta AFTER the args completed — must not reach the wire.
      {
        name: 'weather.lookup',
        payload: { argsTextDelta: '{"city"', step: 'input_stream_delta', toolCallId: 'call-late' },
        status: 'progress',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: { output: { tempC: 18 }, toolCallId: 'call-late' },
        status: 'success',
        type: 'tool-event',
      },
      // Trailing events AFTER the result (tool state already discarded) — the
      // auto-start defense for out-of-order events must NOT resurrect a
      // settled id (the renderer throws on duplicate tool call ids, and a
      // duplicate result would hit a closed controller). Deltas, a duplicate
      // start, and a duplicate success are all dropped.
      {
        name: 'weather.lookup',
        payload: { argsTextDelta: ':"SF"}', step: 'input_stream_delta', toolCallId: 'call-late' },
        status: 'progress',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: { args: {}, toolCallId: 'call-late' },
        status: 'start',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: { output: { tempC: 19 }, toolCallId: 'call-late' },
        status: 'success',
        type: 'tool-event',
      },
      { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-late-delta',
      sessionId: 'sess-late-delta',
    });

    const lines = await readResponse(session.createResponse());
    const codes = lines.map((line) => line.slice(0, 1));
    expect(codes).toStrictEqual([
      'f', // start-step
      'b', // tool call start
      'c', // the one legitimate args delta
      '9', // complete tool call (renderer closes argsText here)
      'a', // result
      'e', // finish-step
      'd', // finish-message
    ]);
  });

  it('keeps the approval NOTICE for a settled tool call without re-emitting frames', async () => {
    // Settled-id rule, frames only: a trailing tool-approval-required for a
    // call whose result is already on the wire must not auto-start a
    // duplicate `b` (renderer decoder throws on duplicate ids), but the
    // approval notice is a plain aui-data part and still flows.
    const chunks: StreamChunk[] = [
      {
        name: 'weather.lookup',
        payload: { args: { city: 'SF' }, toolCallId: 'call-settled-approval' },
        status: 'start',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: { output: { tempC: 18 }, toolCallId: 'call-settled-approval' },
        status: 'success',
        type: 'tool-event',
      },
      {
        args: {},
        resumeSchema: '{}',
        runId: 'run-settled-approval',
        toolCallId: 'call-settled-approval',
        toolName: 'weather.lookup',
        type: 'tool-approval-required',
      },
      { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-settled-approval',
      sessionId: 'sess-settled-approval',
    });

    const parsed = parseLines(await readResponse(session.createResponse()));
    // ONE b / ONE 9 / ONE a — the approval leg adds only its aui data part.
    expect(parsed.map((entry) => entry.code)).toStrictEqual([
      'f',
      'b',
      'c', // complete input reaches the decoder before args closure
      '9',
      'a',
      'aui-data',
      'e',
      'd',
    ]);
  });

  it('keeps the suspend NOTICE for a settled tool call without re-emitting frames (#1606 legacy ordering)', async () => {
    // The pinned legacy error-then-suspend ordering: the "error" was really
    // the suspension's transport, so the run IS suspended and must keep its
    // pause UI — while the settled call is never restarted (no duplicate `b`)
    // and no second result frame is emitted even with resumeSupported: false.
    const chunks: StreamChunk[] = [
      {
        name: 'brainstrike.submitPlan',
        payload: { error: 'Tool execution failed', toolCallId: 'call-settled-suspend' },
        status: 'error',
        type: 'tool-event',
      },
      {
        resumeSupported: false,
        runId: 'run-settled-suspend',
        suspendPayload: { title: 'Implementation plan' },
        toolCallId: 'call-settled-suspend',
        toolName: 'brainstrike.submitPlan',
        type: 'tool-suspend-required',
      },
      { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-settled-suspend',
      sessionId: 'sess-settled-suspend',
    });

    const parsed = parseLines(await readResponse(session.createResponse()));
    const codes = parsed.map((entry) => entry.code);
    // ONE b (from the error path's auto-start), ONE 9, ONE a — the suspend leg
    // adds only its data part; no duplicate frames and no second result.
    expect(codes.filter((code) => code === 'b')).toHaveLength(1);
    expect(codes.filter((code) => code === '9')).toHaveLength(1);
    expect(codes.filter((code) => code === 'a')).toHaveLength(1);
    const suspendPart = parsed.find(
      (entry) =>
        entry.code === 'aui-data' &&
        JSON.stringify(entry.value).includes('brainstrike.tool-suspend')
    );
    expect(suspendPart).toBeDefined();
    // And the transient error text stays discarded (the original #1606 pin).
    const visibleText = parsed
      .filter((entry) => entry.code === '0')
      .map((entry) => entry.value)
      .join('');
    expect(visibleText).not.toContain('Tool execution failed');
  });

  it('emits completed tool-call args before successful non-streaming tool results', async () => {
    const chunks: StreamChunk[] = [
      {
        name: 'weather.lookup',
        payload: { args: { city: 'SF' }, toolCallId: 'call-direct' },
        status: 'start',
        type: 'tool-event',
      },
      {
        name: 'weather.lookup',
        payload: { output: { tempC: 18 }, toolCallId: 'call-direct' },
        status: 'success',
        type: 'tool-event',
      },
      { type: 'finish', usage: { completionTokens: 7, promptTokens: 5 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-direct-tool-success',
      sessionId: 'direct-tool-success',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const toolCallIndex = events.findIndex((evt) => evt.code === '9');
    const toolResultIndex = events.findIndex((evt) => evt.code === 'a');

    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBeGreaterThan(-1);
    expect(toolCallIndex).toBeLessThan(toolResultIndex);
    expect(events[toolCallIndex]).toStrictEqual({
      code: '9',
      value: {
        args: { city: 'SF' },
        toolCallId: 'call-direct',
        toolName: 'weather.lookup',
      },
    });
    expect(events[toolResultIndex]).toStrictEqual({
      code: 'a',
      value: { result: { tempC: 18 }, toolCallId: 'call-direct' },
    });
  });

  it('preserves provider-reported billed cost on the finish message', async () => {
    const chunks: StreamChunk[] = [
      {
        billedCostUsd: 0.0042,
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 7, promptTokens: 5 },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-provider-cost',
      sessionId: 'provider-cost',
    });

    const finish = parseLines(await readResponse(session.createResponse())).at(-1)?.value;
    expect(finish).toMatchObject({
      billedCostUsd: 0.0042,
      usage: { inputTokens: 5, outputTokens: 7 },
    });
  });

  it('encodes approval-required tool chunks as pending approval data', async () => {
    const chunks: StreamChunk[] = [
      {
        args: { mode: 'replace', paths: ['src/index.ts'] },
        resumeSchema: '{}',
        runId: 'run-approval-1',
        toolCallId: 'approval-1',
        toolName: 'brainstrike.updateWorkspaceContextSelection',
        type: 'tool-approval-required',
      },
      {
        finishReason: 'tool-calls',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-approval-required',
      sessionId: 'approval-required',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const toolCallIndex = events.findIndex((evt) => evt.code === '9');
    const approvalIndex = events.findIndex(
      (evt) =>
        evt.code === 'aui-data' &&
        (evt.value as { name?: unknown }).name === 'brainstrike.tool-approval'
    );
    const finishIndex = events.findIndex((evt) => evt.code === 'd');

    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(approvalIndex).toBeGreaterThan(toolCallIndex);
    expect(finishIndex).toBeGreaterThan(approvalIndex);
    expect(events.find((evt) => evt.code === 'a')).toBeUndefined();
    expect(events.find((evt) => evt.code === '3')).toBeUndefined();
    expect(events[toolCallIndex]).toStrictEqual({
      code: '9',
      value: {
        args: { mode: 'replace', paths: ['src/index.ts'] },
        toolCallId: 'approval-1',
        toolName: 'brainstrike.updateWorkspaceContextSelection',
      },
    });
    expect(events[approvalIndex]).toStrictEqual({
      code: 'aui-data',
      value: {
        data: {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          resumeSchema: '{}',
          runId: 'run-approval-1',
          toolCallId: 'approval-1',
          toolName: 'brainstrike.updateWorkspaceContextSelection',
        },
        name: 'brainstrike.tool-approval',
      },
    });
    expect(events[finishIndex]).toStrictEqual({
      code: 'd',
      value: {
        finishReason: 'tool-calls',
        path: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  });

  it('prefers data-stream usage fields over legacy prompt/completion aliases', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Hello' },
      // The declared StreamChunkFinish usage carries only the legacy
      // prompt/completion aliases; this chunk intentionally adds the modern
      // fields too, to prove the mapper prefers them over the aliases.
      {
        type: 'finish',
        usage: {
          completionTokens: 7,
          inputTokens: 11,
          outputTokens: 13,
          promptTokens: 5,
        },
      } as unknown as StreamChunk,
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-usage-precedence',
      sessionId: 'usage-precedence',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const finish = events.at(-1)?.value as {
      usage: DataStreamUsage;
    };

    expect(finish?.usage).toStrictEqual({ inputTokens: 11, outputTokens: 13 });
  });

  it('serializes Anthropic cache token usage on the finish wire value', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Hello' },
      {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: {
          cacheCreationInputTokens: 60,
          cacheReadInputTokens: 40,
          completionTokens: 13,
          contextInputTokens: 28,
          contextOutputTokens: 3,
          promptTokens: 111,
        },
      } as unknown as StreamChunk,
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-usage-cache',
      sessionId: 'usage-cache',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const finish = events.at(-1)?.value as {
      usage: DataStreamUsage;
    };

    expect(finish?.usage).toStrictEqual({
      cacheCreationInputTokens: 60,
      cacheReadInputTokens: 40,
      contextInputTokens: 28,
      contextOutputTokens: 3,
      inputTokens: 111,
      outputTokens: 13,
    });
  });

  it('encodes assistant run events as assistant-ui named data parts', async () => {
    const chunks: StreamChunk[] = [
      {
        event: {
          id: 'event-1',
          kind: 'memory.configured',
          label: 'Memory configured',
          metadata: {
            resourceId: 'workspace-1',
            threadId: 'thread-1',
          },
          sequence: 1,
          status: 'completed',
          timestamp: '2026-04-24T12:00:00.000Z',
        },
        type: 'run-event',
      },
      { type: 'text-delta', value: 'Hello' },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-run-events',
      sessionId: 'run-events',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const runEvent = events.find((evt) => evt.code === 'aui-data');

    expect(runEvent?.value).toStrictEqual({
      data: {
        id: 'event-1',
        kind: 'memory.configured',
        label: 'Memory configured',
        metadata: {
          resourceId: 'workspace-1',
          threadId: 'thread-1',
        },
        sequence: 1,
        status: 'completed',
        timestamp: '2026-04-24T12:00:00.000Z',
      },
      name: 'brainstrike.run-event',
    });
  });

  it('encodes reasoning deltas and skips empty text-like chunks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: '' },
      { type: 'reasoning-delta', value: '' },
      { type: 'reasoning-delta', value: 'Checking memory state' },
      { type: 'text-delta', value: 'Visible answer' },
      { type: 'finish', usage: { completionTokens: 4, promptTokens: 3 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-reasoning',
      sessionId: 'reasoning',
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
      messageId: 'msg-source-error',
      sessionId: 'source-error',
    });

    const events = parseLines(await readResponse(session.createResponse()));

    expect(events.find((evt) => evt.code === '3')?.value).toBe('stream exploded');
    expect(events.at(-1)).toStrictEqual({
      code: 'd',
      value: {
        finishReason: 'error',
        path: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  });

  it('emits a visible error when the source stream ends without a finish event', async () => {
    const chunks: StreamChunk[] = [{ type: 'text-delta', value: 'Partial answer' }];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-missing-finish',
      sessionId: 'missing-finish',
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
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-resume',
      sessionId: 'resume',
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
        name: 'failing.tool',
        payload: { error: 'boom', toolCallId: 'oops' },
        status: 'error',
        type: 'tool-event',
      },
      { type: 'finish', usage: { completionTokens: 0, promptTokens: 2 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-err',
      sessionId: 'err',
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
      isError: true,
      result: 'boom',
      toolCallId: 'oops',
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
        name: 'first.tool',
        payload: { error: 'first failed', toolCallId: 'first' },
        status: 'error',
        type: 'tool-event',
      },
      {
        name: 'second.tool',
        payload: { error: 'second failed', toolCallId: 'second' },
        status: 'error',
        type: 'tool-event',
      },
      { type: 'finish', usage: { completionTokens: 0, promptTokens: 2 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-multi-tool-err',
      sessionId: 'multi-tool-err',
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

  it.each(['high', 'max'] as const)(
    'tells explicit %s-effort Kimi K3 runs to retry at Low or Auto after an output-limit finish',
    async (reasoningEffort) => {
      const chunks: StreamChunk[] = [
        {
          finishReason: 'length',
          path: [],
          type: 'message-finish',
          usage: { completionTokens: 131_072, promptTokens: 20 },
        },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        messageId: 'msg-kimi-output-limit',
        outputLimitContext: {
          model: 'moonshotai/kimi-k3',
          provider: 'openrouter',
          reasoningEffort,
        },
        sessionId: 'kimi-output-limit',
      });

      const events = parseLines(await readResponse(session.createResponse()));
      const error = events.find((evt) => evt.code === '3')?.value;

      expect(error).toBe(
        'Assistant stopped because Kimi K3 reached its output token limit before completing the response. Retry with reasoning effort set to Low or Auto.'
      );
      expect(session.getTerminalOutcome()).toEqual({ error, status: 'failed' });
    }
  );

  it.each([
    { model: 'moonshotai/kimi-k3', reasoningEffort: 'low' as const },
    { model: 'moonshotai/kimi-k3', reasoningEffort: undefined },
    { model: 'z-ai/glm-5.2', reasoningEffort: 'high' as const },
  ])(
    'keeps generic output-limit guidance for $model at $reasoningEffort effort',
    async (context) => {
      const chunks: StreamChunk[] = [
        {
          finishReason: 'length',
          path: [],
          type: 'message-finish',
          usage: { completionTokens: 32_000, promptTokens: 20 },
        },
      ];
      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        outputLimitContext: { ...context, provider: 'openrouter' },
      });

      const events = parseLines(await readResponse(session.createResponse()));

      expect(events.find((evt) => evt.code === '3')?.value).toBe(
        'Assistant stopped because the model reached its output token limit before completing the response.'
      );
    }
  );

  it('surfaces model length finishes after tool calls instead of ending silently', async () => {
    const chunks: StreamChunk[] = [
      {
        name: 'brainstrike.queryEmbeddingSpace',
        payload: { args: { query: 'database config' }, toolCallId: 'call-context' },
        status: 'start',
        type: 'tool-event',
      },
      {
        name: 'brainstrike.queryEmbeddingSpace',
        payload: { output: { context: 'result' }, toolCallId: 'call-context' },
        status: 'success',
        type: 'tool-event',
      },
      {
        finishReason: 'length',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 500, promptTokens: 20 },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-length-after-tools',
      sessionId: 'length-after-tools',
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
    expect(session.getTerminalOutcome()).toEqual({
      error:
        'Assistant stopped because the model reached its output token limit before completing the response.',
      status: 'failed',
    });
  });

  // A provider failure terminates via `makeProviderErrorTermination`, whose
  // chunk sequence is: the visible text-delta, a `run.failed` run event, then an
  // error finish (`finishReason: 'error'`). The durable outcome MUST be
  // `failed` — `docs/agents/assistant-runtime.md` states that a terminal
  // failure emits "run.failed, an error finish, and a failed durable run
  // outcome". Recording it as `completed` makes `thread_runs` contradict the
  // `run.failed` run event, and makes the debug bundle's Failure summary — which
  // reads `thread_runs` — report success for exactly the runs it exists to
  // diagnose.
  it('records a provider-error finish as a FAILED terminal outcome, not completed', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'The model request failed: upstream 429' },
      {
        event: {
          detail: 'upstream 429',
          id: 'run-event-provider-failure',
          kind: 'run.failed',
          label: 'Assistant run failed',
          status: 'failed',
          timestamp: '2026-07-25T00:00:00.000Z',
        },
        type: 'run-event',
      },
      {
        finishReason: 'error',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-provider-error-finish',
      sessionId: 'provider-error-finish',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const outcome = session.getTerminalOutcome();

    expect(outcome.status).toBe('failed');
    // Pinned exactly, not `toBeTruthy()`: a loose assertion would pass whether
    // the text came from the run event, the label, or the generic fallback,
    // leaving the wiring untested. The companion cases below pin the
    // label-fallback and the generic fallback, so the three together prove
    // which source was used.
    //
    // Specifically the DETAIL, not the label: all three terminations share the
    // generic label "Assistant run failed", so persisting the label would give
    // a correct status with no forensic value.
    expect(outcome.error).toBe('upstream 429');
    // The visible text the termination helper already emitted must not be
    // duplicated by the mapper's own failure fallback.
    const visibleText = events
      .filter((evt) => evt.code === '0')
      .map((evt) => evt.value)
      .join('');
    expect(visibleText).toBe('The model request failed: upstream 429');
  });

  // Companion to the case above: an error finish with NO preceding `run.failed`
  // event must still be terminal. This is what makes the pinned text above
  // meaningful — if the mapper ignored the run event, this case and that one
  // would produce identical text and neither would prove anything.
  it('records an error finish as failed even with no run.failed event to name it', async () => {
    const chunks: StreamChunk[] = [
      {
        finishReason: 'error',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-bare-error-finish',
      sessionId: 'bare-error-finish',
    });

    await readResponse(session.createResponse());

    expect(session.getTerminalOutcome()).toEqual({
      error: 'Assistant run failed.',
      status: 'failed',
    });
  });

  it('keeps the AI SDK unknown sentinel completed because it includes provider absence', async () => {
    const chunks: StreamChunk[] = [
      {
        finishReason: 'unknown',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 5, promptTokens: 3 },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-explicit-unknown',
      sessionId: 'explicit-unknown',
    });

    const events = parseLines(await readResponse(session.createResponse()));

    expect(session.getTerminalOutcome()).toEqual({
      error: null,
      status: 'completed',
    });
    expect(events.find((event) => event.code === '3')).toBeUndefined();
    expect(events.at(-1)?.value).toMatchObject({ finishReason: 'unknown' });
  });

  it('records a Brainstrike unrecognized finish sentinel as failed', async () => {
    const chunks: StreamChunk[] = [
      {
        event: {
          id: 'run-event-unrecognized',
          kind: 'run.failed',
          label: 'Assistant run ended abnormally (unrecognized)',
          metadata: { finishReason: 'unrecognized' },
          status: 'failed',
          timestamp: '2026-07-28T00:00:00.000Z',
        },
        type: 'run-event',
      },
      {
        finishReason: 'unrecognized',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 5, promptTokens: 3 },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-unrecognized',
      sessionId: 'unrecognized',
    });

    const events = parseLines(await readResponse(session.createResponse()));

    expect(session.getTerminalOutcome()).toEqual({
      error: 'Assistant stream ended with an unrecognized finish reason.',
      status: 'failed',
    });
    expect(events.find((event) => event.code === '3')?.value).toBe(
      'Assistant stream ended with an unrecognized finish reason.'
    );
    expect(events.at(-1)?.value).toMatchObject({ finishReason: 'error' });
  });

  it('keeps an absent finish reason internal while emitting a complete protocol value', async () => {
    const chunks: StreamChunk[] = [
      { type: 'finish', usage: { completionTokens: 5, promptTokens: 3 } },
    ];
    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-absent-finish',
      sessionId: 'absent-finish',
    });

    const events = parseLines(await readResponse(session.createResponse()));

    expect(session.getTerminalOutcome()).toEqual({
      error: null,
      status: 'completed',
    });
    expect(events.find((event) => event.code === '3')).toBeUndefined();
    expect(events.at(-1)?.value).toMatchObject({ finishReason: 'unknown' });

    const accumulatedSession = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-absent-finish-accumulated',
      sessionId: 'absent-finish-accumulated',
    });
    const accumulated = await accumulateResponse(accumulatedSession.createResponse());
    expect(accumulated.status).toEqual({
      reason: 'unknown',
      type: 'complete',
    });
  });

  // The unsupported approval/suspend pause (`makeUnsupportedApprovalChunks`)
  // also emits `run.failed` + an error finish, so it IS swept in by the same
  // branch — pinned here because an earlier revision of this change claimed it
  // was not. The outcome is correct: a malformed pause (missing toolCallId or
  // runId) genuinely cannot proceed, so recording it `completed` was the same
  // lie this change exists to fix. It carries no `detail`, so the label is the
  // durable text — which is why the mapper falls back to the label rather than
  // requiring a detail.
  it('records an unsupported approval pause as failed, using the label when no detail is present', async () => {
    const chunks: StreamChunk[] = [
      {
        event: {
          id: 'run-event-unsupported-approval',
          kind: 'run.failed',
          label: 'Tool approval required',
          metadata: { actionRequired: true, missingToolCallId: true, resumeSupported: false },
          status: 'failed',
          timestamp: '2026-07-25T00:00:00.000Z',
        },
        type: 'run-event',
      },
      {
        finishReason: 'error',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-unsupported-approval',
      sessionId: 'unsupported-approval',
    });

    await readResponse(session.createResponse());

    expect(session.getTerminalOutcome()).toEqual({
      error: 'Tool approval required',
      status: 'failed',
    });
  });

  it('does not surface intermediate tool-call finishes as visible errors', async () => {
    const chunks: StreamChunk[] = [
      {
        finishReason: 'tool-calls',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 4, promptTokens: 20 },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-tool-calls-finish',
      sessionId: 'tool-calls-finish',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const error = events.find((evt) => evt.code === '3')?.value;
    const finishMessage = events.at(-1);

    expect(error).toBeUndefined();
    expect(finishMessage?.value).toMatchObject({ finishReason: 'tool-calls' });
    expect(session.getTerminalOutcome()).toEqual({ error: null, status: 'completed' });
  });

  it('surfaces abnormal other finishes as visible errors', async () => {
    const chunks: StreamChunk[] = [
      {
        finishReason: 'other',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 4, promptTokens: 20 },
      },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-abnormal-finish',
      sessionId: 'abnormal-finish',
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

  it('keeps consuming the server-owned source when a response stream detaches', async () => {
    let consumedCount = 0;
    const maxChunks = 10;

    async function* slowStream(): AsyncIterableIterator<StreamChunk> {
      for (let i = 0; i < maxChunks; i++) {
        consumedCount++;
        yield { type: 'text-delta', value: `chunk${i} ` };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield { type: 'finish', usage: { completionTokens: maxChunks, promptTokens: 1 } };
    }

    const session = new AssistantDataStreamSession(slowStream(), () => {}, {
      messageId: 'msg-abort',
      sessionId: 'abort-test',
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

    // This is a negative assertion: response cancellation must NOT cancel the
    // server-owned source. Await the session's actual terminal signal instead
    // of racing a loaded runner against a fixed wall-clock sleep.
    await session.whenClosed();

    expect(consumedCount).toBe(maxChunks);
    expect(session.isClosed()).toBe(true);
  });

  it('keeps consuming when the first response detaches immediately', async () => {
    let consumedCount = 0;

    async function* longStream(): AsyncIterableIterator<StreamChunk> {
      for (let i = 0; i < 100; i++) {
        consumedCount++;
        yield { type: 'text-delta', value: `chunk${i} ` };
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      yield { type: 'finish', usage: { completionTokens: 100, promptTokens: 1 } };
    }

    const session = new AssistantDataStreamSession(longStream(), () => {}, {
      messageId: 'msg-immediate',
      sessionId: 'immediate-abort',
    });

    const response = session.createResponse();
    const body = response.body as ReadableStream<Uint8Array> | null;
    if (!body) {
      throw new Error('body is null');
    }

    const reader = body.getReader();

    // Cancel immediately without reading
    await reader.cancel();

    await session.whenClosed();
    expect(consumedCount).toBe(100);
  });

  it('detaches only the canceled listener while another listener keeps streaming', async () => {
    let consumedCount = 0;
    const maxChunks = 20;

    async function* simpleStream(): AsyncIterableIterator<StreamChunk> {
      for (let i = 0; i < maxChunks; i++) {
        consumedCount++;
        yield { type: 'text-delta', value: `chunk${i} ` };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield { type: 'finish', usage: { completionTokens: maxChunks, promptTokens: 1 } };
    }

    const session = new AssistantDataStreamSession(simpleStream(), () => {}, {
      messageId: 'msg-cancel-all',
      sessionId: 'cancel-all-test',
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

    // Cancel the first response only.
    await reader1.cancel();

    const remainingLines: string[] = [];
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader2.read();
      if (done) {
        break;
      }
      if (value) {
        remainingLines.push(decoder.decode(value, { stream: true }));
      }
    }
    await session.whenClosed();

    expect(consumedCount).toBe(maxChunks);
    expect(remainingLines.join('')).toContain('chunk19');
  });

  it('supports multiple concurrent response streams from same session', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Chunk 1 ' },
      { type: 'text-delta', value: 'Chunk 2 ' },
      { type: 'text-delta', value: 'Chunk 3' },
      { type: 'finish', usage: { completionTokens: 3, promptTokens: 1 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      messageId: 'msg-multi',
      sessionId: 'multi-response',
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
      { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ];

    // Use session manager to create session
    const session = assistantDataStreamSessions.create(createAsyncStream(chunks), {
      messageId: 'msg-manager',
      sessionId: 'manager-test',
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

  it('creates a single response without registering replay state globally', async () => {
    const response = createStatelessAssistantDataStreamResponse(
      createAsyncStream([
        { type: 'text-delta', value: 'Hosted response' },
        { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
      ]),
      {
        messageId: 'hosted-message',
        sessionId: 'hosted-stateless',
      }
    );

    expect(resolveDataStreamSession('hosted-stateless:0')).toBeUndefined();
    const lines = await readResponse(response);
    expect(lines.length).toBeGreaterThan(0);
    expect(resolveDataStreamSession('hosted-stateless:0')).toBeUndefined();
  });

  it('resumes stream from specific event ID with flushExisting', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'A ' },
      { type: 'text-delta', value: 'B ' },
      { type: 'text-delta', value: 'C ' },
      { type: 'text-delta', value: 'D' },
      { type: 'finish', usage: { completionTokens: 4, promptTokens: 1 } },
    ];

    const session = assistantDataStreamSessions.create(createAsyncStream(chunks), {
      messageId: 'msg-flush',
      sessionId: 'flush-test',
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
    let resolveCleanup: (() => void) | undefined;
    const cleanupCompleted = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });

    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Quick' },
      { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ];

    const session = new AssistantDataStreamSession(
      createAsyncStream(chunks),
      (sessionId) => {
        cleanupCalled = true;
        cleanupSessionId = sessionId;
        resolveCleanup?.();
      },
      {
        cleanupDelayMs: 10, // Short delay for testing
        messageId: 'msg-cleanup',
        sessionId: 'cleanup-test',
      }
    );

    // Read full stream, which should close the session
    await readResponse(session.createResponse());

    // Observe the callback rather than racing cleanupDelayMs against a larger
    // wall-clock sleep. Vitest's test timeout remains the failure bound.
    await cleanupCompleted;

    expect(cleanupCalled).toBe(true);
    expect(cleanupSessionId).toBe('cleanup-test');
  });

  describe('Tool Error Handling', () => {
    it('emits ToolCall chunk before ToolCallResult on error', async () => {
      const chunks: StreamChunk[] = [
        {
          name: 'testTool',
          payload: {
            callId: 'call_123',
            input: { param: 'value' },
            toolCallId: 'call_123',
          },
          status: 'start',
          type: 'tool-event',
        },
        {
          name: 'testTool',
          payload: {
            callId: 'call_123',
            error: 'Not connected',
            toolCallId: 'call_123',
          },
          status: 'error',
          type: 'tool-event',
        },
        { type: 'finish', usage: { completionTokens: 20, promptTokens: 10 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        messageId: 'msg-tool-error',
        sessionId: 'tool-error-test',
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
        args: { param: 'value' },
        toolCallId: 'call_123',
        toolName: 'testTool',
      });

      // Verify ToolCallResult with error flag was emitted
      expect(toolResult).toBeDefined();
      const toolResultChunk = assertDefined(toolResult, 'Expected ToolCallResult chunk');
      expect(toolResultChunk.value).toMatchObject({
        isError: true,
        result: 'Not connected',
        toolCallId: 'call_123',
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
          name: 'brokenTool',
          payload: {
            callId: 'call_456',
            input: { query: 'test' },
            toolCallId: 'call_456',
          },
          status: 'start',
          type: 'tool-event',
        },
        {
          name: 'brokenTool',
          payload: {
            callId: 'call_456',
            error: { code: 500, message: 'Internal error' },
            toolCallId: 'call_456',
          },
          status: 'error',
          type: 'tool-event',
        },
        { type: 'finish', usage: { completionTokens: 10, promptTokens: 5 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        messageId: 'msg-error-no-input',
        sessionId: 'tool-error-no-input',
      });

      const response = await readResponse(session.createResponse());
      const parsed = parseLines(response);

      const toolCall = parsed.find((p) => p.code === '9');
      const toolResult = parsed.find((p) => p.code === 'a');

      // Should still emit ToolCall with args from the start event
      expect(toolCall).toBeDefined();
      expect(toolCall?.value).toMatchObject({
        args: { query: 'test' },
        toolCallId: 'call_456',
        toolName: 'brokenTool',
      });

      // Should emit error result with the error object
      expect(toolResult).toBeDefined();
      expect(toolResult?.value).toMatchObject({
        isError: true,
        toolCallId: 'call_456',
      });
      expect(toolResult?.value).toHaveProperty('result');
    });

    it('keeps trusted args when a duplicate tool start omits its input', async () => {
      const chunks: StreamChunk[] = [
        {
          name: 'approvedTool',
          payload: {
            args: { command: 'printf approved' },
            callId: 'call_approved',
            input: { command: 'printf approved' },
            toolCallId: 'call_approved',
          },
          status: 'start',
          type: 'tool-event',
        },
        {
          name: 'approvedTool',
          payload: {
            args: {},
            callId: 'call_approved',
            input: {},
            toolCallId: 'call_approved',
          },
          status: 'start',
          type: 'tool-event',
        },
        {
          name: 'approvedTool',
          payload: {
            callId: 'call_approved',
            error: 'Tool failed',
            toolCallId: 'call_approved',
          },
          status: 'error',
          type: 'tool-event',
        },
        { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        messageId: 'msg-approved-duplicate-start',
        sessionId: 'approved-duplicate-start',
      });

      const parsed = parseLines(await readResponse(session.createResponse()));
      expect(parsed.find((part) => part.code === '9')?.value).toMatchObject({
        args: { command: 'printf approved' },
        toolCallId: 'call_approved',
        toolName: 'approvedTool',
      });
    });

    it('handles tool error with args text delta', async () => {
      const chunks: StreamChunk[] = [
        {
          name: 'streamTool',
          payload: {
            callId: 'call_789',
            toolCallId: 'call_789',
          },
          status: 'start',
          type: 'tool-event',
        },
        {
          name: 'streamTool',
          payload: {
            argsTextDelta: '{"location"',
            callId: 'call_789',
            step: 'input_stream_delta',
          },
          status: 'progress',
          type: 'tool-event',
        },
        {
          name: 'streamTool',
          payload: {
            argsTextDelta: ':"SF"}',
            callId: 'call_789',
            step: 'input_stream_delta',
          },
          status: 'progress',
          type: 'tool-event',
        },
        {
          name: 'streamTool',
          payload: {
            callId: 'call_789',
            error: 'Connection timeout',
            toolCallId: 'call_789',
          },
          status: 'error',
          type: 'tool-event',
        },
        { type: 'finish', usage: { completionTokens: 15, promptTokens: 10 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        messageId: 'msg-error-streamed',
        sessionId: 'tool-error-streamed',
      });

      const response = await readResponse(session.createResponse());
      const parsed = parseLines(response);

      const argsDeltas = parsed.filter((p) => p.code === 'c'); // ToolCallArgsTextDelta
      const toolCall = parsed.find((p) => p.code === '9'); // ToolCall
      const toolResult = parsed.find((p) => p.code === 'a'); // ToolCallResult

      // Should have emitted the args text deltas
      expect(argsDeltas).toHaveLength(2);
      expect(argsDeltas[0]?.value).toMatchObject({
        argsTextDelta: '{"location"',
        toolCallId: 'call_789',
      });
      expect(argsDeltas[1]?.value).toMatchObject({
        argsTextDelta: ':"SF"}',
        toolCallId: 'call_789',
      });

      // Should emit ToolCall with reconstructed args from deltas
      expect(toolCall).toBeDefined();
      expect(toolCall?.value).toMatchObject({
        args: { location: 'SF' },
        toolCallId: 'call_789',
        toolName: 'streamTool',
      });

      // Should emit error result
      expect(toolResult).toBeDefined();
      expect(toolResult?.value).toMatchObject({
        isError: true,
        result: 'Connection timeout',
        toolCallId: 'call_789',
      });
    });

    it('keeps the assistant message recoverable when a tool fails', async () => {
      const chunks: StreamChunk[] = [
        {
          name: 'failTool',
          payload: {
            callId: 'call_error',
            input: { test: 'value' },
            toolCallId: 'call_error',
          },
          status: 'start',
          type: 'tool-event',
        },
        {
          name: 'failTool',
          payload: {
            callId: 'call_error',
            error: 'Tool failed',
            toolCallId: 'call_error',
          },
          status: 'error',
          type: 'tool-event',
        },
        { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        messageId: 'msg-step-error',
        sessionId: 'step-error-test',
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

    it('does not surface a suspended tool call as a failed tool action', async () => {
      const chunks: StreamChunk[] = [
        {
          name: 'earlier.tool',
          payload: {
            error: 'Earlier tool failure',
            toolCallId: 'call-earlier',
          },
          status: 'error',
          type: 'tool-event',
        },
        {
          name: 'brainstrike.submitPlan',
          payload: {
            error: 'Tool execution failed',
            toolCallId: 'call-plan',
          },
          status: 'error',
          type: 'tool-event',
        },
        {
          runId: 'run-plan',
          suspendPayload: { title: 'Implementation plan' },
          toolCallId: 'call-plan',
          toolName: 'brainstrike.submitPlan',
          type: 'tool-suspend-required',
        },
        { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        messageId: 'msg-suspended-tool',
        sessionId: 'suspended-tool-test',
      });

      const parsed = parseLines(await readResponse(session.createResponse()));
      const visibleText = parsed
        .filter((part) => part.code === '0')
        .map((part) => part.value)
        .join('');

      expect(visibleText).toContain('Earlier tool failure');
      expect(visibleText).not.toContain('Tool execution failed');
    });

    it('leaves a RESUMABLE suspended tool call open (it is genuinely waiting on the user)', async () => {
      const chunks: StreamChunk[] = [
        {
          runId: 'run-plan',
          suspendPayload: { title: 'Implementation plan' },
          toolCallId: 'call-plan',
          toolName: 'brainstrike.submitPlan',
          type: 'tool-suspend-required',
        },
        { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        messageId: 'msg-registered-suspend',
        sessionId: 'registered-suspend-test',
      });

      const parsed = parseLines(await readResponse(session.createResponse()));

      expect(parsed.find((part) => part.code === '9')).toBeDefined();
      expect(parsed.filter((part) => part.code === 'a')).toHaveLength(0);
    });

    it('SETTLES the tool call when the pause has no registered resume UI (BST-558)', async () => {
      // The mapper emits a `tool-call` for the pause so the plan/question has a
      // card to hang off. For a REGISTERED tool the missing result is correct —
      // resume supplies it. For an unregistered one nothing ever will, so the
      // card would spin forever, and dismissing the notice would leave a
      // permanent, unactionable Running card.
      const chunks: StreamChunk[] = [
        {
          resumeSupported: false,
          runId: 'run-future',
          suspendPayload: { question: 'Which city?' },
          toolCallId: 'call-future',
          toolName: 'brainstrike.someFutureSuspendingTool',
          type: 'tool-suspend-required',
        },
        { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        messageId: 'msg-unregistered-suspend',
        sessionId: 'unregistered-suspend-test',
      });

      const parsed = parseLines(await readResponse(session.createResponse()));
      const toolCall = parsed.find((part) => part.code === '9');
      const toolResults = parsed.filter((part) => part.code === 'a');
      const visibleText = parsed
        .filter((part) => part.code === '0')
        .map((part) => part.value)
        .join('');
      const finishMessage = parsed.find((part) => part.code === 'd');

      expect(toolCall?.value).toMatchObject({ toolCallId: 'call-future' });
      // The tool part reaches a TERMINAL state, so no Running card can be
      // stranded behind a dismissed notice.
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]?.value).toMatchObject({
        isError: true,
        toolCallId: 'call-future',
      });
      // Settling the card must NOT fabricate a run-level failure: the run is
      // still suspended server-side and a later build can resume it.
      expect(visibleText).not.toContain("I couldn't complete");
      expect(finishMessage?.value).toMatchObject({ finishReason: 'unknown' });
    });

    it('keeps oversized successful tool output successful with a balanced head+tail preview', async () => {
      const oversizedOutput = `${'filesystem match\n'.repeat(5000)}needle-at-tail`;
      const chunks: StreamChunk[] = [
        {
          name: 'filesystem.search_files',
          payload: {
            callId: 'call_files',
            input: { path: '.', pattern: '*.ts' },
            toolCallId: 'call_files',
          },
          status: 'start',
          type: 'tool-event',
        },
        {
          name: 'filesystem.search_files',
          payload: {
            callId: 'call_files',
            output: oversizedOutput,
            toolCallId: 'call_files',
          },
          status: 'success',
          type: 'tool-event',
        },
        { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
      ];

      const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
        messageId: 'msg-oversized-tool-result',
        sessionId: 'oversized-tool-result-test',
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
        result: {
          code: 'tool_result_truncated',
        },
        toolCallId: 'call_files',
      });
      expect(toolResult?.isError).toBeUndefined();
      expect(toolResult?.result?.preview).toContain('filesystem match');
      expect(serializedToolResult.length).toBeLessThan(20_000);
      // Balanced head+tail retention (was head-only): the tail evidence the
      // old preview always discarded now survives alongside the head.
      expect(serializedToolResult).toContain('needle-at-tail');
      expect(textDelta).toBeUndefined();
      expect(finishMessage?.value).toMatchObject({ finishReason: 'unknown' });
    });

    it('does not split surrogate pairs at either preview boundary', () => {
      const output = `HEAD-${'🙂'.repeat(6000)}-TAIL`;
      const bounded = boundToolOutputForModel('filesystem.search_files', output).output as {
        preview?: string;
      };
      const preview = bounded.preview ?? '';

      // Balanced retention (was head-only): both ends of the source survive.
      expect(preview.startsWith('HEAD-')).toBe(true);
      expect(preview.endsWith('-TAIL')).toBe(true);
      expect(preview).not.toContain('�');
      // No lone surrogate at either cut point: every high surrogate is
      // immediately followed by its low-surrogate partner.
      for (let index = 0; index < preview.length; index += 1) {
        const codeUnit = preview.charCodeAt(index);
        if (codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff) {
          const next = preview.charCodeAt(index + 1);
          expect(next).toBeGreaterThanOrEqual(0xdc_00);
          expect(next).toBeLessThanOrEqual(0xdf_ff);
        }
      }
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

    it('preserves a legacy bounded oversized tool result that fits the active budget', () => {
      const boundedResult = {
        code: TOOL_RESULT_TOO_LARGE_CODE,
        error: 'filesystem.search_files returned too much output',
        maxLength: 12_000,
        originalLength: 80_000,
        preview: 'bounded preview',
        truncated: true,
      };
      const bounded = boundToolOutputForModel('filesystem.search_files', boundedResult);

      expect(bounded.output).toEqual(boundedResult);
      expect(bounded.errorText).toBe(boundedResult.error);
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
        messageId: 'msg-iterator-throws',
        sessionId: 'iterator-throws-test',
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

it('forwards executionContext through the LIVE approval data part (BST-1070 §2.2 transport)', async () => {
  // handleToolApprovalRequired rebuilds the approval data part FIELD BY
  // FIELD, so a field it does not spread is silently dropped — and the
  // failure mode is precisely backwards (live approvals degrade while
  // rediscovered ones, recomputed server-side, keep working). This test is
  // the live-stream transport proof the design requires.
  const executionContext = {
    allowedDomains: [],
    allowRead: [],
    allowWrite: [],
    defaultReadAccess: 'permissive',
    executorKind: 'fence',
    language: 'python',
    policyFingerprint: 'fp-live-transport',
    scratchParentDir: '/tmp',
    timeoutMs: 30_000,
  } as const;
  const chunks: StreamChunk[] = [
    {
      args: { code: 'print(1)' },
      executionContext,
      runId: 'run-live-context',
      toolCallId: 'call-live-context',
      toolName: 'brainstrike.runPython',
      type: 'tool-approval-required',
    },
    { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
  ];

  const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
    messageId: 'msg-live-context',
    sessionId: 'sess-live-context',
  });

  const parsed = parseLines(await readResponse(session.createResponse()));
  const approvalPart = parsed.find(
    (entry) =>
      entry.code === 'aui-data' && JSON.stringify(entry.value).includes('brainstrike.tool-approval')
  );
  expect(approvalPart).toBeDefined();
  const data = (approvalPart?.value as { data?: Record<string, unknown> })?.data;
  expect(data?.['executionContext']).toStrictEqual(executionContext);
});

it('forwards the host leg through BOTH live pause data parts (approval and suspend)', async () => {
  // Same field-by-field rebuild hazard as executionContext above, on the field
  // the history topology adapter anchors a suspended message with: the DURABLE
  // host leg the pause was surfaced by. Dropping it here strands every live
  // pause echo with no anchor (the native `runId` beside it never matches a
  // thread-run row).
  const chunks: StreamChunk[] = [
    {
      hostRunId: 'run-host-leg-1',
      runId: '2cc9a50d-0a91-45b6-b6b2-9e8b42f47039',
      toolCallId: 'call-approval',
      toolName: 'brainstrike.executeCommand',
      type: 'tool-approval-required',
    },
    {
      hostRunId: 'run-host-leg-1',
      runId: '2cc9a50d-0a91-45b6-b6b2-9e8b42f47039',
      suspendPayload: { question: 'Which region?' },
      toolCallId: 'call-suspend',
      toolName: 'brainstrike.askUser',
      type: 'tool-suspend-required',
    },
    { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
  ];

  const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
    messageId: 'msg-live-host-leg',
    sessionId: 'sess-live-host-leg',
  });

  const parsed = parseLines(await readResponse(session.createResponse()));
  const readPart = (name: string) => {
    const part = parsed.find(
      (entry) => entry.code === 'aui-data' && JSON.stringify(entry.value).includes(name)
    );
    return (part?.value as { data?: Record<string, unknown> })?.data;
  };
  expect(readPart('brainstrike.tool-approval')?.['hostRunId']).toBe('run-host-leg-1');
  expect(readPart('brainstrike.tool-suspend')?.['hostRunId']).toBe('run-host-leg-1');
});
