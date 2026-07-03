import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TursoMastraSqlClient } from '../types';
import { TursoVectorStore } from '../vector-store';
import { createTursoTestClient, type TursoTestClient } from './turso-test-client';

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('TursoVectorStore', () => {
  let runtime: TursoTestClient;
  let store: TursoVectorStore;

  beforeEach(async () => {
    runtime = await createTursoTestClient('brainstrike-turso-vector-');
    store = new TursoVectorStore({ database: runtime.client });
  });

  afterEach(async () => {
    await runtime.close();
  });

  it('creates and describes Turso vector-backed Mastra indexes', async () => {
    await store.createIndex({ indexName: 'memory_messages', dimension: 3, metric: 'cosine' });
    await store.createIndex({ indexName: 'memory_messages', dimension: 3, metric: 'cosine' });

    await expect(
      store.createIndex({ indexName: 'memory_messages', dimension: 4, metric: 'cosine' })
    ).rejects.toThrow(/dimensions/i);

    await expect(store.listIndexes()).resolves.toEqual(['memory_messages']);
    await expect(store.describeIndex({ indexName: 'memory_messages' })).resolves.toMatchObject({
      count: 0,
      dimension: 3,
      metric: 'cosine',
    });
  });

  it('rejects unsafe index names', async () => {
    await expect(
      store.createIndex({
        indexName: 'memory_messages; DROP TABLE mastra_vectors; --',
        dimension: 3,
        metric: 'cosine',
      })
    ).rejects.toThrow(/unsupported index name/i);
  });

  it('caches vector table bootstrap across operations', async () => {
    await store.createIndex({ indexName: 'memory_messages', dimension: 3, metric: 'cosine' });
    await store.listIndexes();
    await store.describeIndex({ indexName: 'memory_messages' });

    const schemaBootstrapQueries = runtime.queries.filter((query) =>
      query.includes('CREATE TABLE IF NOT EXISTS mastra_vectors')
    );
    expect(schemaBootstrapQueries).toHaveLength(1);
  });

  it('upserts, filters, queries, updates, and deletes vectors with real Turso vector functions', async () => {
    await store.createIndex({ indexName: 'memory_messages', dimension: 3, metric: 'cosine' });
    const ids = await store.upsert({
      indexName: 'memory_messages',
      ids: ['message-a', 'message-b', 'message-c'],
      vectors: [
        [1, 0, 0],
        [0.9, 0.1, 0],
        [0, 1, 0],
      ],
      metadata: [
        { message_id: 'message-a', resource_id: 'workspace-a', thread_id: 'thread-1' },
        { message_id: 'message-b', resource_id: 'workspace-a', thread_id: 'thread-1' },
        { message_id: 'message-c', resource_id: 'workspace-b', thread_id: 'thread-2' },
      ],
    });

    expect(ids).toEqual(['message-a', 'message-b', 'message-c']);

    const workspaceResults = await store.query({
      indexName: 'memory_messages',
      queryVector: [1, 0, 0],
      topK: 5,
      filter: { resource_id: 'workspace-a' },
      includeVector: true,
    });

    expect(workspaceResults.map((result) => result.id)).toEqual(['message-a', 'message-b']);
    expect(workspaceResults[0]?.score).toBeGreaterThan(workspaceResults[1]?.score ?? 0);
    expect(workspaceResults[0]?.vector).toEqual([1, 0, 0]);

    const inFilterResults = await store.query({
      indexName: 'memory_messages',
      topK: 10,
      filter: { resource_id: { $in: ['workspace-b'] } },
    });
    expect(inFilterResults.map((result) => result.id)).toEqual(['message-c']);

    await store.updateVector({
      indexName: 'memory_messages',
      id: 'message-c',
      update: {
        metadata: { resource_id: 'workspace-a', thread_id: 'thread-2', message_id: 'message-c' },
      },
    });

    const metadataOnly = await store.query({
      indexName: 'memory_messages',
      topK: 10,
      filter: { resource_id: 'workspace-a' },
    });
    expect(metadataOnly.map((result) => result.id).sort()).toEqual([
      'message-a',
      'message-b',
      'message-c',
    ]);

    await store.deleteVectors({
      indexName: 'memory_messages',
      filter: { thread_id: 'thread-1' },
    });
    await expect(store.describeIndex({ indexName: 'memory_messages' })).resolves.toMatchObject({
      count: 1,
    });

    await store.deleteVector({ indexName: 'memory_messages', id: 'message-c' });
    await expect(store.describeIndex({ indexName: 'memory_messages' })).resolves.toMatchObject({
      count: 0,
    });
  });

  it('requires deleteVectors to specify ids or a filter', async () => {
    await store.createIndex({ indexName: 'memory_messages', dimension: 3, metric: 'cosine' });
    await store.upsert({
      indexName: 'memory_messages',
      ids: ['message-a'],
      vectors: [[1, 0, 0]],
      metadata: [{ message_id: 'message-a' }],
    });

    await expect(store.deleteVectors({ indexName: 'memory_messages' })).rejects.toThrow(
      /requires either ids or filter/i
    );
    await expect(store.describeIndex({ indexName: 'memory_messages' })).resolves.toMatchObject({
      count: 1,
    });
  });

  it('emits compact run events from real semantic upsert and query hooks', async () => {
    const events: string[] = [];
    const observedStore = new TursoVectorStore({
      database: runtime.client,
      eventSink: (event) => {
        events.push(`${event.kind}:${event.label}:${event.runId}`);
      },
      runId: 'run-1',
    });
    await observedStore.createIndex({ indexName: 'memory_messages', dimension: 3 });
    await observedStore.upsert({
      indexName: 'memory_messages',
      vectors: [[1, 0, 0]],
      ids: ['message-a'],
    });
    await observedStore.query({
      indexName: 'memory_messages',
      queryVector: [1, 0, 0],
      topK: 1,
    });

    expect(events).toEqual([
      'memory.semantic.completed:Semantic memory indexed:run-1',
      'memory.semantic.started:Semantic memory search started:run-1',
      'memory.semantic.completed:Semantic memory search completed:run-1',
    ]);
  });

  it('does not fail vector operations when run-event emission fails', async () => {
    const observedStore = new TursoVectorStore({
      database: runtime.client,
      eventSink: () => {
        throw new Error('run event sink unavailable');
      },
      runId: 'run-1',
    });
    await observedStore.createIndex({ indexName: 'memory_messages', dimension: 3 });

    await expect(
      observedStore.upsert({
        ids: ['message-a'],
        indexName: 'memory_messages',
        vectors: [[1, 0, 0]],
      })
    ).resolves.toEqual(['message-a']);
  });

  it('does not await slow run-event emission on vector upsert paths', async () => {
    const releaseSink = createDeferred<void>();
    const observedStore = new TursoVectorStore({
      database: runtime.client,
      eventSink: () => releaseSink.promise,
      runId: 'run-1',
    });
    await observedStore.createIndex({ indexName: 'memory_messages', dimension: 3 });

    await expect(
      observedStore.upsert({
        ids: ['message-a'],
        indexName: 'memory_messages',
        vectors: [[1, 0, 0]],
      })
    ).resolves.toEqual(['message-a']);
    releaseSink.resolve();
  });

  it('rejects non-finite vector values returned from storage', async () => {
    const mockDb: TursoMastraSqlClient = {
      exec: vi.fn(async () => undefined),
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ count: 1, dimension: 3, indexName: 'memory_messages', metric: 'cosine' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              embedding: '[1,NaN,0]',
              id: 'message-a',
              metadata: null,
              score: 1,
            },
          ],
        }),
    };
    const mockStore = new TursoVectorStore({ database: mockDb });

    await expect(
      mockStore.query({
        indexName: 'memory_messages',
        topK: 1,
        includeVector: true,
      })
    ).rejects.toThrow(/invalid vector component/i);
  });

  it('rejects excessive topK values', async () => {
    const mockDb: TursoMastraSqlClient = {
      exec: vi.fn(async () => undefined),
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ count: 1, dimension: 3, indexName: 'memory_messages', metric: 'cosine' }],
      }),
    };
    const mockStore = new TursoVectorStore({ database: mockDb });

    await expect(
      mockStore.query({
        indexName: 'memory_messages',
        topK: 1001,
      })
    ).rejects.toThrow(/topK must be between 1 and 1000/i);
  });
});
