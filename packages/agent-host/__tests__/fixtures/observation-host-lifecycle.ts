import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import {
  createStateStoreIndexer,
  openIndexer,
  type StateMessageVectorPort,
  type StateObservationVectorPort,
} from '@brainstrike/indexer';
import type { StateStore } from '@brainstrike/state-store';
import type { MastraDBMessage } from '@mastra/core/agent';
import { TokenCounter } from '@mastra/memory/processors';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { onTestFinished } from 'vitest';
import { committedMemoryTranscript } from '../../src/adapters/committed-memory-transcript.js';
import type { StateStoreHostMemory } from '../../src/adapters/state-store-host-memory.js';
import { attachAgentHost, type HostClient } from '../../src/client.js';
import type { HostPlatform, HostRunContext } from '../../src/ports.js';
import type { AgentHost } from '../../src/runtime.js';
import { deterministicEmbedding, failureReceipt } from './memory-vector-host.js';
import { RECORDED_VECTOR_PROFILE } from './recorded-memory-vector-port.js';
import { scriptedModel } from './scripted-model.js';

function checkpoint<Value>() {
  const value = Promise.withResolvers<Value>();
  value.promise.catch(() => undefined);
  return value;
}

type ObservationBoundary = 'both' | 'inference' | 'vector' | 'two-inference';

function observationKind(boundary: ObservationBoundary, ordinal: number): string {
  if (boundary === 'two-inference') {
    return ordinal > 0 ? 'held inference sibling' : 'held inference';
  }
  if (boundary !== 'both' && ordinal > 0) {
    return 'completed sibling';
  }
  return boundary === 'vector' || ordinal > 0 ? 'held vector' : 'held inference';
}

/** Actual Root/Core/StateStoreHostMemory construction. Only provider responses and
 * independently held concrete capability tails are controlled by the test.
 * The indexer loads Studio's public production producer, never a fixture module.
 */
export async function observationHostLifecycle(
  boundary: ObservationBoundary = 'both',
  traceSelection?: (bucket: {
    messages: readonly MastraDBMessage[];
    threadId: string | undefined;
  }) => void
) {
  const require = createRequire(import.meta.url);
  const { startAgentHost, StateStoreHostMemory }: typeof import('../../src/index.js') =
    await import(pathToFileURL(require.resolve('@brainstrike/agent-host')).href);
  const producerModule = pathToFileURL(
    require.resolve('@brainstrike/agent-host/state-projection')
  ).href;
  const producer: unknown = await import(producerModule);
  if (
    !(
      producer &&
      typeof producer === 'object' &&
      typeof Reflect.get(producer, 'observations') === 'function' &&
      typeof Reflect.get(producer, 'observationChunks') === 'function'
    )
  ) {
    throw new Error('Lifecycle qualification requires Studio production observation exports');
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-observation-host-')));
  const resourceId = randomUUID();
  const enteredInference = checkpoint<AbortSignal | undefined>();
  const inferenceRelease = checkpoint<void>();
  const inferenceReleases = [checkpoint<void>(), checkpoint<void>()];
  const inferenceCompleted = [checkpoint<void>(), checkpoint<void>()];
  const enteredVector = checkpoint<void>();
  const vectorRelease = checkpoint<void>();
  const vectorCompleted = checkpoint<void>();
  const unheldCompleted = checkpoint<void>();
  const aborted = checkpoint<AbortSignal>();
  const contexts: HostRunContext[] = [];
  const owners: StateStoreHostMemory[] = [];
  const prepares: string[] = [];
  const writes: { groupId: string; ids: readonly string[]; afterAbort: boolean }[] = [];
  const embeddingSignals: (AbortSignal | undefined)[] = [];
  const inferenceCalls: {
    signal: AbortSignal | undefined;
    values: readonly string[];
    retired: boolean;
    afterAbort: boolean;
  }[] = [];
  const pending = new Set<Promise<unknown>>();
  const progress = new Set<(cause: unknown) => void>([
    enteredInference.reject,
    enteredVector.reject,
    vectorCompleted.reject,
    unheldCompleted.reject,
    aborted.reject,
    ...inferenceCompleted.map(({ reject }) => reject),
  ]);
  const threads: string[] = [];
  let threshold = 1;
  let observations = false;
  let hold = false;
  let inferenceRetired = false;
  let vectorRetired = false;
  let indexer: Awaited<ReturnType<typeof openIndexer>> | undefined;
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  let store: StateStore | undefined;
  let closing: Promise<void> | undefined;
  const observer = recordedObservationModel(threads, boundary);
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      inferenceRelease.resolve();
      for (const release of inferenceReleases) {
        release.resolve();
      }
      vectorRelease.resolve();
      await host?.close();
      await Promise.allSettled([...pending]);
      await client?.close();
      await rm(root, { force: true, recursive: true });
    })());
  onTestFinished(async ({ signal }) => {
    if (signal.aborted) {
      for (const reject of progress) {
        reject(signal.reason);
      }
    }
    await close();
  });
  try {
    host = await startAgentHost({ lifetime: 'persistent', root }, async (startup) => {
      store = startup.store;
      await startup.register(async () => {
        await indexer?.close();
      });
      indexer = await openIndexer(
        {
          dbPath: join(root, 'index.sqlite'),
          embedding: { indexMode: 'text-only' },
          rootIds: [root],
          stateProjection: { mode: 'dev', module: producerModule },
          stateResources: [{ resourceId, rootId: root }],
          stateRoot: root,
        },
        { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
      );
      const writer = indexer;
      const port: StateMessageVectorPort & StateObservationVectorPort = {
        prepareStateMessageVectors: (input) => writer.prepareStateMessageVectors(input),
        prepareStateObservationVectors: async (input) => {
          const plan = await writer.prepareStateObservationVectors(input);
          prepares.push(plan.observation.groupId);
          return plan;
        },
        purgeStateMessageVectors: (input) => writer.purgeStateMessageVectors(input),
        purgeStateObservationVectors: (input) => writer.purgeStateObservationVectors(input),
        queryStateMessageVectors: (input) => writer.queryStateMessageVectors(input),
        queryStateObservationVectors: (input) => writer.queryStateObservationVectors(input),
        upsertStateMessageVectors: (input) => writer.upsertStateMessageVectors(input),
        upsertStateObservationVectors: async (input) => {
          const tail = (async () => {
            if (hold && input.plan.observation.text.includes('held vector')) {
              enteredVector.resolve();
              await vectorRelease.promise;
            }
            const ids = await writer.upsertStateObservationVectors(input);
            writes.push({
              afterAbort: contexts.at(-1)?.signal.aborted ?? false,
              groupId: input.plan.observation.groupId,
              ids,
            });
            vectorRetired = true;
            vectorCompleted.resolve();
            if (input.plan.observation.text.includes('completed sibling')) {
              unheldCompleted.resolve();
            }
            return ids;
          })();
          pending.add(tail);
          tail.finally(() => pending.delete(tail)).catch(() => undefined);
          return tail;
        },
      };
      return {
        close: async () => undefined,
        maxSteps: 1,
        openRun: async (context) => {
          contexts.push(context);
          if (observations) {
            context.signal.addEventListener('abort', () => aborted.resolve(context.signal), {
              once: true,
            });
          }
          try {
            const bridge = observations
              ? StateStoreHostMemory.createObservationVectorBridge({
                  port,
                  profile: RECORDED_VECTOR_PROFILE,
                  scope: { resourceId, rootId: root, threadId: context.threadId },
                  signal: context.signal,
                })
              : undefined;
            const owner = await StateStoreHostMemory.open(context, {
              recordPrompt: async () => undefined,
              resourceId,
              store: startup.store,
              ...(bridge ? { vectorBridge: bridge } : {}),
              native: {
                ...(bridge
                  ? {
                      embedder: {
                        doEmbed: async ({ values, abortSignal }) => {
                          const ordinal = inferenceCalls.length;
                          const call = {
                            afterAbort: false,
                            retired: false,
                            signal: abortSignal,
                            values: [...values],
                          };
                          inferenceCalls.push(call);
                          embeddingSignals.push(abortSignal);
                          if (!prepares.length) {
                            throw new Error('Native embedding preceded committed preparation');
                          }
                          if (hold && values.some((text) => text.includes('held inference'))) {
                            if (boundary !== 'two-inference' || inferenceCalls.length === 2) {
                              enteredInference.resolve(abortSignal);
                            }
                            if (boundary === 'two-inference') {
                              const release = inferenceReleases[ordinal];
                              if (!release) {
                                throw new Error('Independent inference release is absent');
                              }
                              await release.promise;
                            } else {
                              await inferenceRelease.promise;
                            }
                            inferenceRetired = true;
                          }
                          call.retired = true;
                          call.afterAbort = abortSignal?.aborted ?? false;
                          inferenceCompleted[ordinal]?.resolve();
                          return {
                            embeddings: values.map(deterministicEmbedding),
                            usage: { tokens: values.length },
                            warnings: [],
                          };
                        },
                        maxEmbeddingsPerCall: 1,
                        modelId: RECORDED_VECTOR_PROFILE.modelId,
                        provider: 'local-fixture',
                        specificationVersion: 'v3',
                        supportsParallelCalls: true,
                      },
                      vector: bridge,
                    }
                  : {}),
                options: {
                  generateTitle: false,
                  lastMessages: false,
                  observationalMemory: {
                    ...(traceSelection
                      ? {
                          hooks: {
                            beforeObservation: ({ messages, threadId }) => {
                              traceSelection({ messages, threadId });
                            },
                          },
                        }
                      : {}),
                    model: observer,
                    observation: {
                      bufferOnIdle: false,
                      bufferTokens: false,
                      messageTokens: observations ? threshold : 50_000,
                    },
                    reflection: { observationTokens: 50_000 },
                    retrieval: observations ? { vector: true } : false,
                    scope: 'resource',
                  },
                  semanticRecall: false,
                  workingMemory: { enabled: false },
                },
              },
            });
            owners.push(owner);
            return owner;
          } catch (cause) {
            console.error(
              'Observation owner opening failure:',
              JSON.stringify(failureReceipt(cause))
            );
            for (const reject of progress) {
              reject(cause);
            }
            throw cause;
          }
        },
        readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
        resolveModel: async () => scriptedModel(),
        stateIndexer: createStateStoreIndexer(writer),
        tools: {},
      } satisfies HostPlatform;
    });
    const core = host.core;
    client = await attachAgentHost(host.record);
    const connection = client;
    const run = async (threadId: string, prompt: string, complete: boolean) => {
      const finished = checkpoint<void>();
      progress.add(finished.reject);
      const unsubscribe = core.onCommitted((row) => {
        if (row.threadId === threadId && row.event.type === 'run.finished') {
          finished.resolve();
        }
      });
      try {
        const ids = await connection.request('run/start', {
          commandId: randomUUID(),
          modelId: 'recorded-sdk-fixture',
          prompt,
          threadId,
        });
        if (complete) {
          await finished.promise;
        }
        return { runId: ids.runId, threadId };
      } finally {
        unsubscribe();
        progress.delete(finished.reject);
      }
    };
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      const { threadId } = await connection.request('thread/start', { commandId: randomUUID() });
      threads.push(threadId);
      await run(threadId, 'Paris committed observation source. '.repeat(30), true);
    }
    const source = committedMemoryTranscript(
      (await Promise.all(threads.map((id) => core.read(id, 0)))).flat(),
      resourceId
    );
    const counter = new TokenCounter();
    threshold =
      Math.max(
        ...(await Promise.all(
          threads.map((id) =>
            counter.countMessagesAsync(source.filter((message) => message.threadId === id))
          )
        ))
      ) + 16;
    observations = true;
    hold = true;
    prepares.length = 0;
    writes.length = 0;
    return {
      aborted,
      client: connection,
      close,
      contexts,
      core,
      embeddingSignals,
      enteredInference,
      enteredVector,
      host,
      indexer,
      inferenceCalls,
      inferenceCompleted,
      inferenceRelease,
      inferenceReleases,
      inferenceRetired: () => inferenceRetired,
      observationThreshold: () => threshold,
      owners,
      prepares,
      resourceId,
      root,
      start: async () => {
        const threadId = threads[0];
        if (!threadId) {
          throw new Error('Committed owner thread is absent');
        }
        return run(threadId, 'Continue Paris.', false);
      },
      store,
      threads,
      unheldCompleted,
      vectorCompleted,
      vectorRelease,
      vectorRetired: () => vectorRetired,
      writes,
    };
  } catch (cause) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Observation Root setup and cleanup failed');
    }
    throw cause;
  }
}

export function recordedObservationModel(
  threads: readonly string[],
  boundary: ObservationBoundary = 'both'
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'observations', type: 'text-start' },
          {
            delta: `<observations>\n${threads
              .map(
                (threadId, ordinal) =>
                  `<thread id="${threadId}">\n- Paris ${observationKind(boundary, ordinal)} observation.\n</thread>`
              )
              .join('\n')}\n</observations>`,
            id: 'observations',
            type: 'text-delta',
          },
          { id: 'observations', type: 'text-end' },
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
}
