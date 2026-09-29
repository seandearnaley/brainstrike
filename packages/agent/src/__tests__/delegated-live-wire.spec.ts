import {
  type AssistantMessage,
  AssistantMessageAccumulator,
  DataStreamDecoder,
} from 'assistant-stream';
import { expect, it } from 'vitest';
import type { EncodedChunk } from '../stream/data-stream-codes';
import { DataStreamMapper } from '../stream/data-stream-mapper';

it('publishes child data immediately without ending parent text', async () => {
  const mapper = new DataStreamMapper('parent');
  const frames: EncodedChunk[] = [
    ...mapper.initialChunks(),
    ...mapper.handleChunk({ type: 'text-delta', value: 'Before ' }),
  ];
  const child = [
    ...mapper.handleChunk({
      chunk: { type: 'text-delta', value: 'Child is live' },
      identity: {
        childRuntimeRunId: 'child-run',
        parentRuntimeRunId: 'parent-run',
        parentToolCallId: 'delegate',
        personaId: 'explore',
      },
      messageId: 'child',
      type: 'delegated-conversation-chunk',
    }),
  ];
  expect(child).toHaveLength(1);
  expect(child[0]?.code).toBe('2');
  frames.push(...child, ...mapper.handleChunk({ type: 'text-delta', value: 'after.' }));
  const response = new Response(
    frames.map(({ code, value }) => `${code}:${JSON.stringify(value)}\n`).join('') +
      'd:{"finishReason":"stop","usage":{"promptTokens":0,"completionTokens":0}}\n'
  );
  if (!response.body) {
    throw new Error('Missing body');
  }
  let last: AssistantMessage | undefined;
  for await (const message of response.body
    .pipeThrough(new DataStreamDecoder())
    .pipeThrough(new AssistantMessageAccumulator())) {
    last = message;
  }
  expect(last?.parts.filter((part) => part.type === 'text')).toMatchObject([
    { text: 'Before after.' },
  ]);
});
