import { randomUUID } from 'node:crypto';
import { MastraCompositeStore } from '@mastra/core/storage';
import type { UpsertVectorParams } from '@mastra/core/vector';
import { Memory } from '@mastra/memory';
import { TokenCounter } from '@mastra/memory/processors';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { onTestFinished } from 'vitest';
import { committedMemoryTranscript } from '../../src/adapters/committed-memory-transcript.js';
import { StateStoreMemoryStorage } from '../../src/adapters/memory-storage.js';
import { StateStoreObservationMemory } from '../../src/adapters/state-store-observation-memory.js';
import { StateStoreObservationVector } from '../../src/adapters/state-store-observation-vector.js';
import { memoryVectorHost, RecordedVectorCalls } from './memory-vector-host.js';
import { RECORDED_VECTOR_PROFILE } from './recorded-memory-vector-port.js';

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
export async function observationMemoryHost(
  scope: 'thread' | 'resource',
  options: {
    readonly realIndexer?: boolean;
    readonly stateProjectionModule?: string;
    readonly buffered?: boolean;
    readonly beforeEmbedding?: (
      values: readonly string[],
      signal: AbortSignal | undefined
    ) => Promise<void>;
  } = {}
) {
  const host = await memoryVectorHost({
    ...(options.beforeEmbedding ? { beforeEmbedding: options.beforeEmbedding } : {}),
    ...(options.realIndexer ? { realIndexer: true } : {}),
    ...(options.realIndexer
      ? {
          stateProjectionModule:
            options.stateProjectionModule ??
            new URL('./observation-state-projection.mjs', import.meta.url).href,
        }
      : {}),
  });
  const cleanup: (() => Promise<void>)[] = [() => host.close()];
  let closing: Promise<void> | undefined;
  const retire = async () => {
    const causes: unknown[] = [];
    for (const retire of [...cleanup].reverse()) {
      try {
        await retire();
      } catch (cause) {
        causes.push(cause);
      }
    }
    if (causes.length) {
      throw new AggregateError(causes, 'Observation causal fixture cleanup failed');
    }
  };
  const close = (): Promise<void> => (closing ??= retire());
  try {
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
    cleanup.push(() => storage.close());
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
                  ? `<observations>\n${threads.map((id, ordinal) => `<thread id="${id}">\n- Synthetic Paris observation ${ordinal}.\n</thread>`).join('\n')}\n</observations>`
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
    const controller = new AbortController();
    const recording = new RecordedObservationCalls();
    const vector =
      options.realIndexer && host.indexer
        ? new StateStoreObservationVector({
            port: host.indexer,
            profile: RECORDED_VECTOR_PROFILE,
            scope: { resourceId: host.resourceId, rootId: host.root, threadId },
            signal: controller.signal,
          })
        : recording;
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
    const native = {
      embedder: host.embedder,
      options: {
        generateTitle: false,
        observationalMemory: {
          model: observer,
          observation: {
            bufferOnIdle: false,
            bufferTokens: options.buffered ? 1 : false,
            messageTokens: options.buffered ? 100 : messageTokens,
          },
          reflection: { observationTokens: 50_000 },
          retrieval: { vector: true },
          scope,
        },
        semanticRecall: false,
        workingMemory: { enabled: false },
      },
      storage,
      vector,
    } satisfies ConstructorParameters<typeof Memory>[0];
    const memory =
      vector instanceof StateStoreObservationVector
        ? new StateStoreObservationMemory(native, vector)
        : new Memory(native);
    const engine = await memory.omEngine;
    if (!engine) {
      throw new Error('Actual pinned Memory did not create its native observation engine');
    }
    cleanup.push(() => engine.settled());
    onTestFinished(async ({ signal }) => {
      if (signal.aborted) {
        controller.abort(signal.reason);
      }
      await close();
    });
    if (scope === 'resource') {
      const record = await engine.getOrCreateRecord(threadId, host.resourceId);
      await domain.setPendingMessageTokens(record.id, messageTokens);
    }
    return {
      close,
      controller,
      domain,
      engine,
      host,
      memory,
      native,
      observer,
      read,
      recording,
      async reopenObservations() {
        await engine.settled();
        await storage.close();
        await host.reopen();
        const port = host.indexer;
        if (!port) {
          throw new Error('Reopen requires the actual retained indexer profile');
        }
        const nextDomain = new StateStoreMemoryStorage(
          host.resourceId,
          host.store,
          { read },
          threadId
        );
        const nextStorage = new MastraCompositeStore({
          domains: { memory: nextDomain },
          id: host.resourceId,
        });
        cleanup.push(() => nextStorage.close());
        await nextStorage.init();
        const nextVector = new StateStoreObservationVector({
          port,
          profile: RECORDED_VECTOR_PROFILE,
          scope: { resourceId: host.resourceId, rootId: host.root, threadId },
          signal: controller.signal,
        });
        return new StateStoreObservationMemory(
          {
            ...native,
            options: { observationalMemory: false, semanticRecall: false },
            storage: nextStorage,
            vector: nextVector,
          },
          nextVector
        );
      },
      scope,
      storage,
      threadId,
      threads,
      vector,
    };
  } catch (cause) {
    try {
      await close();
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        'Observation fixture setup and cleanup failed'
      );
    }
    throw cause;
  }
}
