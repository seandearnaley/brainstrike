import type { HostPlatform } from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;

/** Deltas in the scripted answer; with the per-chunk delay below, about a second of streaming. */
export const STREAMED_DELTAS = 500;

/** Only the model is scripted: it streams a long answer, a chunk at a time, into the real host. */
export function createHostPlatform(): HostPlatform {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const deltas = Array.from(
        { length: STREAMED_DELTAS },
        (_, index): Chunk => ({ delta: `token-${index} `, id: 'text-1', type: 'text-delta' })
      );
      const chunks: Chunk[] = [
        { type: 'stream-start', warnings: [] },
        { id: 'text-1', type: 'text-start' },
        ...deltas,
        { id: 'text-1', type: 'text-end' },
        {
          finishReason: { raw: 'stop', unified: 'stop' },
          type: 'finish',
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
            outputTokens: { reasoning: 0, text: STREAMED_DELTAS, total: STREAMED_DELTAS },
          },
        },
      ];
      return {
        stream: simulateReadableStream({ chunkDelayInMs: 2, chunks, initialDelayInMs: null }),
      };
    },
  });
  return {
    close: async () => undefined,
    maxSteps: 1,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {},
  };
}
