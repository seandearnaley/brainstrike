import { beforeEach, describe, expect, it } from 'vitest';
import { type IDatabase, migrate, wasmLoader } from '../src';
import { JobQueue } from '../src/queue/job-queue';

describe('JobQueue Heartbeat', () => {
  let db: IDatabase;
  let jq: JobQueue;

  beforeEach(async () => {
    const pglite = await wasmLoader.createPGlite('memory://heartbeat-test');
    await migrate(pglite as any);
    db = pglite as unknown as IDatabase;
    jq = new JobQueue(db);
  });

  it('should fail heartbeat if lease is lost/stolen (single)', async () => {
    // 1. Enqueue a job
    await jq.enqueue({
      queue: 'heartbeat-test-queue',
      jobType: 'embed_chunk',
      payload: { data: 'foo' },
    });

    // 2. Worker A claims the job
    const jobA = await jq.claim({
      queue: 'heartbeat-test-queue',
      workerId: 'worker-A',
      leaseMs: 1000,
    });
    expect(jobA).toBeDefined();
    if (!jobA) {
      return;
    }

    // 3. Manually expire the lease (simulate stall)
    await db.query(
      "UPDATE job_queue SET leased_until = NOW() - INTERVAL '1 second' WHERE id = $1",
      [jobA.id]
    );

    // 4. Worker B claims the job (stolen)
    const jobB = await jq.claim({
      queue: 'heartbeat-test-queue',
      workerId: 'worker-B',
      leaseMs: 1000,
    });
    expect(jobB).toBeDefined();
    expect(jobB?.id).toBe(jobA.id);
    expect(jobB?.lease_token).not.toBe(jobA.lease_token);

    // 5. Worker A attempts to heartbeat
    const result = await jq.heartbeat({
      id: jobA.id,
      leaseToken: jobA.lease_token!,
      extendMs: 1000,
    });

    // 6. Verify heartbeat failed (returned null)
    expect(result).toBeNull();

    // 7. Verify Worker B's lease is intact
    const currentJob = await db.query<{ lease_token: string }>(
      'SELECT lease_token FROM job_queue WHERE id = $1',
      [jobA.id]
    );
    expect(currentJob.rows[0]?.lease_token).toBe(jobB?.lease_token);
  });

  describe('heartbeatBatch', () => {
    it('should successfully heartbeat multiple jobs', async () => {
      // Enqueue 3 jobs
      for (let i = 0; i < 3; i++) {
        await jq.enqueue({ queue: 'batch-test', jobType: 'embed_chunk', payload: { i } });
      }

      const jobs = await jq.claimMany({ queue: 'batch-test', leaseMs: 10_000, limit: 3 });
      expect(jobs.length).toBe(3);

      const extendMs = 60_000;
      const now = Date.now();
      const updated = await jq.heartbeatBatch(
        jobs.map((j) => ({ id: j.id, leaseToken: j.lease_token! })),
        extendMs
      );

      expect(updated.length).toBe(3);
      for (const job of updated) {
        const leaseTime = new Date(job.leasedUntil!).getTime();
        expect(leaseTime).toBeGreaterThan(now + extendMs - 1000);
        expect(leaseTime).toBeLessThan(now + extendMs + 1000);
      }
    });

    it('should handle partial success (some leases invalid)', async () => {
      // Enqueue 2 jobs
      await jq.enqueue({ queue: 'batch-partial', jobType: 'embed_chunk', payload: { id: 1 } });
      await jq.enqueue({ queue: 'batch-partial', jobType: 'embed_chunk', payload: { id: 2 } });

      const jobs = await jq.claimMany({ queue: 'batch-partial', leaseMs: 10_000, limit: 2 });
      const [job1, job2] = jobs;

      // Invalidate job2 by changing its lease token in DB
      await db.query("UPDATE job_queue SET lease_token = 'stolen-token' WHERE id = $1", [job2.id]);

      const updated = await jq.heartbeatBatch(
        jobs.map((j) => ({ id: j.id, leaseToken: j.lease_token! })),
        60_000
      );

      // Should only return job1
      expect(updated.length).toBe(1);
      expect(updated[0].id).toBe(job1.id);
    });

    it('should return empty array for empty input', async () => {
      const updated = await jq.heartbeatBatch([], 60_000);
      expect(updated).toEqual([]);
    });

    it('should return empty array if all leases are invalid', async () => {
      await jq.enqueue({ queue: 'batch-fail', jobType: 'embed_chunk', payload: { id: 1 } });
      const [job] = await jq.claimMany({ queue: 'batch-fail', leaseMs: 10_000 });

      const updated = await jq.heartbeatBatch([{ id: job.id, leaseToken: 'wrong-token' }], 60_000);
      expect(updated).toEqual([]);
    });
  });
});
