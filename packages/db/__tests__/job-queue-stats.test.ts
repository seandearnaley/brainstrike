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
});
