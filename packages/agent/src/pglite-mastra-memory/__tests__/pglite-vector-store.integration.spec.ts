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

  describe('metadata filter shape (BST-577: containment so the GIN index serves it)', () => {
    async function seedRows(count: number): Promise<void> {
      await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });
      const ids = Array.from({ length: count }, (_, i) => `msg-${i}`);
      await store.upsert({
        ids,
        indexName: 'memory_messages',
        metadata: ids.map((id, i) => ({
          message_id: id,
          resource_id: `workspace-${i % 7}`,
          thread_id: `thread-${i % 13}`,
        })),
        vectors: ids.map((_, i) => [Math.sin(i), Math.cos(i), 0.5]),
      });
    }

    async function capturedQuerySql(filter: Record<string, unknown>): Promise<{
      params: unknown[];
      sql: string;
    }> {
      // The ANN SELECT runs inside the store's tuning transaction, so capture
      // tx.query calls by proxying the transaction callback's tx object.
      const captured: { params: unknown[]; sql: string }[] = [];
      const original = db.transaction.bind(db);
      const transactionSpy = vi
        .spyOn(db, 'transaction')
        .mockImplementation((callback: (tx: unknown) => unknown) =>
          original(async (tx) => {
            const proxied = new Proxy(tx as object, {
              get(target, property, receiver) {
                if (property === 'query') {
                  return (sql: string, params?: unknown[]) => {
                    captured.push({ params: params ?? [], sql });
                    return (target as { query: typeof db.query }).query(sql, params);
                  };
                }
                return Reflect.get(target, property, receiver);
              },
            });
            return await callback(proxied);
          })
        );
      await store.query({
        filter,
        indexName: 'memory_messages',
        queryVector: [1, 0, 0],
        topK: 5,
      });
      transactionSpy.mockRestore();
      const call = captured.find((entry) => entry.sql.includes('embedding'));
      if (!call) {
        throw new Error('vector query SQL was not captured');
      }
      return call;
    }

    it('emits a GIN-servable containment predicate for string equality filters', async () => {
      await seedRows(12);
      const { sql } = await capturedQuerySql({ resource_id: 'workspace-3' });

      // The store must emit containment (GIN-servable), never ->> equality
      // (which jsonb_ops GIN cannot serve). In the full ANN query the planner
      // may still prefer the HNSW order-by scan with an inline filter — the
      // point is that the predicate SHAPE is index-servable when the planner
      // wants it (e.g. deleteVectors, highly selective filters).
      expect(sql).toContain('metadata @> jsonb_build_object');
      expect(sql).not.toContain('->>');

      // Probe pair proving the audit claim: with seq scans disabled, the
      // containment shape reaches the metadata GIN while the legacy ->> shape
      // cannot (the planner is forced to keep the penalized Seq Scan).
      await db.query('SET enable_seqscan = off');
      const contained = await db.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM mastra_vectors
         WHERE metadata @> jsonb_build_object($1::text, $2::text)`,
        ['resource_id', 'workspace-3']
      );
      const legacy = await db.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM mastra_vectors
         WHERE metadata ->> $1 = $2`,
        ['resource_id', 'workspace-3']
      );
      await db.query('RESET enable_seqscan');

      expect(JSON.stringify(contained.rows[0]?.['QUERY PLAN'])).toContain(
        'mastra_vectors_metadata_idx'
      );
      expect(JSON.stringify(legacy.rows[0]?.['QUERY PLAN'])).not.toContain(
        'mastra_vectors_metadata_idx'
      );
    }, 30_000);

    it('keeps exact match semantics for string filters (plain, $eq, $and)', async () => {
      await seedRows(10);
      const plain = await store.query({
        filter: { resource_id: 'workspace-1' },
        indexName: 'memory_messages',
        queryVector: [1, 0, 0],
        topK: 20,
      });
      expect(plain.length).toBeGreaterThan(0);
      expect(plain.every((r) => r.metadata?.['resource_id'] === 'workspace-1')).toBe(true);

      const withEq = await store.query({
        filter: { resource_id: { $eq: 'workspace-1' } },
        indexName: 'memory_messages',
        queryVector: [1, 0, 0],
        topK: 20,
      });
      expect(withEq.map((r) => r.id).sort()).toEqual(plain.map((r) => r.id).sort());

      const withAnd = await store.query({
        filter: { $and: [{ resource_id: 'workspace-1' }, { thread_id: 'thread-1' }] },
        indexName: 'memory_messages',
        queryVector: [1, 0, 0],
        topK: 20,
      });
      expect(
        withAnd.every(
          (r) =>
            r.metadata?.['resource_id'] === 'workspace-1' &&
            r.metadata?.['thread_id'] === 'thread-1'
        )
      ).toBe(true);
    }, 30_000);

    it('preserves text-coerced matching for non-string filter values (legacy path)', async () => {
      await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });
      await store.upsert({
        ids: ['n-1'],
        indexName: 'memory_messages',
        metadata: [{ count: 5, resource_id: 'workspace-n' }],
        vectors: [[1, 0, 0]],
      });

      const numericFilter = await store.query({
        filter: { count: 5 },
        indexName: 'memory_messages',
        queryVector: [1, 0, 0],
        topK: 5,
      });
      expect(numericFilter.map((r) => r.id)).toEqual(['n-1']);
    }, 30_000);
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
