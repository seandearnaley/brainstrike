import type { IDatabase } from '@brainstrike/db';
import { JobQueue } from '@brainstrike/db';
import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('embedding worker DB completion', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  // Close the real PGlite instance opened in beforeEach so its WASM resources
  // are released between tests (the suffixed siblings, e.g.
  // embedding-worker-batch-optimization.integration.test.ts, do the same).
  afterEach(async () => {
    await db.close();
  });

  it('does not write vectors or mark jobs succeeded after the completion lease is lost', async () => {
    const queue = new JobQueue(db as unknown as IDatabase);
    const now = new Date().toISOString();
    const embeddingSetId = 'set-stale-completion';
    const fileId = 'file-stale-completion';
    const chunkId = 'chunk-stale-completion';
    const embedding = Array.from({ length: 768 }, (_, index) => index / 1000);

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, 'local::test-model', 'test-model', 768, 'cosine', now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        fileId,
        'stale-completion.ts',
        '/stale-completion.ts',
        100,
        'content',
        'stale-completion-hash',
        10,
        embeddingSetId,
        now,
      ]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1,$2,0,$3,$4,$5,'text',10,$6,$6)`,
      [chunkId, fileId, 'content', 'stale-completion-hash', 10, now]
    );

    await queue.enqueue({
      jobType: 'embed_chunk',
      payload: { chunkId, embeddingSetId },
      queue: 'embeddings',
    });
    const claimed = await queue.claim({ leaseMs: 5000, queue: 'embeddings' });
    expect(claimed).not.toBeNull();

    const completed = await queue.completeEmbeddingChunkBatch([
      {
        chunkId,
        embedding,
        embeddingHash: 'stale-completion-embedding-hash',
        embeddingSetId,
        id: claimed?.id ?? '',
        leaseToken: 'stale-lease-token',
      },
    ]);

    expect(completed).toEqual([]);

    const chunk = await db.query<{
      embedding: string | null;
      embedding_hash: string | null;
      embedding_set_id: string | null;
    }>(
      `SELECT embedding::text AS embedding, embedding_hash, embedding_set_id
       FROM file_chunks
       WHERE id = $1`,
      [chunkId]
    );
    expect(chunk.rows[0]).toEqual({
      embedding: null,
      embedding_hash: null,
      embedding_set_id: null,
    });

    const job = await db.query<{ state: string }>('SELECT state FROM job_queue WHERE id = $1', [
      claimed?.id,
    ]);
    expect(job.rows[0]?.state).toBe('running');
  });
});
