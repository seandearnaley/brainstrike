import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { RootLock, type StateStore } from '@brainstrike/state-store';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect, onTestFinished } from 'vitest';
import type { StateStoreHostMemoryOptions } from '../../src/adapters/state-store-host-memory.js';
import { attachAgentHost, type HostClient } from '../../src/client.js';
import type { HostLogRow } from '../../src/protocol.js';
import type { AgentHost } from '../../src/runtime.js';
import { deterministicEmbedding, failureReceipt } from './memory-vector-host.js';
import { RECORDED_VECTOR_PROFILE } from './recorded-memory-vector-port.js';

export const WORKING_FACT = '# Project facts\n- Working memory contribution: coding in Paris.';
export const OBSERVATION_FACT = 'Observation contribution: preserve the Paris coding decision.';
export const HISTORY_FACT = 'Paris committed source selected by real semantic recall.';

function recordedTextModel(
  modelId: string,
  text: string,
  inputTokens: number,
  outputTokens: number
) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'recorded-text', type: 'text-start' },
          { delta: text, id: 'recorded-text', type: 'text-delta' },
          { id: 'recorded-text', type: 'text-end' },
          {
            finishReason: { raw: 'stop', unified: 'stop' },
            type: 'finish',
            usage: {
              inputTokens: {
                cacheRead: 0,
                cacheWrite: 0,
                noCache: inputTokens,
                total: inputTokens,
              },
              outputTokens: { reasoning: 0, text: outputTokens, total: outputTokens },
            },
          },
        ],
        initialDelayInMs: null,
      }),
    }),
    modelId,
    provider: 'openai.responses',
  });
}

/** Actual emitted production admission, Core, SDK, public Memory and SQLite.
 * Only provider responses and their documented reported usage are scripted.
 */
export async function finalPromptAccountingHost(mode: 'observations' | 'recall') {
  const require = createRequire(import.meta.url);
  const runtime: typeof import('../../src/index.js') = await import(
    pathToFileURL(require.resolve('@brainstrike/agent-host')).href
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-final-prompt-accounting-')));
  const resourceId = randomUUID();
  const model = recordedTextModel('gpt-6-sol', 'Paris production fixture reply.', 73, 11);
  const observer = recordedTextModel(
    'recorded-observer-prompt',
    `<observations>\n- ${OBSERVATION_FACT}\n</observations>`,
    42,
    9
  );
  const receipts: {
    runId: string;
    request: Parameters<StateStoreHostMemoryOptions['recordPrompt']>[1];
  }[] = [];
  const queries: unknown[] = [];
  const recordedEmbeddings: string[][] = [];
  const embedder: Extract<MastraEmbeddingModel<string>, { specificationVersion: 'v3' }> = {
    doEmbed: async ({ values, abortSignal }) => {
      abortSignal?.throwIfAborted();
      recordedEmbeddings.push([...values]);
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
    supportsParallelCalls: false,
  };
  let store: StateStore | undefined;
  let indexer: Awaited<ReturnType<typeof openIndexer>> | undefined;
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  let observations = false;
  let inputTokenLimit = 20_000;
  let closing: Promise<void> | undefined;
  const failed = Promise.withResolvers<never>();
  failed.promise.catch(() => undefined);
  const observe = <Value>(work: Promise<Value>): Promise<Value> =>
    work.catch((cause: unknown) => {
      console.error(
        'Final prompt original failure:',
        JSON.stringify({ cause: failureReceipt(cause), root })
      );
      failed.reject(cause);
      throw cause;
    });
  const waits = new Set<(cause: unknown) => void>();
  const close = () =>
    (closing ??= (async () => {
      await host?.close();
      await client?.close();
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
      await rm(root, { force: true, recursive: true });
    })());
  onTestFinished(async ({ signal }) => {
    if (signal.aborted) {
      for (const reject of waits) {
        reject(signal.reason);
      }
    }
    await close();
  });
  try {
    host = await runtime.startAgentHost({ lifetime: 'persistent', root }, async (startup) => {
      store = startup.store;
      if (mode === 'recall') {
        await startup.register(async () => {
          await indexer?.close();
        });
        indexer = await openIndexer(
          {
            dbPath: join(root, 'index.sqlite'),
            embedding: { indexMode: 'text-only' },
            rootIds: [root],
            stateProjection: {
              mode: 'dev',
              module: pathToFileURL(require.resolve('@brainstrike/agent-host/state-projection'))
                .href,
            },
            stateResources: [{ profile: RECORDED_VECTOR_PROFILE, resourceId, rootId: root }],
            stateRoot: root,
          },
          { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
        );
      }
      const platform = await runtime.createProductionHostPlatform({
        close: async () => undefined,
        readConfiguration: async (request) => {
          const writer = indexer;
          const bridge = writer
            ? runtime.StateStoreHostMemory.createVectorBridge({
                port: {
                  prepareStateMessageVectors: (input) => writer.prepareStateMessageVectors(input),
                  purgeStateMessageVectors: (input) => writer.purgeStateMessageVectors(input),
                  queryStateMessageVectors: (input) => {
                    queries.push(structuredClone(input));
                    return writer.queryStateMessageVectors(input);
                  },
                  upsertStateMessageVectors: (input) => writer.upsertStateMessageVectors(input),
                },
                profile: RECORDED_VECTOR_PROFILE,
                scope: { resourceId, rootId: root, threadId: request.threadId },
                signal: request.signal,
              })
            : undefined;
          return {
            configuration: { model: model.modelId, provider: 'openai' },
            durableConfiguration: { inputTokenLimit, mode, observations },
            maxSteps: 1,
            memory: {
              native: {
                ...(bridge ? { embedder, vector: bridge } : {}),
                options: {
                  lastMessages: mode === 'recall' ? 1 : 40,
                  observationalMemory: observations
                    ? {
                        model: observer,
                        observation: {
                          bufferOnIdle: false,
                          bufferTokens: false,
                          messageTokens: 100,
                        },
                        reflection: { observationTokens: 50_000 },
                        scope: 'thread',
                      }
                    : false,
                  semanticRecall: bridge ? { messageRange: 0, scope: 'resource', topK: 1 } : false,
                  workingMemory: { enabled: true, scope: 'thread' },
                },
              },
              recordPrompt: async (identity, requestParams) => {
                receipts.push({ request: requestParams, runId: identity.runId });
              },
              resourceId,
              ...(bridge ? { vectorBridge: bridge } : {}),
            },
            providerRequestContext: {
              inputTokenLimit,
              provider: 'openai',
              runtimeData: { model: model.modelId },
            },
            resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
            system: 'Fixture coding instructions: preserve selected context and project facts.',
            tools: {},
            toolTimeoutMs: 1000,
          };
        },
        readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
        resolveModel: async () => model,
        resolveProviderAuth: async () => undefined,
        startup,
        ...(indexer ? { stateIndexer: createStateStoreIndexer(indexer) } : {}),
      });
      const admit = platform.admitRun;
      if (!admit) {
        throw new Error('Production admission is unavailable');
      }
      platform.admitRun = async (request) => {
        const selected = await observe(admit(request));
        const open = selected.openRun;
        if (!open) {
          throw new Error('Production Memory owner is unavailable');
        }
        return {
          ...selected,
          openRun: async (context) => {
            const owner = await observe(open(context));
            if (!(owner instanceof runtime.StateStoreHostMemory)) {
              throw new Error('Production admission did not acquire public StateStore Memory');
            }
            await observe(owner.memory.updateWorkingMemory(WORKING_FACT));
            return {
              close: () => observe(owner.close()),
              commitHostStep: () => observe(owner.commitHostStep()),
              prepareHostModel: (selectedModel) => owner.prepareHostModel(selectedModel),
              prepareHostStep: (step) => observe(owner.prepareHostStep(step)),
            };
          },
        };
      };
      return platform;
    });
    client = await attachAgentHost(host.record);
    const connected = client;
    const opened = host;
    return {
      close,
      embeddingCalls: recordedEmbeddings,
      enableObservations: () => {
        observations = true;
      },
      model,
      observer,
      queries,
      receipts,
      resourceId,
      root,
      run: async (
        threadId: string,
        prompt: string
      ): Promise<{ runId: string; rows: HostLogRow[] }> => {
        const finished =
          Promise.withResolvers<Extract<HostLogRow['event'], { type: 'run.finished' }>>();
        waits.add(finished.reject);
        const unsubscribe = opened.core.onCommitted((row) => {
          if (row.threadId === threadId && row.event.type === 'run.finished') {
            finished.resolve(row.event);
          }
        });
        try {
          const { runId } = await connected.request('run/start', {
            commandId: randomUUID(),
            modelId: 'openai::gpt-6-sol',
            prompt,
            threadId,
          });
          const terminal = await Promise.race([finished.promise, failed.promise]);
          expect(terminal).toMatchObject({ outcome: 'completed', runId });
          const { rows } = await connected.request('thread/read', { fromSeq: 0, threadId });
          return { rows, runId };
        } finally {
          unsubscribe();
          waits.delete(finished.reject);
        }
      },
      setInputTokenLimit(value: number) {
        inputTokenLimit = value;
      },
      startThread: () => connected.request('thread/start', { commandId: randomUUID() }),
      store: () => {
        if (!store) {
          throw new Error('The actual Root writer is unavailable');
        }
        return store;
      },
    };
  } catch (cause) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Final prompt fixture cleanup failed');
    }
    throw cause;
  }
}
