import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
// Same real SDK tool-call/finish payload shape as the existing agent runtime fixtures,
// represented by the pinned provider v4 contract. Only the model is scripted.
export function scriptedModel(toolId?: string): MockLanguageModelV4 {
  return scriptedToolSequence(
    toolId ? [{ input: { text: 'written by permitted host tool' }, toolId }] : []
  );
}

export function scriptedToolSequence(
  calls: readonly { readonly toolId: string; readonly input: unknown }[]
): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const call = calls[step++];
      const chunks: Chunk[] = call
        ? [
            { type: 'stream-start', warnings: [] },
            {
              input: JSON.stringify(call.input),
              toolCallId: `recorded-call-${step}`,
              toolName: call.toolId,
              type: 'tool-call',
            },
            { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { id: 'text-1', type: 'text-start' },
            { delta: 'Host run completed.', id: 'text-1', type: 'text-delta' },
            { id: 'text-1', type: 'text-end' },
            { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
          ];
      return {
        stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
      };
    },
  });
}
