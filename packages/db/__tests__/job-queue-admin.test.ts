import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/queue/job-queue.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('JobQueue admin helpers', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  it('clear deletes jobs by queue and state', async () => {
    const jq = new JobQueue(db);
    await jq.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'embeddings' });
    await jq.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'embeddings' });
    await jq.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'other' });

    // move one to failed
    const c = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    await jq.fail({ error: 'boom', id: c?.id, leaseToken: c?.lease_token as string });

    const deletedQueued = await jq.clear('embeddings', ['queued']);
    expect(deletedQueued).toBe(2);

    const deletedAllEmbeddings = await jq.clear('embeddings');
    expect(deletedAllEmbeddings).toBe(0);

    const counts = await jq.getCountsByState();
    // only the 'other' queued remains
    const otherQueued = counts.find((r) => r.queue === 'other' && r.state === 'queued')?.count ?? 0;
    expect(otherQueued).toBe(1);
  });

  it('requeueFailed moves failed jobs back to queued', async () => {
    const jq = new JobQueue(db);
    await jq.enqueue({ jobType: 'embed_chunk', maxAttempts: 1, payload: {}, queue: 'embeddings' });
    const c = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    await jq.fail({ error: 'boom', id: c?.id, leaseToken: c?.lease_token as string });

    const moved = await jq.requeueFailed('embeddings', 10);
    expect(moved).toBe(1);

    const stats = await jq.getQueueStats('embeddings');
    expect(stats[0].queued).toBe(1);
    expect(stats[0].failed).toBe(0);
  });

  it('requeueFailed resets exhausted attempts so jobs are claimable', async () => {
    const jq = new JobQueue(db);
    await jq.enqueue({
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: { embeddingSetId: 'set-1' },
      queue: 'embeddings',
    });
    const firstClaim = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    await jq.fail({
      error: 'boom',
      id: firstClaim?.id,
      leaseToken: firstClaim?.lease_token as string,
    });

    const moved = await jq.requeueFailed('embeddings', 10, { embeddingSetId: 'set-1' });
    expect(moved).toBe(1);

    const retriedClaim = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(retriedClaim?.id).toBe(firstClaim?.id);
    expect(retriedClaim?.attempts).toBe(1);
  });

  it('repairs queued jobs that exhausted attempts before a retry reset existed', async () => {
    const jq = new JobQueue(db);
    const job = await jq.enqueue({
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: { embeddingSetId: 'set-1' },
      queue: 'embeddings',
    });
    const firstClaim = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(firstClaim?.id).toBe(job.id);
    await db.query(
      `UPDATE job_queue
          SET state = 'queued',
              lease_token = NULL,
              leased_until = NULL
        WHERE id = $1`,
      [job.id]
    );

    const blockedClaim = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(blockedClaim).toBeNull();

    const repaired = await jq.repairUnclaimableQueued('embeddings', 10, {
      embeddingSetId: 'set-1',
    });
    expect(repaired).toBe(1);

    const repairedClaim = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(repairedClaim?.id).toBe(job.id);
  });
});
