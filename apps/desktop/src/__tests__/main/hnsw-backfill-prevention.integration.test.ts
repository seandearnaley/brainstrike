import {
  dimensionIndexIsReady,
  migrate,
  precreateEmptyDimensionIndex,
  wasmLoader,
} from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabaseWorkScheduler,
  createScheduledDbHandle,
} from '../../../../../packages/db/src/database-work-scheduler';
import { JobQueue } from '../../../../../packages/db/src/queue/job-queue';
import { EmbeddingSetsRepository } from '../../../../../packages/db/src/repositories/embedding-sets-repository';
import { enqueueEmbeddingBackfill } from '../../embedding-backfill';

let db: PGlite;
beforeEach(async () => {
  db = await wasmLoader.createPGlite('memory://hnsw-backfill-prevention');
  await migrate(db);
});
afterEach(async () => {
  await db.close();
});

async function indexOid(dimension: number): Promise<number | null> {
  const result = await db.query<{ oid: number | null }>('SELECT to_regclass($1)::oid AS oid', [
    `idx_file_chunks_emb_hnsw_${dimension}`,
  ]);
  return result.rows[0]?.oid ?? null;
}
async function seedChunks(count: number): Promise<string> {
  const repo = new EmbeddingSetsRepository(db);
  const set = await repo.getOrCreateWorkspaceIndexSet();
  await repo.waitForPendingDimensionIndexBuilds();
  await db.query(
    `INSERT INTO file_records (id, name, path, size, embedding_set_id)
    VALUES ('file', 'fixture.ts', 'fixture.ts', 10, $1)`,
    [set.id]
  );
  await db.query(
    `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, embedding_set_id)
    SELECT 'chunk-' || n, 'file', n, 'fixture', 'hash-' || n, $1 FROM generate_series(1, $2::int) n`,
    [set.id, count]
  );
  return set.id;
}
function vector(index: number): number[] {
  return Array.from({ length: 384 }, (_, axis) => Math.sin((index + 1) * (axis + 1)));
}

describe('HNSW backfill prevention', () => {
  for (const transport of ['raw'] as const) {
    it(`creates an empty index before a ${transport} embedding-set caller can populate it`, async () => {
      await db.exec('DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_1536');
      const repo = new EmbeddingSetsRepository(db);
      await repo.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );
      expect(await indexOid(1536)).not.toBeNull();
      await repo.waitForPendingDimensionIndexBuilds();
    });
  }
  it('keeps populated-table recovery explicit and refuses a noncanonical index', async () => {
    await seedChunks(1);
    await db.exec('DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_1536');
    await precreateEmptyDimensionIndex(db, 1536);
    expect(await indexOid(1536)).toBeNull();
    expect(await dimensionIndexIsReady(db, 384)).toBe(true);
    await db.exec(`DROP INDEX idx_file_chunks_emb_hnsw_384;
      CREATE INDEX idx_file_chunks_emb_hnsw_384 ON file_chunks
      USING hnsw ((embedding::halfvec(384)) halfvec_l2_ops)
      WHERE vector_dims(embedding) = 384`);
    expect(await dimensionIndexIsReady(db, 384)).toBe(false);
  });
  it('retains the same usable HNSW index during scoped backfill', async () => {
    const setId = await seedChunks(130);
    const before = await indexOid(384);
    expect(before).not.toBeNull();
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const background = createScheduledDbHandle(
      {
        exec: (sql: string, params?: unknown[]) =>
          params === undefined ? db.exec(sql) : db.query(sql, params),
        query: <T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> =>
          db.query<T>(sql, params),
      },
      scheduler,
      'background'
    );
    const queue = new JobQueue(background);
    await enqueueEmbeddingBackfill(
      {
        maintenance: {
          exec: (sql, params) => background.exec(sql, params ? [...params] : undefined),
        },
        query: <T = unknown>(sql: string, params?: readonly unknown[]) =>
          background.query<T>(sql, params ? [...params] : undefined),
      },
      {
        enqueueBatch: async (jobs) => {
          const enqueued = await queue.enqueueBatch(jobs);
          const claimed = await queue.claimMany({
            leaseMs: 60_000,
            limit: jobs.length,
            queue: 'embeddings',
          });
          await queue.completeEmbeddingChunkBatch(
            claimed.map((job) => {
              const payload = job.payload;
              if (
                typeof payload !== 'object' ||
                payload === null ||
                !('chunkId' in payload) ||
                typeof payload.chunkId !== 'string'
              ) {
                throw new Error('Fixture job must carry chunkId.');
              }
              const index = Number(payload.chunkId.split('-')[1]);
              return {
                chunkId: payload.chunkId,
                embedding: vector(index),
                embeddingHash: `hash-${index}`,
                embeddingSetId: setId,
                id: job.id,
                leaseToken: job.lease_token,
              };
            })
          );
          return enqueued;
        },
        repairUnclaimableQueued: queue.repairUnclaimableQueued.bind(queue),
      },
      setId,
      () => undefined
    );
    expect(
      (
        await db.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM file_chunks WHERE embedding IS NOT NULL'
        )
      ).rows[0]?.count
    ).toBe(130);
    expect(await indexOid(384)).toBe(before);
    await db.exec('SET enable_seqscan = off');
    const params = [`[${vector(1).join(',')}]`];
    const search =
      'SELECT id FROM file_chunks WHERE vector_dims(embedding) = 384 ORDER BY embedding::halfvec(384) <=> $1::halfvec(384) LIMIT 1';
    const plan = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${search}`, params);
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'idx_file_chunks_emb_hnsw_384'
    );
    expect((await db.query(search, params)).rows).toEqual([{ id: 'chunk-1' }]);
  });
  it('admits foreground work between indexed lease-guarded completion batches', async () => {
    const count = 130;
    const setId = await seedChunks(count);
    const queue = new JobQueue(db);
    await queue.enqueueBatch(
      Array.from({ length: count }, (_, index) => ({
        jobType: 'embed_chunk' as const,
        payload: { chunkId: `chunk-${index + 1}`, embeddingSetId: setId },
        queue: 'embeddings',
      }))
    );
    const claimed = await queue.claimMany({ leaseMs: 60_000, limit: count, queue: 'embeddings' });
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const statements: number[] = [];
    const graphNodes: number[] = [];
    const order: string[] = [];
    let foreground: Promise<unknown> | undefined;
    const tracked = {
      query: async <T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
        if (sql.includes('updated_chunks AS')) {
          const ids = params?.[1];
          if (!Array.isArray(ids)) {
            throw new Error('Completion statement must carry job IDs.');
          }
          const chunks = params?.[3];
          if (!Array.isArray(chunks)) {
            throw new Error('Completion statement must carry chunk IDs.');
          }
          graphNodes.push(new Set(chunks).size);
          const size = ids.length;
          statements.push(size);
          order.push(`background:${size}`);
          foreground ??= scheduler.run(
            () => {
              order.push('foreground');
              return db.query('SELECT 1');
            },
            { priority: 'foreground' }
          );
        }
        return await db.query<T>(sql, params);
      },
    };
    const background = createScheduledDbHandle(tracked, scheduler, 'background');
    const completions = claimed.map((job, index) => ({
      chunkId: `chunk-${index + 1}`,
      embedding: vector(index),
      embeddingHash: `hash-${index}`,
      embeddingSetId: setId,
      id: job.id,
      leaseToken: job.lease_token,
    }));
    const first = completions[0];
    if (!first) {
      throw new Error('Fixture requires claimed jobs.');
    }
    // A stale duplicate placed beyond the first batch must neither overwrite
    // its owned chunk nor split the competing leases across statements.
    completions.push({
      ...first,
      embedding: vector(999),
      embeddingHash: 'stale',
      leaseToken: 'stale',
    });
    const completed = await new JobQueue(background).completeEmbeddingChunkBatch(completions);
    await foreground;
    expect(statements).toEqual([65, 64, 2]);
    expect(graphNodes).toEqual([64, 64, 2]);
    expect(
      (await db.query('SELECT embedding_hash FROM file_chunks WHERE id = $1', ['chunk-1'])).rows
    ).toEqual([{ embedding_hash: 'hash-0' }]);
    expect(order).toEqual(['background:65', 'foreground', 'background:64', 'background:2']);
    expect(completed).toHaveLength(count);
    expect(
      (
        await db.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM file_chunks WHERE embedding IS NOT NULL'
        )
      ).rows[0]?.count
    ).toBe(count);
    expect(scheduler.getSnapshot().priorityStats.foreground.completed).toBe(1);
  });
});
