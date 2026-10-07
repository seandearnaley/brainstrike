import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import {
  createStateStoreIndexer,
  openIndexer,
  type StateMessageVectorPort,
} from '@brainstrike/indexer';
import { StateStore } from '@brainstrike/state-store';
import {
  type CreateIndexParams,
  type DeleteIndexParams,
  type DeleteVectorParams,
  type DeleteVectorsParams,
  type DescribeIndexParams,
  type IndexStats,
  type MastraEmbeddingModel,
  MastraVector,
  type QueryResult,
  type QueryVectorParams,
  type UpdateVectorParams,
  type UpsertVectorParams,
} from '@mastra/core/vector';
import type { MockLanguageModelV4 } from 'ai/test';
import { expect } from 'vitest';
import { StateStoreHostMemory } from '../../src/adapters/state-store-host-memory.js';
import { HostCore } from '../../src/core.js';
import type { HostPlatform, HostRunContext } from '../../src/ports.js';
import { RECORDED_VECTOR_PROFILE } from './recorded-memory-vector-port.js';
import { scriptedModel } from './scripted-model.js';

/** Records vendor calls only. It is not an index or production indexer adapter. */
export class RecordedVectorCalls extends MastraVector {
  readonly creates: CreateIndexParams[] = [];
  readonly queries: QueryVectorParams[] = [];
  readonly upserts: UpsertVectorParams[] = [];
  results: QueryResult[] = [];

  constructor() {
    super({ id: 'recorded-memory-vector-calls' });
  }
  override async createIndex(params: CreateIndexParams): Promise<void> {
    this.creates.push(structuredClone(params));
  }
  override async query(params: QueryVectorParams): Promise<QueryResult[]> {
    this.queries.push(structuredClone(params));
    return structuredClone(this.results);
  }
  override async upsert(params: UpsertVectorParams): Promise<string[]> {
    this.upserts.push(structuredClone(params));
    return (params.metadata ?? []).map((metadata) => {
      const id: unknown = metadata['message_id'];
      if (typeof id !== 'string') {
        throw new Error('Recorded vector call has no canonical message identity');
      }
      return id;
    });
  }
  override async listIndexes(): Promise<string[]> {
    return [];
  }
  override async describeIndex(_params: DescribeIndexParams): Promise<IndexStats> {
    throw new Error('Index storage is outside this call recording');
  }
  override async deleteIndex(_params: DeleteIndexParams): Promise<void> {
    throw new Error('Index deletion is outside this call recording');
  }
  override async updateVector(_params: UpdateVectorParams): Promise<void> {
    throw new Error('Index mutation is outside this call recording');
  }
  override async deleteVector(_params: DeleteVectorParams): Promise<void> {
    throw new Error('Index deletion is outside this call recording');
  }
  override async deleteVectors(_params: DeleteVectorsParams): Promise<void> {
    throw new Error('Index deletion is outside this call recording');
  }
}

export function deterministicEmbedding(text: string): number[] {
  return Array.from({ length: 384 }, (_, index) =>
    index === (text.includes('Paris') ? 0 : 1) ? 1 : 0
  );
}

export function failureReceipt(error: unknown): unknown {
  if (error instanceof AggregateError) {
    return { errors: error.errors.map(failureReceipt), message: error.message };
  }
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  return String(error);
}

export async function memoryVectorHost(options: {
  readonly beforeEmbedding?: (
    values: readonly string[],
    signal: AbortSignal | undefined
  ) => Promise<void>;
  readonly borrowVectorPort?: (
    port: StateMessageVectorPort,
    context: HostRunContext
  ) => StateMessageVectorPort;
  readonly lastMessages?: number;
  readonly realIndexer?: boolean;
  readonly semanticScope?: 'thread' | 'resource';
  readonly stateProjectionModule?: string;
  readonly vector?: RecordedVectorCalls;
  readonly vectorPort?: StateMessageVectorPort;
  readonly onEmbedding?: (values: readonly string[]) => void;
  readonly workingScope?: 'thread' | 'resource';
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-memory-recall-')));
  const resourceId = randomUUID();
  const writerOptions = {
    memoryCalculatorModule: fileURLToPath(
      new URL('../../dist/adapters/memory-storage-calculator.js', import.meta.url)
    ),
  };
  const indexerOptions = {
    dbPath: join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: [root],
    stateProjection: {
      mode: 'dev',
      module:
        options.stateProjectionModule ??
        new URL('../../dist/state-projection.js', import.meta.url).href,
    },
    stateResources: [{ profile: RECORDED_VECTOR_PROFILE, resourceId, rootId: root }],
    stateRoot: root,
  } as const;
  const indexerDeadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
  let indexer = options.realIndexer
    ? await openIndexer(indexerOptions, indexerDeadlines)
    : undefined;
  const openStore = () =>
    StateStore.open(root, {
      ...writerOptions,
      ...(indexer ? { indexer: createStateStoreIndexer(indexer) } : {}),
    });
  let store = await openStore();
  const models: MockLanguageModelV4[] = [];
  const contexts: HostRunContext[] = [];
  const owners: StateStoreHostMemory[] = [];
  let retained = 0;
  const runResources = new Map<string, string>();
  const workingReads: { readonly threadId: string; readonly value: string | null }[] = [];
  let workingSeed: string | undefined;
  const embeddingCalls: string[][] = [];
  const embedder: Extract<MastraEmbeddingModel<string>, { specificationVersion: 'v3' }> = {
    doEmbed: async ({ values, abortSignal }) => {
      options.onEmbedding?.(values);
      embeddingCalls.push([...values]);
      if (options.beforeEmbedding) {
        await options.beforeEmbedding(values, abortSignal);
      }
      return {
        embeddings: values.map(deterministicEmbedding),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
    maxEmbeddingsPerCall: 1,
    modelId: 'deterministic-fixture-384',
    provider: 'local-fixture',
    specificationVersion: 'v3',
    supportsParallelCalls: false,
  };
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 1,
    openRun: async (context) => {
      contexts.push(context);
      const selectedResourceId = runResources.get(context.threadId) ?? resourceId;
      const existingPort = indexer ?? options.vectorPort;
      const vectorPort =
        existingPort && options.borrowVectorPort
          ? options.borrowVectorPort(existingPort, context)
          : existingPort;
      const vectorBridge = vectorPort
        ? StateStoreHostMemory.createVectorBridge({
            port: vectorPort,
            profile: RECORDED_VECTOR_PROFILE,
            scope: { resourceId: selectedResourceId, rootId: root, threadId: context.threadId },
            signal: context.signal,
          })
        : undefined;
      const vector = vectorBridge ?? options.vector;
      const owner = await StateStoreHostMemory.open(context, {
        native: {
          ...(vector ? { embedder, vector } : {}),
          options: {
            lastMessages: options.lastMessages ?? 1,
            observationalMemory: false,
            semanticRecall: options.semanticScope
              ? { messageRange: 0, scope: options.semanticScope, topK: 1 }
              : false,
            workingMemory: {
              enabled: true,
              scope: options.workingScope ?? 'thread',
              template: '# Fixture facts',
            },
          },
        },
        recordPrompt: async () => undefined,
        resourceId: selectedResourceId,
        store,
        ...(vectorBridge ? { vectorBridge } : {}),
      });
      if (workingSeed !== undefined) {
        await owner.memory.updateWorkingMemory(workingSeed);
        workingSeed = undefined;
      }
      workingReads.push({
        threadId: context.threadId,
        value: await owner.memory.getWorkingMemory(),
      });
      owners.push(owner);
      return owner;
    },
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => {
      const model = scriptedModel();
      models.push(model);
      return model;
    },
    tools: {},
  };
  const retain = () => {
    retained += 1;
    return () => {
      retained -= 1;
    };
  };
  let core = await HostCore.open(store, platform, retain);
  return {
    async close(): Promise<void> {
      try {
        await core.close();
      } catch (error) {
        console.error('Memory recall cleanup cause:', JSON.stringify(failureReceipt(error)));
        throw error;
      } finally {
        try {
          await store.close();
        } finally {
          try {
            await indexer?.close();
          } finally {
            await rm(root, { force: true, recursive: true });
          }
        }
      }
    },
    async closeRejectedAdmission(): Promise<void> {
      // Core retains the failed admission cause. No Memory owner was constructed;
      // the negative test verifies zero SDK, embedding and working-memory calls.
      await expect(core.close()).rejects.toBeInstanceOf(AggregateError);
      await store.close();
      await rm(root, { force: true, recursive: true });
    },
    contexts,
    get core(): HostCore {
      return core;
    },
    embedder,
    embeddingCalls,
    get indexer() {
      return indexer;
    },
    models,
    owners,
    async reopen(fresh = false): Promise<void> {
      await core.close();
      await store.close();
      if (indexer) {
        await indexer.close();
        indexer = await openIndexer(
          { ...indexerOptions, embedding: { indexMode: fresh ? 'text-only' : 'open-existing' } },
          indexerDeadlines
        );
      }
      store = await openStore();
      core = await HostCore.open(store, platform, retain);
    },
    resourceId,
    retained: () => retained,
    root,
    async run(threadId: string, prompt: string, selectedResourceId = resourceId): Promise<string> {
      runResources.set(threadId, selectedResourceId);
      const { runId } = await core.startRun({
        commandId: randomUUID(),
        modelId: 'recorded-sdk-fixture',
        prompt,
        threadId,
      });
      try {
        await expect
          .poll(async () => {
            const terminal = (await core.read(threadId, 0)).find(
              ({ event }) => event.type === 'run.finished' && event.runId === runId
            )?.event;
            if (terminal?.type === 'run.finished' && terminal.outcome !== 'completed') {
              throw new Error(JSON.stringify(terminal));
            }
            return terminal;
          })
          .toMatchObject({ outcome: 'completed' });
      } catch (error) {
        console.error(
          'Memory recall first failure:',
          JSON.stringify({
            failure: failureReceipt(error),
            rows: (await core.read(threadId, 0)).map((row) => ({
              seq: row.seq,
              type: row.event.type,
            })),
            runId,
            threadId,
          })
        );
        throw error;
      }
      return runId;
    },
    seedWorkingMemory(value: string): void {
      workingSeed = value;
    },
    get store(): StateStore {
      return store;
    },
    workingReads,
  };
}
