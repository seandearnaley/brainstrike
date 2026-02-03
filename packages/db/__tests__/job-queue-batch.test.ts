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

  describe('enqueueBatch', () => {
    it('enqueues multiple jobs', async () => {
      const queue = new JobQueue(db);
      const jobs = await queue.enqueueBatch([
        { queue: 'q1', jobType: 'embed_chunk', payload: { i: 1 } },
        { queue: 'q1', jobType: 'embed_chunk', payload: { i: 2 } },
      ]);
      expect(jobs).toHaveLength(2);
      expect(jobs[0].state).toBe('queued');
      expect(jobs[1].state).toBe('queued');

      const stats = await queue.getQueueStats('q1');
      expect(stats[0].queued).toBe(2);
    });

    it('deduplicates within batch', async () => {
      const queue = new JobQueue(db);
      const runAt1 = new Date(Date.now() + 1000).toISOString();
      const runAt2 = new Date(Date.now() + 500).toISOString();

      const jobs = await queue.enqueueBatch([
        {
          queue: 'q1',
          jobType: 'embed_chunk',
          payload: { i: 1 },
          dedupeKey: 'k1',
          runAt: runAt1,
        },
        {
          queue: 'q1',
          jobType: 'embed_chunk',
          payload: { i: 2 },
          dedupeKey: 'k1',
          runAt: runAt2,
        },
      ]);

      // Should return 1 job
      expect(jobs).toHaveLength(1);
      expect(jobs[0].dedupe_key).toBe('k1');
      // Should pick the earlier runAt (runAt2)
      expect(new Date(jobs[0].runAt).getTime()).toBe(new Date(runAt2).getTime());
    });

    it('updates existing job if deduplicated', async () => {
      const queue = new JobQueue(db);
      const job1 = await queue.enqueue({
        queue: 'q1',
        jobType: 'embed_chunk',
        payload: {},
        dedupeKey: 'k1',
      });

      const newRunAt = new Date(Date.now() - 1000).toISOString(); // Earlier
      const jobs = await queue.enqueueBatch([
        {
          queue: 'q1',
          jobType: 'embed_chunk',
          payload: { updated: true },
          dedupeKey: 'k1',
          runAt: newRunAt,
        },
      ]);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(job1.id);
      expect(new Date(jobs[0].runAt).getTime()).toBe(new Date(newRunAt).getTime());
    });

    it('handles mixed new and existing jobs', async () => {
      const queue = new JobQueue(db);
      const existing = await queue.enqueue({
        queue: 'q1',
        jobType: 'embed_chunk',
        payload: {},
        dedupeKey: 'existing',
      });

      const jobs = await queue.enqueueBatch([
        { queue: 'q1', jobType: 'embed_chunk', payload: { i: 1 }, dedupeKey: 'existing' },
        { queue: 'q1', jobType: 'embed_chunk', payload: { i: 2 }, dedupeKey: 'new' },
      ]);

      expect(jobs).toHaveLength(2);
      const jobExisting = jobs.find((j) => j.dedupe_key === 'existing');
      const jobNew = jobs.find((j) => j.dedupe_key === 'new');

      expect(jobExisting?.id).toBe(existing.id);
      expect(jobNew?.id).not.toBe(existing.id);
    });

    it('handles empty batch', async () => {
      const queue = new JobQueue(db);
      const jobs = await queue.enqueueBatch([]);
      expect(jobs).toEqual([]);
    });
  });
});
