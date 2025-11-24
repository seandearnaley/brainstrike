import { beforeEach, describe, expect, it } from 'vitest';
import { type IDatabase, migrate, wasmLoader } from '../src';
import { JobQueue } from '../src/queue/job-queue';

describe('JobQueue Heartbeat Split Brain', () => {
  let db: IDatabase;
  let jq: JobQueue;

  beforeEach(async () => {
    const pglite = await wasmLoader.createPGlite('memory://heartbeat-test');
    // biome-ignore lint/suspicious/noExplicitAny: PGlite type mismatch with migration runner
    await migrate(pglite as any);
    db = pglite as unknown as IDatabase;
    jq = new JobQueue(db);
  });

  it('should fail heartbeat if lease is lost/stolen', async () => {
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
    if (!jobA) return;

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
});
