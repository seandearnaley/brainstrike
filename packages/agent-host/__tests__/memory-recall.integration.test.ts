import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
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
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { committedMemoryTranscript } from '../src/adapters/committed-memory-transcript.js';
import { StateStoreHostMemory } from '../src/adapters/state-store-host-memory.js';
import { HostCore } from '../src/core.js';
import { readHostRow } from '../src/event-storage.js';
import type { HostPlatform } from '../src/ports.js';
import { scriptedModel } from './fixtures/scripted-model.js';

/** Records vendor calls only. It is not an index or production indexer adapter. */
class RecordedVectorCalls extends MastraVector {
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

const fetch = vi.fn(async () => {
  throw new Error('This packet makes no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  expect(fetch.mock.calls.length).toBe(0);
  vi.unstubAllGlobals();
});

function deterministicEmbedding(text: string): number[] {
  return Array.from({ length: 384 }, (_, index) =>
    index === (text.includes('Paris') ? 0 : 1) ? 1 : 0
  );
}

function recordedSystem(model: MockLanguageModelV4 | undefined): string {
  return (
    model?.doStreamCalls[0]?.prompt
      .flatMap((message) => (message.role === 'system' ? [message.content] : []))
      .join('\n') ?? ''
  );
}

async function fixture(options: {
  readonly lastMessages?: number;
  readonly semanticScope?: 'thread' | 'resource';
  readonly vector?: RecordedVectorCalls;
  readonly workingScope?: 'thread' | 'resource';
}) {
  const root = await mkdtemp(join(tmpdir(), 'bs-memory-recall-'));
  const resourceId = randomUUID();
  const writerOptions = {
    memoryCalculatorModule: fileURLToPath(
      new URL('../dist/adapters/memory-storage-calculator.js', import.meta.url)
    ),
  };
  let store = await StateStore.open(root, writerOptions);
  const models: MockLanguageModelV4[] = [];
  const runResources = new Map<string, string>();
  const workingReads: { readonly threadId: string; readonly value: string | null }[] = [];
  let workingSeed: string | undefined;
  const embeddingCalls: string[][] = [];
  const embedder: Extract<MastraEmbeddingModel<string>, { specificationVersion: 'v3' }> = {
    doEmbed: async ({ values }) => {
      embeddingCalls.push([...values]);
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
      const owner = await StateStoreHostMemory.open(context, {
        native: {
          ...(options.vector ? { embedder, vector: options.vector } : {}),
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
        resourceId: runResources.get(context.threadId) ?? resourceId,
        store,
      });
      if (workingSeed !== undefined) {
        await owner.memory.updateWorkingMemory(workingSeed);
        workingSeed = undefined;
      }
      workingReads.push({
        threadId: context.threadId,
        value: await owner.memory.getWorkingMemory(),
      });
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
  let core = await HostCore.open(store, platform, () => () => undefined);
  return {
    async close(): Promise<void> {
      await core.close();
      await store.close();
      await rm(root, { force: true, recursive: true });
    },
    async closeRejectedAdmission(): Promise<void> {
      // Core retains the failed admission cause. No Memory owner was constructed;
      // the negative test verifies zero SDK, embedding and working-memory calls.
      await expect(core.close()).rejects.toBeInstanceOf(AggregateError);
      await store.close();
      await rm(root, { force: true, recursive: true });
    },
    get core(): HostCore {
      return core;
    },
    embedder,
    embeddingCalls,
    models,
    async reopen(): Promise<void> {
      await core.close();
      await store.close();
      store = await StateStore.open(root, writerOptions);
      core = await HostCore.open(store, platform, () => () => undefined);
    },
    resourceId,
    async run(threadId: string, prompt: string, selectedResourceId = resourceId): Promise<string> {
      runResources.set(threadId, selectedResourceId);
      const { runId } = await core.startRun({
        commandId: randomUUID(),
        modelId: 'recorded-sdk-fixture',
        prompt,
        threadId,
      });
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

test.each(['thread', 'resource'] as const)(
  'public working memory persists through real SQLite reopen and honors %s scope',
  async (scope) => {
    const current = await fixture({ workingScope: scope });
    try {
      const { threadId } = await current.core.startThread({ commandId: randomUUID() });
      const text = '# Fixture facts\n- Retained SQLite working-memory value';
      current.seedWorkingMemory(text);
      await current.run(threadId, 'Record the working-memory fact.');
      const before = await current.core.read(threadId, 0);
      const snapshot = await current.store.memory({
        operation: 'read',
        resourceId: current.resourceId,
      });
      await current.reopen();
      expect(await current.core.read(threadId, 0)).toEqual(before);
      expect(
        await current.store.memory({ operation: 'read', resourceId: current.resourceId })
      ).toEqual(snapshot);
      await current.run(threadId, 'Recall the retained working-memory fact.');
      expect(current.workingReads.at(-1)?.value).toBe(text);
      expect(recordedSystem(current.models.at(-1))).toContain(text);
      const other = await current.core.startThread({ commandId: randomUUID() });
      await current.run(other.threadId, 'Read this thread working memory.');
      expect(current.workingReads.at(-1)?.value).toBe(scope === 'resource' ? text : null);
      expect(recordedSystem(current.models.at(-1)).includes(text)).toBe(scope === 'resource');
      expect(await current.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
      expect(current.embeddingCalls).toHaveLength(0);
    } finally {
      await current.close();
    }
  }
);

test.each(['thread', 'resource'] as const)(
  'public recall uses recorded vector calls and canonical SQLite messages (%s scope; not production vector parity)',
  async (scope) => {
    const vector = new RecordedVectorCalls();
    const current = await fixture({ semanticScope: scope, vector });
    try {
      const first = await current.core.startThread({ commandId: randomUUID() });
      await current.run(first.threadId, 'Paris recorded canonical fact.');
      const before = await current.core.read(first.threadId, 0);
      const transcript = committedMemoryTranscript(before, current.resourceId);
      const recalled = transcript.findLast((message) => message.role === 'assistant');
      if (!recalled) {
        throw new Error('Recorded SDK step has no committed assistant identity');
      }
      vector.results = [
        {
          id: recalled.id,
          metadata: {
            message_id: recalled.id,
            resource_id: current.resourceId,
            thread_id: first.threadId,
          },
          score: 1,
        },
      ];
      const queriesBefore = vector.queries.length;
      await current.reopen();
      const target =
        scope === 'resource' ? await current.core.startThread({ commandId: randomUUID() }) : first;
      await current.run(target.threadId, 'Recall Paris beyond the one-message history window.');
      const prompt = current.models.at(-1)?.doStreamCalls[0]?.prompt;
      expect(
        prompt?.filter((message) => message.role !== 'system').map((message) => message.role)
      ).toEqual(['user', 'assistant', 'user']);
      expect(JSON.stringify(prompt)).toContain('Paris recorded canonical fact.');
      const queries = vector.queries.slice(queriesBefore);
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.at(-1)).toMatchObject({
        filter:
          scope === 'thread' ? { thread_id: first.threadId } : { resource_id: current.resourceId },
        queryVector: deterministicEmbedding('Paris'),
        topK: 1,
      });
      expect(
        current.embeddingCalls.some((values) =>
          values.includes('Recall Paris beyond the one-message history window.')
        )
      ).toBe(true);
      expect(vector.creates.every(({ dimension }) => dimension === 384)).toBe(true);
      const all = committedMemoryTranscript(
        await Promise.all(
          (await current.store.readAll()).map((row) => readHostRow(current.store, row))
        ),
        current.resourceId
      );
      const ids = new Set(all.map((message) => message.id));
      expect(vector.upserts.length).toBeGreaterThan(0);
      expect(vector.upserts.every(({ ids: generated }) => generated === undefined)).toBe(true);
      expect(
        vector.upserts
          .flatMap(({ metadata }) => metadata ?? [])
          .every(
            (metadata) =>
              typeof metadata['message_id'] === 'string' && ids.has(metadata['message_id'])
          )
      ).toBe(true);
      expect((await current.core.read(first.threadId, 0)).slice(0, before.length)).toEqual(before);
      expect(await current.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
    } finally {
      await current.close();
    }
  }
);

test('missing semantic capability fails admission before embedding or the SDK call', async () => {
  const current = await fixture({ semanticScope: 'thread' });
  try {
    const { threadId } = await current.core.startThread({ commandId: randomUUID() });
    await expect(
      current.run(threadId, 'Request unavailable semantic recall.')
    ).rejects.toBeInstanceOf(Error);
    expect(current.embeddingCalls).toHaveLength(0);
    expect(current.models.flatMap((model) => model.doStreamCalls)).toHaveLength(0);
    expect(current.workingReads).toHaveLength(0);
    expect(await current.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
  } finally {
    await current.closeRejectedAdmission();
  }
});

test('empty semantic results preserve the bounded history window', async () => {
  const vector = new RecordedVectorCalls();
  const current = await fixture({ lastMessages: 2, semanticScope: 'thread', vector });
  try {
    const { threadId } = await current.core.startThread({ commandId: randomUUID() });
    await current.run(threadId, 'Paris fact outside the next bounded window.');
    await current.run(threadId, 'An unrelated current query.');
    const prompt = current.models.at(-1)?.doStreamCalls[0]?.prompt;
    expect(
      prompt?.filter((message) => message.role !== 'system').map((message) => message.role)
    ).toEqual(['user']);
    expect(JSON.stringify(prompt)).not.toContain('Paris fact outside the next bounded window.');
    expect(vector.queries.length).toBeGreaterThan(0);
  } finally {
    await current.close();
  }
});

test.each([
  ['foreign resource', 'resource', true],
  ['foreign resource', 'thread', true],
  ['foreign thread', 'thread', false],
] as const)(
  '%s vector hit cannot authorize %s recall',
  async (_boundary, scope, separateResource) => {
    const vector = new RecordedVectorCalls();
    const current = await fixture({ semanticScope: scope, vector });
    try {
      const foreignResourceId = separateResource ? randomUUID() : current.resourceId;
      const foreign = await current.core.startThread({ commandId: randomUUID() });
      const foreignText = 'Foreign-resource committed fact: 5b4fa5cc.';
      await current.run(foreign.threadId, foreignText, foreignResourceId);
      const before = await current.core.read(foreign.threadId, 0);
      const foreignMessage = committedMemoryTranscript(before, foreignResourceId).findLast(
        (message) => message.role === 'assistant'
      );
      if (!foreignMessage) {
        throw new Error('Foreign recorded SDK step has no committed assistant identity');
      }
      await current.reopen();
      const foreignSnapshot = await current.store.memory({
        operation: 'read',
        resourceId: foreignResourceId,
      });
      expect(foreignSnapshot.entities).toContainEqual(
        expect.objectContaining({
          id: foreign.threadId,
          kind: 'thread',
          payload: expect.objectContaining({ resourceId: foreignResourceId }),
          threadId: foreign.threadId,
        })
      );
      const target = await current.core.startThread({ commandId: randomUUID() });
      vector.results = [
        {
          id: foreignMessage.id,
          metadata: {
            message_id: foreignMessage.id,
            resource_id: current.resourceId,
            thread_id: foreign.threadId,
          },
          score: 1,
        },
      ];
      await current.run(target.threadId, 'Recall only this resource.');
      const targetSnapshot = await current.store.memory({
        operation: 'read',
        resourceId: current.resourceId,
      });
      expect(targetSnapshot.entities).toContainEqual(
        expect.objectContaining({ id: target.threadId, kind: 'thread' })
      );
      expect(targetSnapshot.entities.some((entity) => entity.threadId === foreign.threadId)).toBe(
        !separateResource
      );
      const prompt = current.models.at(-1)?.doStreamCalls[0]?.prompt;
      expect(JSON.stringify(prompt)).not.toContain(foreignText);
      expect(
        prompt?.filter((message) => message.role !== 'system').map((message) => message.role)
      ).toEqual(['user']);
      expect(vector.queries.at(-1)?.filter).toEqual(
        scope === 'resource' ? { resource_id: current.resourceId } : { thread_id: target.threadId }
      );
      expect((await current.core.read(foreign.threadId, 0)).slice(0, before.length)).toEqual(
        before
      );
      expect(await current.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
    } finally {
      await current.close();
    }
  }
);
