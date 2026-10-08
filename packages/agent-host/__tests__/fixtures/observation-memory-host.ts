import { randomUUID } from 'node:crypto';
import { MastraCompositeStore } from '@mastra/core/storage';
import type { UpsertVectorParams } from '@mastra/core/vector';
import { Memory } from '@mastra/memory';
import { TokenCounter } from '@mastra/memory/processors';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { committedMemoryTranscript } from '../../src/adapters/committed-memory-transcript.js';
import { StateStoreMemoryStorage } from '../../src/adapters/memory-storage.js';
import { memoryVectorHost, RecordedVectorCalls } from './memory-vector-host.js';

class RecordedObservationCalls extends RecordedVectorCalls {
  override async upsert(params: UpsertVectorParams): Promise<string[]> {
    this.upserts.push(structuredClone(params));
    if (!params.ids) {
      throw new Error('Native observation call requires its original vector IDs');
    }
    return [...params.ids];
  }
}

/** Causal public-vendor fixture over genuine committed Core/SQLite transcript.
 * The recording vector is only a call receipt, not derived-index qualification.
 */
export async function observationMemoryHost(scope: 'thread' | 'resource') {
  const host = await memoryVectorHost({});
  const threads: string[] = [];
  for (const prompt of ['Paris observation source.', 'Paris sibling observation source.']) {
    const { threadId } = await host.core.startThread({ commandId: randomUUID() });
    threads.push(threadId);
    await host.run(threadId, prompt);
  }
  const threadId = threads[0];
  if (!threadId) {
    throw new Error('Observation source requires its committed owner thread');
  }
  const read = async () =>
    committedMemoryTranscript(
      (await Promise.all(threads.map((id) => host.core.read(id, 0)))).flat(),
      host.resourceId
    );
  const domain = new StateStoreMemoryStorage(host.resourceId, host.store, { read }, threadId);
  const storage = new MastraCompositeStore({ domains: { memory: domain }, id: host.resourceId });
  await storage.init();
  const observer = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'observation-text', type: 'text-start' },
          {
            delta:
              scope === 'resource'
                ? `<observations>\n${threads.map((id) => `<thread id="${id}">\n- Synthetic Paris observation.\n</thread>`).join('\n')}\n</observations>`
                : '<observations>\n- Synthetic Paris observation.\n</observations>',
            id: 'observation-text',
            type: 'text-delta',
          },
          { id: 'observation-text', type: 'text-end' },
          {
            finishReason: { raw: 'stop', unified: 'stop' },
            type: 'finish',
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 42, total: 42 },
              outputTokens: { reasoning: 0, text: 9, total: 9 },
            },
          },
        ],
        initialDelayInMs: null,
      }),
    }),
  });
  const vector = new RecordedObservationCalls();
  const source = await read();
  const tokenCounter = new TokenCounter();
  const messageTokens =
    scope === 'resource'
      ? Math.max(
          ...(await Promise.all(
            threads.map((id) =>
              tokenCounter.countMessagesAsync(source.filter((message) => message.threadId === id))
            )
          ))
        ) + 1
      : 1;
  const memory = new Memory({
    embedder: host.embedder,
    options: {
      generateTitle: false,
      observationalMemory: {
        model: observer,
        observation: { bufferOnIdle: false, bufferTokens: false, messageTokens },
        reflection: { observationTokens: 50_000 },
        retrieval: { vector: true },
        scope,
      },
      semanticRecall: false,
      workingMemory: { enabled: false },
    },
    storage,
    vector,
  });
  const engine = await memory.omEngine;
  if (!engine) {
    throw new Error('Actual pinned Memory did not create its native observation engine');
  }
  if (scope === 'resource') {
    const record = await engine.getOrCreateRecord(threadId, host.resourceId);
    await domain.setPendingMessageTokens(record.id, messageTokens);
  }
  return {
    async close(): Promise<void> {
      const outcomes = await Promise.allSettled([engine.settled()]);
      for (const close of [() => storage.close(), () => host.close()]) {
        outcomes.push(...(await Promise.allSettled([close()])));
      }
      const causes = outcomes.filter((r) => r.status === 'rejected').map((r) => r.reason);
      if (causes.length) {
        throw new AggregateError(causes, 'Observation causal fixture cleanup failed');
      }
    },
    domain,
    engine,
    host,
    memory,
    observer,
    read,
    scope,
    storage,
    threadId,
    threads,
    vector,
  };
}
