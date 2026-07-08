import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue, migrate, wasmLoader } from '../src/index.js';

describe('JobQueue stats', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://job-queue-stats');
    await migrate(db);
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
