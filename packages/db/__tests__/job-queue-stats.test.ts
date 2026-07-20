import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/index.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('JobQueue stats', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  it('returns counts by state and queue stats', async () => {
    const jq = new JobQueue(db);
    await jq.enqueue({ jobType: 'embed_chunk', payload: { id: 1 }, queue: 'embeddings' });
    await jq.enqueue({ jobType: 'embed_chunk', payload: { id: 2 }, queue: 'embeddings' });
    await jq.enqueue({ jobType: 'embed_chunk', payload: { id: 3 }, queue: 'other' });

    const c1 = await jq.getCountsByState();
    expect(c1.find((r) => r.queue === 'embeddings' && r.state === 'queued')?.count).toBe(2);
    expect(c1.find((r) => r.queue === 'other' && r.state === 'queued')?.count).toBe(1);

    const claim = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(claim?.state).toBe('running');

    const stats = await jq.getQueueStats('embeddings');
    expect(stats).toHaveLength(1);
    expect(stats[0].queue).toBe('embeddings');
    expect(stats[0].queued).toBe(1);
    expect(stats[0].running).toBe(1);
    expect(typeof stats[0].nextRunnableAt === 'string' || stats[0].nextRunnableAt === null).toBe(
      true
    );
  });

  it('tracks a durable lifetime succeeded count that survives pruning of succeeded rows', async () => {
    const jq = new JobQueue(db);
    for (const id of [1, 2, 3]) {
      await jq.enqueue({ jobType: 'embed_chunk', payload: { id }, queue: 'embeddings' });
    }

    // Complete all three via a mix of single + batch completion paths.
    const first = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    await jq.complete({ id: first!.id, leaseToken: first!.lease_token! });
    const second = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    const third = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    await jq.completeBatch([
      { id: second!.id, leaseToken: second!.lease_token! },
      { id: third!.id, leaseToken: third!.lease_token! },
    ]);

    const afterComplete = await jq.getQueueStats('embeddings');
    expect(afterComplete[0].succeeded).toBe(3);
    expect(afterComplete[0].succeededLifetime).toBe(3);

    // Simulate scheduled-maintenance pruning: the succeeded rows are deleted,
    // so the live count drops to 0 but the lifetime total must not regress.
    await db.query("DELETE FROM job_queue WHERE state = 'succeeded'");

    const afterPrune = await jq.getQueueStats('embeddings');
    expect(afterPrune[0]?.succeeded ?? 0).toBe(0);
    expect(afterPrune[0].succeededLifetime).toBe(3);

    // Further completions accumulate on top of the retained total.
    await jq.enqueue({ jobType: 'embed_chunk', payload: { id: 4 }, queue: 'embeddings' });
    const fourth = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    await jq.complete({ id: fourth!.id, leaseToken: fourth!.lease_token! });

    const afterMore = await jq.getQueueStats('embeddings');
    expect(afterMore[0].succeededLifetime).toBe(4);
  });

  it('counts a terminal failure exactly once and never counts a retryable failure', async () => {
    const jq = new JobQueue(db);

    // Retryable failure: job goes back to 'queued', so nothing terminal happened yet.
    await jq.enqueue({
      jobType: 'embed_chunk',
      maxAttempts: 3,
      payload: { id: 1 },
      queue: 'embeddings',
    });
    const first = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    const retried = await jq.fail({
      error: 'transient',
      id: first!.id,
      leaseToken: first!.lease_token!,
    });
    expect(retried?.state).toBe('queued');

    const afterRetry = await jq.getQueueStats('embeddings');
    expect(afterRetry[0].failedLifetime).toBe(0);

    // Terminal failure: counted exactly once.
    const second = await jq.claim({
      leaseMs: 1000,
      now: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      queue: 'embeddings',
    });
    const failed = await jq.fail({
      error: 'poison pill',
      id: second!.id,
      leaseToken: second!.lease_token!,
      terminal: true,
    });
    expect(failed?.state).toBe('failed');

    const afterTerminal = await jq.getQueueStats('embeddings');
    expect(afterTerminal[0].failedLifetime).toBe(1);

    // A duplicate terminal fail with the same lease must not double count.
    const duplicate = await jq.fail({
      error: 'poison pill again',
      id: second!.id,
      leaseToken: second!.lease_token!,
      terminal: true,
    });
    expect(duplicate).toBeNull();
    const afterDuplicate = await jq.getQueueStats('embeddings');
    expect(afterDuplicate[0].failedLifetime).toBe(1);
  });

  it('counts attempts-exhausted failures from failBatch', async () => {
    const jq = new JobQueue(db);
    await jq.enqueue({
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: { id: 1 },
      queue: 'embeddings',
    });
    await jq.enqueue({
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: { id: 2 },
      queue: 'embeddings',
    });

    const claimed = await jq.claimMany({ leaseMs: 1000, limit: 2, queue: 'embeddings' });
    expect(claimed).toHaveLength(2);
    const failedJobs = await jq.failBatch({
      error: 'exhausted',
      jobs: claimed.map((job) => ({ id: job.id, leaseToken: job.lease_token! })),
    });
    expect(failedJobs.map((job) => job.state)).toEqual(['failed', 'failed']);

    const stats = await jq.getQueueStats('embeddings');
    expect(stats[0].failedLifetime).toBe(2);
  });

  it('counts single and bulk cancellations in the lifetime canceled total', async () => {
    const jq = new JobQueue(db);
    for (const id of [1, 2, 3]) {
      await jq.enqueue({ jobType: 'embed_chunk', payload: { id }, queue: 'embeddings' });
    }

    const first = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    const canceled = await jq.cancel({ id: first!.id, reason: 'user request' });
    expect(canceled?.state).toBe('canceled');

    const afterSingle = await jq.getQueueStats('embeddings');
    expect(afterSingle[0].canceledLifetime).toBe(1);

    // Cancel of an already-canceled job is a no-op and must not double count.
    const duplicate = await jq.cancel({ id: first!.id });
    expect(duplicate).toBeNull();
    const afterDuplicate = await jq.getQueueStats('embeddings');
    expect(afterDuplicate[0].canceledLifetime).toBe(1);

    // Bulk cancel counts every canceled row.
    const bulkCount = await jq.cancelMany('embeddings', 'shutdown');
    expect(bulkCount).toBe(2);
    const afterBulk = await jq.getQueueStats('embeddings');
    expect(afterBulk[0].canceledLifetime).toBe(3);
  });

  it('keeps lifetime failed/canceled totals after terminal rows are pruned', async () => {
    const jq = new JobQueue(db);
    await jq.enqueue({
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: { id: 1 },
      queue: 'embeddings',
    });
    await jq.enqueue({ jobType: 'embed_chunk', payload: { id: 2 }, queue: 'embeddings' });

    const claimed = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    await jq.fail({
      error: 'poison pill',
      id: claimed!.id,
      leaseToken: claimed!.lease_token!,
      terminal: true,
    });
    await jq.cancelMany('embeddings', 'shutdown');

    // Simulate scheduled-maintenance pruning of terminal job rows.
    const pruned = await jq.prune(
      ['succeeded', 'failed', 'canceled'],
      new Date(Date.now() + 60_000).toISOString()
    );
    expect(pruned).toBe(2);

    const stats = await jq.getQueueStats('embeddings');
    expect(stats[0]?.failed ?? 0).toBe(0);
    expect(stats[0].failedLifetime).toBe(1);
    expect(stats[0].canceledLifetime).toBe(1);
  });

  it('keeps the lifetime succeeded count per queue', async () => {
    const jq = new JobQueue(db);
    await jq.enqueue({ jobType: 'embed_chunk', payload: { id: 1 }, queue: 'embeddings' });
    await jq.enqueue({ jobType: 'embed_chunk', payload: { id: 2 }, queue: 'other' });

    const a = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    await jq.complete({ id: a!.id, leaseToken: a!.lease_token! });
    const b = await jq.claim({ leaseMs: 1000, queue: 'other' });
    await jq.complete({ id: b!.id, leaseToken: b!.lease_token! });

    const embeddings = await jq.getQueueStats('embeddings');
    const other = await jq.getQueueStats('other');
    expect(embeddings[0].succeededLifetime).toBe(1);
    expect(other[0].succeededLifetime).toBe(1);
  });
});
