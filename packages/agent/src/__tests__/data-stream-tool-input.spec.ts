import {
  type AssistantMessage,
  AssistantMessageAccumulator,
  DataStreamDecoder,
} from 'assistant-stream';
import { describe, expect, it } from 'vitest';
import { createStatelessAssistantDataStreamResponse } from '../stream/data-stream';
import type { StreamChunk } from '../types';

async function decodeTool(chunks: StreamChunk[]) {
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
  return last?.parts.find((part) => part.type === 'tool-call');
}

const args = { limit: 2, paths: ['src'], pattern: 'flag' };
const call = { name: 'brainstrike.grepSearch', type: 'tool-event' } as const;
const id = { toolCallId: 'call' };

describe('tool input through the installed assistant-stream decoder', () => {
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
});
