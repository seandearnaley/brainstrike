import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migration105EmbeddingJobInputHash } from '../src/migrations/105-embedding-job-input-hash.js';
import { migrations } from '../src/migrations/index.js';

const VALID_HASH = 'cc48e54faf852e887cf52ea4b232e7c3db4773e5a55c0045e9ee06a8b4151b78';

async function executeMigrationSql(db: PGlite, sql: string): Promise<void> {
  for (const statement of sql.split('--> statement-breakpoint')) {
    await db.exec(statement);
  }
}

describe('migration 105 embedding job input hash', () => {
  let db: PGlite | undefined;

  afterEach(async () => {
    await db?.close();
  });

  it('is the latest numbered migration', () => {
    expect(migrations.at(-1)).toBe(migration105EmbeddingJobInputHash);
  });

  it('backfills provable jobs and visibly cancels unprovable active jobs', async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE file_chunks (
        id uuid PRIMARY KEY,
        content_hash text NOT NULL
      );
      CREATE TABLE job_queue (
        id text PRIMARY KEY,
        queue text NOT NULL,
        job_type text NOT NULL,
        payload jsonb,
        state text NOT NULL,
        leased_until text,
        error text,
        updated_at text NOT NULL
      );
      CREATE TABLE job_queue_metrics (
        queue text PRIMARY KEY,
        canceled_total bigint NOT NULL DEFAULT 0
      );
      INSERT INTO file_chunks (id, content_hash)
      VALUES ('00000000-0000-4000-8000-000000000001', 'hash-1');
      INSERT INTO job_queue
        (id, queue, job_type, payload, state, leased_until, updated_at)
      VALUES
        (
          'active-valid-job',
          'embeddings',
          'embed_chunk',
          '{"chunkId":"00000000-0000-4000-8000-000000000001","modelKey":"text-embedding-3-small","provider":"openai"}',
          'queued',
          NULL,
          '2026-08-21T00:00:00.000Z'
        ),
        (
          'terminal-job',
          'embeddings',
          'embed_chunk',
          '{"chunkId":"00000000-0000-4000-8000-000000000001","modelKey":"text-embedding-3-small","provider":"openai"}',
          'succeeded',
          NULL,
          '2026-08-21T00:00:00.000Z'
        ),
        (
          'orphan-job',
          'embeddings',
          'embed_chunk',
          '{"chunkId":"missing","modelKey":"local::bge-m3"}',
          'running',
          '2026-08-21T00:01:00.000Z',
          '2026-08-21T00:00:00.000Z'
        );
    `);

    if (typeof migration105EmbeddingJobInputHash.up !== 'string') {
      throw new Error('Expected migration 105 up to be SQL text.');
    }
    await executeMigrationSql(db, migration105EmbeddingJobInputHash.up);

    const rows = await db.query<{
      error: string | null;
      hash: string | null;
      id: string;
      leased_until: string | null;
      state: string;
    }>(`
      SELECT
        id,
        state,
        error,
        leased_until,
        payload->>'embeddingInputHash' AS hash
      FROM job_queue
      ORDER BY id
    `);
    expect(rows.rows).toEqual([
      {
        error: null,
        hash: VALID_HASH,
        id: 'active-valid-job',
        leased_until: null,
        state: 'queued',
      },
      {
        error: 'canceled by migration 105: cannot prove embeddingInputHash',
        hash: null,
        id: 'orphan-job',
        leased_until: null,
        state: 'canceled',
      },
      { error: null, hash: null, id: 'terminal-job', leased_until: null, state: 'succeeded' },
    ]);

    const metrics = await db.query<{ canceled_total: string | number }>(
      `SELECT canceled_total FROM job_queue_metrics WHERE queue = 'embeddings'`
    );
    expect(Number(metrics.rows[0]?.canceled_total)).toBe(1);
  });
});
