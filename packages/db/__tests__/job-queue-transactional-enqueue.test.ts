import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { insertChunksAndEnqueueEmbeddingJobs } from '../src/chunk-embedding-job-batch.js';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue } from '../src/queue/job-queue.js';
import type { IDatabase } from '../src/repositories/interfaces.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('JobQueue transactional enqueue', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://job-queue-tx');
    await migrate(db);
  });

  async function seedFileAndEmbeddingSet(fileRecordId = 'file-1'): Promise<void> {
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path)
       VALUES ('root-1', 'path', 'root', '/workspace/root')
       ON CONFLICT (id) DO NOTHING`
    );
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions)
       VALUES ('set-1', 'local::test-model', 'test-model', 384)
       ON CONFLICT (id) DO NOTHING`
    );
    await db.query(
      `INSERT INTO file_records (
         id, name, path, size, content_hash, token_count, created_at, updated_at, processed_at,
         root_id
       )
       VALUES ($1, 'a.ts', 'a.ts', 12, 'file-hash', 3, $2, $2, $2, 'root-1')
       ON CONFLICT (id) DO NOTHING`,
      [fileRecordId, now]
    );
  }

  function makeChunk(overrides: { contentHash?: string; fileRecordId?: string } = {}) {
    const now = new Date().toISOString();
    return {
      chunkIndex: 0,
      chunkSize: 16,
      chunkType: 'sentence' as const,
      content: 'chunk content',
      contentHash: overrides.contentHash ?? 'chunk-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      fileRecordId: overrides.fileRecordId ?? 'file-1',
      id: 'chunk-1',
      tokenCount: 2,
      updatedAt: now,
    };
  }

  it('rolls back enqueue when transaction fails', async () => {
    await expect(
      db.transaction(async (tx: PGlite) => {
        const jq = new JobQueue(tx as IDatabase);
        await jq.enqueue({ jobType: 'embed_chunk', payload: { n: 1 }, queue: 'embeddings' });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const rows = await db.query('SELECT COUNT(*)::text as count FROM job_queue');
    const firstRow = rows.rows[0] as { count: string } | undefined;
    expect(Number(firstRow?.count ?? 0)).toBe(0);
  });

  it('inserts chunks and enqueues embedding jobs in one transaction', async () => {
    await seedFileAndEmbeddingSet();

    await insertChunksAndEnqueueEmbeddingJobs(db as unknown as IDatabase, {
      chunks: [makeChunk()],
      dimensionParameter: null,
      fileRecordId: 'file-1',
      model: 'local::test-model',
      provider: 'local',
      targetDimension: 384,
      targetEmbeddingSetId: 'set-1',
    });

    const chunks = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM file_chunks WHERE id = 'chunk-1'`
    );
    const jobs = await db.query<{ chunk_id: string; state: string }>(
      `SELECT chunk_id, state FROM job_queue WHERE job_type = 'embed_chunk'`
    );
    expect(Number(chunks.rows[0]?.count ?? 0)).toBe(1);
    expect(jobs.rows).toEqual([{ chunk_id: 'chunk-1', state: 'queued' }]);
  });

  it('rolls back inserted chunks when embedding job enqueue fails', async () => {
    await seedFileAndEmbeddingSet();
    await seedFileAndEmbeddingSet('file-2');

    await expect(
      insertChunksAndEnqueueEmbeddingJobs(db as unknown as IDatabase, {
        chunks: [makeChunk({ fileRecordId: 'file-2' })],
        dimensionParameter: null,
        fileRecordId: 'file-1',
        model: 'local::test-model',
        provider: 'local',
        targetDimension: 384,
        targetEmbeddingSetId: 'set-1',
      })
    ).rejects.toThrow(
      "Cannot enqueue embedding job for chunk 'chunk-1' with mismatched file record id."
    );

    const chunks = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM file_chunks WHERE id = 'chunk-1'`
    );
    const jobs = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM job_queue WHERE job_type = 'embed_chunk'`
    );
    expect(Number(chunks.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(jobs.rows[0]?.count ?? 0)).toBe(0);
  });
});
