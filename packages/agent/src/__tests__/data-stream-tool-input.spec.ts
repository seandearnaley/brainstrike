import {
  type AssistantMessage,
  AssistantMessageAccumulator,
  DataStreamDecoder,
} from 'assistant-stream';
import { describe, expect, it } from 'vitest';
import { createStatelessAssistantDataStreamResponse } from '../stream/data-stream';
import { DataStreamMapper } from '../stream/data-stream-mapper';
import { mapMastraToolEvent } from '../tool-projection/tool-event-mapper';
import type { StreamChunk } from '../types';

async function decodeMessage(chunks: StreamChunk[]) {
  const response = createStatelessAssistantDataStreamResponse({
    async *[Symbol.asyncIterator]() {
      yield* chunks;
      yield {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      };
    },
  });
  if (!response.body) {
    throw new Error('Missing stream body');
  }
  let last: AssistantMessage | undefined;
  for await (const message of response.body
    .pipeThrough(new DataStreamDecoder())
    .pipeThrough(new AssistantMessageAccumulator())) {
    last = message;
  }
  return last;
}

async function decodeTool(chunks: StreamChunk[]) {
  return (await decodeMessage(chunks))?.parts.find((part) => part.type === 'tool-call');
}

const args = { limit: 2, paths: ['src'], pattern: 'flag' };
const call = { name: 'brainstrike.grepSearch', type: 'tool-event' } as const;
const id = { toolCallId: 'call' };

describe('tool input through the installed assistant-stream decoder', () => {
  it.each(['approval', 'success', 'error', 'declined'] as const)(
    'completes authoritative empty containers before %s',
    async (terminal) => {
      for (const input of [{}, []]) {
        const chunks: StreamChunk[] = [
          { ...call, payload: { ...id, step: 'input_stream_start' }, status: 'progress' },
          {
            ...call,
            payload: {
              ...id,
              argsTextDelta: JSON.stringify(input).slice(0, 1),
              step: 'input_stream_delta',
            },
            status: 'progress',
          },
        ];
        chunks.push(
          terminal === 'approval'
            ? {
                args: input,
                runId: 'run',
                toolCallId: 'call',
                toolName: call.name,
                type: 'tool-approval-required',
              }
            : { ...call, payload: { ...id, args: input, result: {} }, status: terminal }
        );
        const tool = await decodeTool(chunks);
        expect(tool?.argsText).toBe(JSON.stringify(input));
        expect(JSON.stringify(tool?.args)).toBe(JSON.stringify(input));
      }
    }
  );

  it('retains complete native tool-error arguments through the production mapper', async () => {
    const terminal = mapMastraToolEvent(
      {
        payload: {
          args: { pattern: 'flag' },
          error: new Error('search failed'),
          toolCallId: 'call',
          toolName: call.name,
        },
        type: 'tool-error',
      },
      new Map()
    );
    if (!terminal) {
      throw new Error('Native tool-error did not map');
    }
    const tool = await decodeTool([
      { ...call, payload: { ...id, step: 'input_stream_start' }, status: 'progress' },
      {
        ...call,
        payload: { ...id, argsTextDelta: '{"pattern":', step: 'input_stream_delta' },
        status: 'progress',
      },
      terminal,
    ]);
    expect(tool?.args).toMatchObject({ pattern: 'flag' });
    expect(tool?.argsText).toBe('{"pattern":"flag"}');
  });

  it.each(['success', 'error', 'declined'] as const)(
    'does not reinterpret a %s output or error as tool input',
    async (status) => {
      const tool = await decodeTool([
        { ...call, payload: { ...id, step: 'input_stream_start' }, status: 'progress' },
        {
          ...call,
          payload: { ...id, argsTextDelta: JSON.stringify(args), step: 'input_stream_delta' },
          status: 'progress',
        },
        {
          ...call,
          payload: { ...id, error: { message: 'failed' }, result: { matches: ['found'] } },
          status,
        },
      ]);
      expect(tool?.args).toMatchObject(args);
    }
  );

  it('retains partial input when no authoritative complete input exists', async () => {
    const prefix = '{"pattern":"fl';
    const tool = await decodeTool([
      { ...call, payload: { ...id, step: 'input_stream_start' }, status: 'progress' },
      {
        ...call,
        payload: { ...id, argsTextDelta: prefix, step: 'input_stream_delta' },
        status: 'progress',
      },
      { ...call, payload: { ...id, result: {} }, status: 'error' },
    ]);
    expect(tool?.argsText).toBe(prefix);
  });

  it.each([
    ['{"different":', { pattern: 'flag' }],
    ['{"pattern":"caf\\u00e', { pattern: 'café' }],
    ['{"limit":1 ', { limit: 10 }],
  ] as const)(
    'retains prior text and visibly fails an incompatible input %s',
    async (prefix, input) => {
      const message = await decodeMessage([
        { type: 'text-delta', value: 'Before failure.' },
        { ...call, payload: { ...id, step: 'input_stream_start' }, status: 'progress' },
        {
          ...call,
          payload: { ...id, argsTextDelta: prefix, step: 'input_stream_delta' },
          status: 'progress',
        },
        { ...call, payload: { ...id, args: input, result: {} }, status: 'success' },
      ]);
      expect(message?.status).toMatchObject({ reason: 'error', type: 'incomplete' });
      expect(message?.parts).toContainEqual(
        expect.objectContaining({ text: 'Before failure.', type: 'text' })
      );
    }
  );

  it('closes mismatched input once so the session can publish its terminal error', () => {
    const mapper = new DataStreamMapper('mismatch-message');
    Array.from(
      mapper.handleChunk({
        ...call,
        payload: { ...id, step: 'input_stream_start' },
        status: 'progress',
      })
    );
    Array.from(
      mapper.handleChunk({
        ...call,
        payload: { ...id, argsTextDelta: '{"different":', step: 'input_stream_delta' },
        status: 'progress',
      })
    );
    expect(() => [
      ...mapper.handleChunk({ ...call, payload: { ...id, args }, status: 'success' }),
    ]).toThrow(/Complete tool input/);
    const terminalFrames = [...mapper.handleError(new Error('Complete tool input mismatch'))];
    expect(terminalFrames).toContainEqual({ code: '3', value: 'Complete tool input mismatch' });
    expect(mapper.didEmitFinish()).toBe(true);
  });

  it.each(['direct', 'late', 'streamed'] as const)(
    'retains %s complete input instead of closing an empty argument stream',
    async (mode) => {
      const chunks: StreamChunk[] = [];
      if (mode !== 'direct') {
        chunks.push({
          ...call,
          payload: { ...id, step: 'input_stream_start' },
          status: 'progress',
        });
      }
      if (mode === 'streamed') {
        chunks.push({
          ...call,
          payload: { ...id, argsTextDelta: JSON.stringify(args), step: 'input_stream_delta' },
          status: 'progress',
        });
      }
      chunks.push({ ...call, payload: { ...id, args }, status: 'start' });
      chunks.push({
        ...call,
        payload: { ...id, result: { matches: ['flag'] } },
        status: 'success',
      });
      expect(await decodeTool(chunks)).toMatchObject({
        args,
        result: { matches: ['flag'] },
        toolCallId: 'call',
      });
    }
  );

  it.each([false, true])(
    'retains approval arguments (input stream already open: %s)',
    async (started) => {
      const chunks: StreamChunk[] = started
        ? [{ ...call, payload: { ...id, step: 'input_stream_start' }, status: 'progress' }]
        : [];
      chunks.push({
        args,
        runId: 'run',
        toolCallId: 'call',
        toolName: call.name,
        type: 'tool-approval-required',
      });
      expect(await decodeTool(chunks)).toMatchObject({ args, toolCallId: 'call' });
    }
  );
  it.each(['approval', 'success', 'error', 'declined'] as const)(
    'completes partial argument text before %s',
    async (terminal) => {
      const chunks: StreamChunk[] = [
        { ...call, payload: { ...id, step: 'input_stream_start' }, status: 'progress' },
        {
          ...call,
          payload: { ...id, argsTextDelta: '{"pattern":', step: 'input_stream_delta' },
          status: 'progress',
        },
      ];
      const complete = { pattern: 'flag' };
      if (terminal === 'approval') {
        chunks.push({
          args: complete,
          runId: 'run',
          toolCallId: 'call',
          toolName: call.name,
          type: 'tool-approval-required',
        });
      } else {
        chunks.push({ ...call, payload: { ...id, args: complete, result: {} }, status: terminal });
      }
      expect(await decodeTool(chunks)).toMatchObject({ args: complete });
    }
  );
});
