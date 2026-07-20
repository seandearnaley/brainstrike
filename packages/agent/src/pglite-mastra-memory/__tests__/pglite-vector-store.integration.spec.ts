import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgliteDatabase } from '../types';
import { PgliteVectorStore } from '../vector-store';

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

describe('PgliteVectorStore', () => {
  let db: PGlite;
  let database: PgliteDatabase;
  let store: PgliteVectorStore;

  beforeEach(async () => {
    db = await PGlite.create({ extensions: { vector } });
    database = db as unknown as PgliteDatabase;
    store = new PgliteVectorStore({ database });
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates and describes pgvector-backed Mastra indexes', async () => {
    await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });
    await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });

    await expect(
      store.createIndex({ dimension: 4, indexName: 'memory_messages', metric: 'cosine' })
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
        dimension: 3,
        indexName: 'memory_messages; DROP TABLE mastra_vectors; --',
        metric: 'cosine',
      })
    ).rejects.toThrow(/unsupported index name/i);
  });

  it('caches vector table bootstrap across operations', async () => {
    const execSpy = vi.spyOn(db, 'exec');

    await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });
    await store.listIndexes();
    await store.describeIndex({ indexName: 'memory_messages' });

    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it('upserts, filters, queries, updates, and deletes vectors', async () => {
    await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });
    const ids = await store.upsert({
      ids: ['message-a', 'message-b', 'message-c'],
      indexName: 'memory_messages',
      metadata: [
        { message_id: 'message-a', resource_id: 'workspace-a', thread_id: 'thread-1' },
        { message_id: 'message-b', resource_id: 'workspace-a', thread_id: 'thread-1' },
        { message_id: 'message-c', resource_id: 'workspace-b', thread_id: 'thread-2' },
      ],
      vectors: [
        [1, 0, 0],
        [0.9, 0.1, 0],
        [0, 1, 0],
      ],
    });

    expect(ids).toEqual(['message-a', 'message-b', 'message-c']);

    const workspaceResults = await store.query({
      filter: { resource_id: 'workspace-a' },
      includeVector: true,
      indexName: 'memory_messages',
      queryVector: [1, 0, 0],
      topK: 5,
    });

    expect(workspaceResults.map((result) => result.id)).toEqual(['message-a', 'message-b']);
    expect(workspaceResults[0]?.score).toBeGreaterThan(workspaceResults[1]?.score ?? 0);
    expect(workspaceResults[0]?.vector).toEqual([1, 0, 0]);

    await store.updateVector({
      id: 'message-c',
      indexName: 'memory_messages',
      update: {
        metadata: { message_id: 'message-c', resource_id: 'workspace-a', thread_id: 'thread-2' },
      },
    });

    const metadataOnly = await store.query({
      filter: { resource_id: 'workspace-a' },
      indexName: 'memory_messages',
      topK: 10,
    });
    expect(metadataOnly.map((result) => result.id).sort()).toEqual([
      'message-a',
      'message-b',
      'message-c',
    ]);

    await store.deleteVectors({
      filter: { thread_id: 'thread-1' },
      indexName: 'memory_messages',
    });
    await expect(store.describeIndex({ indexName: 'memory_messages' })).resolves.toMatchObject({
      count: 1,
    });

    await store.deleteVector({ id: 'message-c', indexName: 'memory_messages' });
    await expect(store.describeIndex({ indexName: 'memory_messages' })).resolves.toMatchObject({
      count: 0,
    });
  });

  describe('range filters', () => {
    const indexName = 'memory_observations_3';

    beforeEach(async () => {
      await store.createIndex({ dimension: 3, indexName, metric: 'cosine' });
      await store.upsert({
        ids: ['obs-old', 'obs-mid', 'obs-new'],
        indexName,
        metadata: [
          {
            observed_at: '2026-01-01T00:00:00.000Z',
            resource_id: 'workspace-a',
            thread_id: 'thread-1',
            token_count: 9,
          },
          {
            observed_at: '2026-02-01T00:00:00.000Z',
            resource_id: 'workspace-a',
            thread_id: 'thread-1',
            token_count: 10,
          },
          {
            observed_at: '2026-03-01T00:00:00.000Z',
            resource_id: 'workspace-a',
            thread_id: 'thread-2',
            token_count: 11,
          },
        ],
        vectors: [
          [1, 0, 0],
          [1, 0, 0],
          [1, 0, 0],
        ],
      });
    });

    it('supports the Mastra searchMessages observed_at $gt/$lt window', async () => {
      // Exact filter shape @mastra/memory searchMessages builds when the
      // recall tool passes before/after dates (observedAfter/observedBefore).
      const results = await store.query({
        filter: {
          observed_at: {
            $gt: new Date('2026-01-15T00:00:00.000Z').toISOString(),
            $lt: new Date('2026-02-15T00:00:00.000Z').toISOString(),
          },
          resource_id: 'workspace-a',
        },
        indexName,
        queryVector: [1, 0, 0],
        topK: 5,
      });

      expect(results.map((result) => result.id)).toEqual(['obs-mid']);
    });

    it('treats $gte/$lte bounds as inclusive', async () => {
      const results = await store.query({
        filter: {
          observed_at: {
            $gte: '2026-01-01T00:00:00.000Z',
            $lte: '2026-02-01T00:00:00.000Z',
          },
        },
        indexName,
        queryVector: [1, 0, 0],
        topK: 5,
      });

      expect(results.map((result) => result.id).sort()).toEqual(['obs-mid', 'obs-old']);
    });

    it('compares numeric operands numerically, not lexicographically', async () => {
      // Text comparison would exclude token_count 10 and 11 ('10' < '9').
      const results = await store.query({
        filter: { token_count: { $gt: 9 } },
        indexName,
        queryVector: [1, 0, 0],
        topK: 5,
      });

      expect(results.map((result) => result.id).sort()).toEqual(['obs-mid', 'obs-new']);
    });

    it('rejects unsupported operators loudly, even next to supported ones', async () => {
      await expect(
        store.query({
          filter: { observed_at: { $regex: 'x' } },
          indexName,
          queryVector: [1, 0, 0],
          topK: 5,
        })
      ).rejects.toThrow(/unsupported vector filter operator/i);

      await expect(
        store.query({
          filter: { observed_at: { $gt: '2026-01-01T00:00:00.000Z', $regex: 'x' } },
          indexName,
          queryVector: [1, 0, 0],
          topK: 5,
        })
      ).rejects.toThrow(/unsupported vector filter operator/i);
    });

    it('rejects range operands that are not strings, finite numbers, or dates', async () => {
      await expect(
        store.query({
          filter: { observed_at: { $gt: ['2026-01-01'] } },
          indexName,
          queryVector: [1, 0, 0],
          topK: 5,
        })
      ).rejects.toThrow(/range filter/i);

      await expect(
        store.query({
          filter: { token_count: { $lt: Number.NaN } },
          indexName,
          queryVector: [1, 0, 0],
          topK: 5,
        })
      ).rejects.toThrow(/range filter/i);
    });
  });

  it('requires deleteVectors to specify ids or a filter', async () => {
    await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });
    await store.upsert({
      ids: ['message-a'],
      indexName: 'memory_messages',
      metadata: [{ message_id: 'message-a' }],
      vectors: [[1, 0, 0]],
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
    const observedStore = new PgliteVectorStore({
      database,
      eventSink: (event) => {
        events.push(`${event.kind}:${event.label}:${event.runId}`);
      },
      runId: 'run-1',
    });
    await observedStore.createIndex({ dimension: 3, indexName: 'memory_messages' });
    await observedStore.upsert({
      ids: ['message-a'],
      indexName: 'memory_messages',
      vectors: [[1, 0, 0]],
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
    const observedStore = new PgliteVectorStore({
      database,
      eventSink: () => {
        throw new Error('run event sink unavailable');
      },
      runId: 'run-1',
    });
    await observedStore.createIndex({ dimension: 3, indexName: 'memory_messages' });

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
    const observedStore = new PgliteVectorStore({
      database,
      eventSink: () => releaseSink.promise,
      runId: 'run-1',
    });
    await observedStore.createIndex({ dimension: 3, indexName: 'memory_messages' });

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
    const mockDb = {
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
    const mockStore = new PgliteVectorStore({ database: mockDb });

    await expect(
      mockStore.query({
        includeVector: true,
        indexName: 'memory_messages',
        topK: 1,
      })
    ).rejects.toThrow(/invalid vector component/i);
  });

  it('rejects excessive topK values', async () => {
    const mockDb = {
      exec: vi.fn(async () => undefined),
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ count: 1, dimension: 3, indexName: 'memory_messages', metric: 'cosine' }],
      }),
    };
    const mockStore = new PgliteVectorStore({ database: mockDb });

    await expect(
      mockStore.query({
        indexName: 'memory_messages',
        topK: 1001,
      })
    ).rejects.toThrow(/topK must be between 1 and 1000/i);
  });
});
