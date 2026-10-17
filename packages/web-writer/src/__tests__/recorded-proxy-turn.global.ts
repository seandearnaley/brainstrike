import {
  createStatelessAssistantDataStreamResponse,
  streamHostedWebTurn,
} from '@brainstrike/agent/hosted-web';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The data stream Hosted Web returns for one recorded turn, answering "Hello from the proxy". */
    recordedProxyTurn: string;
  }
}

/**
 * Hosted Web's turn is server code, so its response for a recorded turn is
 * made here, in Node, by its own turn and data stream over a scripted model,
 * and handed to the browser page as the wire a tab reads.
 */
export default async function setup(project: TestProject): Promise<void> {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 't1', type: 'text-start' },
          { delta: 'Hello ', id: 't1', type: 'text-delta' },
          { delta: 'from the proxy', id: 't1', type: 'text-delta' },
          { id: 't1', type: 'text-end' },
          {
            finishReason: { raw: 'stop', unified: 'stop' },
            type: 'finish',
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 11, total: 11 },
              outputTokens: { reasoning: 0, text: 7, total: 7 },
            },
          },
        ] as never,
        initialDelayInMs: null,
      }),
    }),
  });
  const stream = await streamHostedWebTurn({
    messages: [{ id: 'm0', parts: [{ text: 'Say hello', type: 'text' }], role: 'user' }],
    model,
    recordSteps: true,
  });
  project.provide(
    'recordedProxyTurn',
    await createStatelessAssistantDataStreamResponse(stream).text()
  );
}
