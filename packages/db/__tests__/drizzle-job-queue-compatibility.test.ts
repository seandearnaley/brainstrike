import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { JobQueue } from '../src/queue/job-queue.js';

describe('Drizzle schema JobQueue compatibility', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite({ extensions: { pg_trgm: pgTrgm, vector } });
    const result = await runMigrations(db);
    expect(result.success).toBe(true);
  });

  afterEach(async () => {
    await db.close();
  });

  it('enqueues, claims, completes, and reports stats on the fresh Drizzle schema', async () => {
    const queue = new JobQueue(db);

    const job = await queue.enqueue({
      dedupeKey: 'chunk-1:set-alpha',
      jobType: 'embed_chunk',
      payload: { chunkId: 'chunk-1', embeddingSetId: 'set-alpha' },
      queue: 'embeddings',
    });

    expect(job.id).toBeTruthy();
    expect(job.state).toBe('queued');
    expect(job.payload).toEqual({ chunkId: 'chunk-1', embeddingSetId: 'set-alpha' });

    const claimed = await queue.claim({ leaseMs: 5000, queue: 'embeddings' });
    expect(claimed).not.toBeNull();
    if (!claimed) {
      throw new Error('Expected queued job to be claimed.');
    }
    expect(claimed.id).toBe(job.id);
    expect(claimed.state).toBe('running');

    const statsWhileRunning = await queue.getQueueStats('embeddings');
    expect(statsWhileRunning[0]?.running).toBe(1);

    const completed = await queue.complete({
      id: claimed.id,
      leaseToken: claimed.lease_token,
    });
    expect(completed?.state).toBe('succeeded');

    const statsAfterCompletion = await queue.getQueueStats('embeddings');
    expect(statsAfterCompletion[0]?.succeeded).toBe(1);
  });

  it('preserves nullable payloads through queue claim and completion', async () => {
    const queue = new JobQueue(db);

    const job = await queue.enqueue({
      jobType: 'embed_chunk',
      payload: null,
      queue: 'embeddings',
    });

    expect(job.payload).toBeNull();

    const claimed = await queue.claim({ leaseMs: 5000, queue: 'embeddings' });
    expect(claimed).not.toBeNull();
    if (!claimed) {
      throw new Error('Expected null-payload job to be claimed.');
    }
    expect(claimed.payload).toBeNull();

    const completed = await queue.complete({
      id: claimed.id,
      leaseToken: claimed.lease_token,
    });

    expect(completed?.payload).toBeNull();
    expect(completed?.state).toBe('succeeded');
  });
});
