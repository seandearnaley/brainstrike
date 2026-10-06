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
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const latestUser = options.prompt.findLastIndex((message) => message.role === 'user');
      const completed = new Set(
        options.prompt
          .slice(latestUser)
          .flatMap((message) =>
            message.role === 'tool'
              ? message.content
                  .filter((part) => part.type === 'tool-result')
                  .map((part) => part.toolCallId)
              : []
          )
      );
      const step = calls.findIndex((_call, index) => !completed.has(`recorded-call-${index + 1}`));
      const call = calls[step];
      const chunks: Chunk[] = call
        ? [
            { type: 'stream-start', warnings: [] },
            {
              input: JSON.stringify(call.input),
              toolCallId: `recorded-call-${step + 1}`,
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

export function parallelToolModel(toolId: string): MockLanguageModelV4 {
  const finished = scriptedModel();
  return new MockLanguageModelV4({
    doStream: async (options) => {
      if (
        options.prompt.some(
          (message) =>
            message.role === 'tool' && message.content.some((part) => part.type === 'tool-result')
        )
      ) {
        return finished.doStream(options);
      }
      const chunks: Chunk[] = [
        { type: 'stream-start', warnings: [] },
        ...[1, 2].map(
          (index): Chunk => ({
            input: JSON.stringify({ text: `owned-action-${index}` }),
            toolCallId: `parallel-call-${index}`,
            toolName: toolId,
            type: 'tool-call',
          })
        ),
        { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
      ];
      return {
        stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
      };
    },
  });
}
