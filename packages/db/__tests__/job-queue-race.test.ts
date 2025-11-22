import { beforeEach, describe, expect, it } from 'vitest';
import { type IDatabase, migrate, wasmLoader } from '../src';
import { JobQueue } from '../src/queue/job-queue';

describe('JobQueue Race Condition', () => {
  let db: IDatabase;
  let jq: JobQueue;

  beforeEach(async () => {
    const pglite = await wasmLoader.createPGlite('memory://race-test');
    // biome-ignore lint/suspicious/noExplicitAny: PGlite type mismatch with migration runner
    await migrate(pglite as any);
    db = pglite as unknown as IDatabase;
    jq = new JobQueue(db);
  });

  it('should handle high concurrency claims without contention errors', async () => {
    const JOB_COUNT = 50;
    const WORKER_COUNT = 10;

    // 1. Enqueue a batch of jobs
    for (let i = 0; i < JOB_COUNT; i++) {
      await jq.enqueue({
        queue: 'race-test-queue',
        jobType: 'embed_chunk',
        payload: { index: i },
      });
    }

    // 2. Simulate concurrent workers claiming jobs
    const workers = Array.from({ length: WORKER_COUNT }, (_, i) => ({
      id: `worker-${i}`,
      claimed: 0,
    }));

    // Run a loop for each worker to claim jobs until empty
    await Promise.all(
      workers.map(async (worker) => {
        while (true) {
          const job = await jq.claim({
            queue: 'race-test-queue',
            workerId: worker.id,
            leaseMs: 1000,
          });

          if (!job) {
            // If we can't claim, double check if queue is actually empty
            // In a race condition, claim() returns null even if jobs exist
            const pending = await db.query<{ count: number }>(
              "SELECT count(*) as count FROM job_queue WHERE queue = 'race-test-queue' AND state = 'queued'"
            );
            const count = Number(pending.rows[0]?.count || 0);
            if (count > 0) {
              // This is the race condition! We failed to claim but jobs exist.
            }
            break;
          }

          worker.claimed++;
          // Simulate work
          await jq.complete({
            id: job.id,
            leaseToken: job.lease_token!,
          });
        }
      })
    );

    const totalClaimed = workers.reduce((sum, w) => sum + w.claimed, 0);
    console.log(`Total claimed: ${totalClaimed}/${JOB_COUNT}`);

    // Without SKIP LOCKED, this often fails to claim all jobs efficiently
    // or takes excessive retries (simulated by the loop).
    // But strictly speaking, if claim() returns null while jobs exist, that's the bug.

    // Let's verify all jobs were processed
    const finalState = await db.query<{ count: number }>(
      "SELECT count(*) as count FROM job_queue WHERE queue = 'race-test-queue' AND state = 'succeeded'"
    );
    expect(Number(finalState.rows[0]?.count)).toBe(JOB_COUNT);
  });
});
