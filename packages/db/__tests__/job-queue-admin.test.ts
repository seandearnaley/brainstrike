import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('JobQueue admin helpers', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://job-queue-admin');
    await migrate(db);
  });

  it('clear deletes jobs by queue and state', async () => {
    const jq = new JobQueue(db);
    await jq.enqueue({ queue: 'embeddings', jobType: 'embed_chunk', payload: {} });
    await jq.enqueue({ queue: 'embeddings', jobType: 'embed_chunk', payload: {} });
    await jq.enqueue({ queue: 'other', jobType: 'embed_chunk', payload: {} });

    // move one to failed
    const c = await jq.claim({ queue: 'embeddings', leaseMs: 1000 });
    await jq.fail({ id: c?.id, leaseToken: c?.lease_token as string, error: 'boom' });

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
    await jq.enqueue({ queue: 'embeddings', jobType: 'embed_chunk', payload: {}, maxAttempts: 1 });
    const c = await jq.claim({ queue: 'embeddings', leaseMs: 1000 });
    await jq.fail({ id: c?.id, leaseToken: c?.lease_token as string, error: 'boom' });

    const moved = await jq.requeueFailed('embeddings', 10);
    expect(moved).toBe(1);

    const stats = await jq.getQueueStats('embeddings');
    expect(stats[0].queued).toBe(1);
    expect(stats[0].failed).toBe(0);
  });

  it('requeueFailed resets exhausted attempts so jobs are claimable', async () => {
    const jq = new JobQueue(db);
    await jq.enqueue({
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: { embeddingSetId: 'set-1' },
      maxAttempts: 1,
    });
    const firstClaim = await jq.claim({ queue: 'embeddings', leaseMs: 1000 });
    await jq.fail({
      id: firstClaim?.id,
      leaseToken: firstClaim?.lease_token as string,
      error: 'boom',
    });

    const moved = await jq.requeueFailed('embeddings', 10, { embeddingSetId: 'set-1' });
    expect(moved).toBe(1);

    const retriedClaim = await jq.claim({ queue: 'embeddings', leaseMs: 1000 });
    expect(retriedClaim?.id).toBe(firstClaim?.id);
    expect(retriedClaim?.attempts).toBe(1);
  });

  it('repairs queued jobs that exhausted attempts before a retry reset existed', async () => {
    const jq = new JobQueue(db);
    const job = await jq.enqueue({
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: { embeddingSetId: 'set-1' },
      maxAttempts: 1,
    });
    const firstClaim = await jq.claim({ queue: 'embeddings', leaseMs: 1000 });
    expect(firstClaim?.id).toBe(job.id);
    await db.query(
      `UPDATE job_queue
          SET state = 'queued',
              lease_token = NULL,
              leased_until = NULL
        WHERE id = $1`,
      [job.id]
    );

    const blockedClaim = await jq.claim({ queue: 'embeddings', leaseMs: 1000 });
    expect(blockedClaim).toBeNull();

    const repaired = await jq.repairUnclaimableQueued('embeddings', 10, {
      embeddingSetId: 'set-1',
    });
    expect(repaired).toBe(1);

    const repairedClaim = await jq.claim({ queue: 'embeddings', leaseMs: 1000 });
    expect(repairedClaim?.id).toBe(job.id);
  });
});
