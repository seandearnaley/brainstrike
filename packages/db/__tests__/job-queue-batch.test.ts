import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('JobQueue Batch Operations', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://job-queue-batch-tests');
    await migrate(db);
  });

  it('completes multiple jobs atomically', async () => {
    const queue = new JobQueue(db);
    const job1 = await queue.enqueue({ queue: 'q1', jobType: 'embed_chunk', payload: {} });
    const job2 = await queue.enqueue({ queue: 'q1', jobType: 'embed_chunk', payload: {} });

    const claimed = await queue.claimMany({ queue: 'q1', leaseMs: 5000, limit: 2 });
    expect(claimed).toHaveLength(2);

    const completionParams = claimed.map((j) => ({
      id: j.id,
      leaseToken: j.lease_token as string,
    }));

    const completed = await queue.completeBatch(completionParams);
    expect(completed).toHaveLength(2);
    expect(completed.map((j) => j.id).sort()).toEqual([job1.id, job2.id].sort());
    expect(completed.every((j) => j.state === 'succeeded')).toBe(true);
  });

  it('handles empty batch gracefully', async () => {
    const queue = new JobQueue(db);
    const result = await queue.completeBatch([]);
    expect(result).toEqual([]);
  });

  it('only completes jobs with valid leases', async () => {
    const queue = new JobQueue(db);
    const job1 = await queue.enqueue({ queue: 'q1', jobType: 'embed_chunk', payload: {} });
    const claimed = await queue.claim({ queue: 'q1', leaseMs: 5000 });
    expect(claimed).not.toBeNull();

    const result = await queue.completeBatch([
      { id: claimed!.id, leaseToken: claimed!.lease_token as string },
      { id: 'fake-id', leaseToken: 'fake-token' }, // Should be ignored
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(job1.id);
  });
});
