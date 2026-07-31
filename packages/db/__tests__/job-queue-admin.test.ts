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

  // BST-991: idx_job_queue_dedupe_active (restored on the Drizzle path by
  // migration 078) makes a second ACTIVE row per dedupe_key a hard constraint
  // violation, and requeueFailed is one bulk UPDATE — an unguarded selection
  // would abort the WHOLE retry batch for exactly the users who have failed
  // jobs to retry. These pin the dedupe-aware selection.
  it('requeueFailed skips a failed job whose dedupe key already has an active row', async () => {
    const jq = new JobQueue(db);
    const failedJob = await jq.enqueue({
      dedupeKey: 'chunk-1:set-1',
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: {},
      queue: 'embeddings',
    });
    const c = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(c?.id).toBe(failedJob.id);
    await jq.fail({ error: 'boom', id: c?.id, leaseToken: c?.lease_token as string });
    // An unrelated failed job must still be retried in the same batch. Fail
    // it BEFORE the active duplicate exists so this claim cannot grab the
    // duplicate instead.
    const unrelated = await jq.enqueue({
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: {},
      queue: 'embeddings',
    });
    const c2 = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(c2?.id).toBe(unrelated.id);
    await jq.fail({ error: 'boom', id: c2?.id, leaseToken: c2?.lease_token as string });
    // The backfill re-enqueues the same deterministic key as a NEW active row
    // (enqueue's CTE only considers active states, so this succeeds).
    await jq.enqueue({
      dedupeKey: 'chunk-1:set-1',
      jobType: 'embed_chunk',
      payload: {},
      queue: 'embeddings',
    });

    const moved = await jq.requeueFailed('embeddings', 10);
    expect(moved).toBe(1);

    const stillFailed = await db.query<{ id: string }>(
      `SELECT id FROM job_queue WHERE state = 'failed'`
    );
    expect(stillFailed.rows.map((row) => row.id)).toEqual([failedJob.id]);
  });

  it('requeueFailed retries only the newest of two failed generations of one dedupe key', async () => {
    const jq = new JobQueue(db);
    // Two failed generations of the same key: fail, re-enqueue, fail again.
    for (let generation = 0; generation < 2; generation += 1) {
      await jq.enqueue({
        dedupeKey: 'chunk-2:set-1',
        jobType: 'embed_chunk',
        maxAttempts: 1,
        payload: {},
        queue: 'embeddings',
      });
      const claimed = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
      await jq.fail({
        error: `boom-${generation}`,
        id: claimed?.id,
        leaseToken: claimed?.lease_token as string,
      });
    }

    // Both rows are selectable; retrying both in one bulk UPDATE would
    // collide with the unique index inside the statement itself.
    const moved = await jq.requeueFailed('embeddings', 10);
    expect(moved).toBe(1);

    const states = await db.query<{ n: number; state: string }>(
      `SELECT state, COUNT(*)::int AS n FROM job_queue
        WHERE dedupe_key = 'chunk-2:set-1' GROUP BY state ORDER BY state`
    );
    expect(states.rows).toEqual([
      { n: 1, state: 'failed' },
      { n: 1, state: 'queued' },
    ]);
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
