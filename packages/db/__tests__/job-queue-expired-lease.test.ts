import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/queue/job-queue.js';
import type { IDatabase } from '../src/repositories/interfaces.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('JobQueue expired lease claiming', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  it('claims expired running jobs and bumps attempts on claim', async () => {
    const jq = new JobQueue(db as IDatabase);
    await jq.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'embeddings' });
    const c1 = await jq.claim({ leaseMs: 50, queue: 'embeddings' });
    expect(c1).not.toBeNull();
    const id = c1?.id as string;
    const token = c1?.lease_token as string;

    // Force lease to be expired by setting leased_until in the past
    await db.query('UPDATE job_queue SET leased_until = $1 WHERE id = $2', [
      new Date(Date.now() - 10_000).toISOString(),
      id,
    ]);

    const c2 = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(c2).not.toBeNull();
    expect(c2?.id).toBe(id);
    // attempts should have incremented on both claims
    expect((c2?.attempts as number) >= 2).toBe(true);
    expect((await jq.getQueueStats('embeddings'))[0]?.failedLifetime).toBe(0);

    // complete via the new lease token
    const done = await jq.complete({ id, leaseToken: (c2?.lease_token as string) || token });
    expect(done?.state).toBe('succeeded');
  });

  it('terminalizes an expired final lease once and releases its dedupe key', async () => {
    const jq = new JobQueue(db as IDatabase);
    const first = await jq.enqueue({
      dedupeKey: 'exhausted-input',
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: {},
      queue: 'embeddings',
    });
    const claimed = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(claimed?.id).toBe(first.id);
    const staleToken = claimed?.lease_token as string;
    await db.query('UPDATE job_queue SET leased_until = $1 WHERE id = $2', [
      new Date(Date.now() - 10_000).toISOString(),
      first.id,
    ]);

    expect(await jq.claim({ leaseMs: 1000, queue: 'embeddings' })).toBeNull();
    expect(await jq.claim({ leaseMs: 1000, queue: 'embeddings' })).toBeNull();
    const terminal = await db.query<{
      attempts: number;
      error: string | null;
      lease_token: string | null;
      leased_until: string | null;
      state: string;
    }>('SELECT state, attempts, error, lease_token, leased_until FROM job_queue WHERE id = $1', [
      first.id,
    ]);
    expect(terminal.rows[0]).toMatchObject({
      attempts: 1,
      error: 'Job lease expired after maximum attempts.',
      lease_token: null,
      leased_until: null,
      state: 'failed',
    });
    const metrics = await jq.getQueueStats('embeddings');
    expect(metrics[0]).toMatchObject({ failed: 1, failedLifetime: 1, running: 0 });
    expect(await jq.heartbeat({ extendMs: 1000, id: first.id, leaseToken: staleToken })).toBeNull();
    expect(await jq.complete({ id: first.id, leaseToken: staleToken })).toBeNull();

    const replacement = await jq.enqueue({
      dedupeKey: 'exhausted-input',
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: {},
      queue: 'embeddings',
    });
    expect(replacement.id).not.toBe(first.id);
  });

  it('keeps an unexpired final lease owned by its worker', async () => {
    const jq = new JobQueue(db as IDatabase);
    const first = await jq.enqueue({
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: {},
      queue: 'embeddings',
    });
    const claimed = await jq.claim({ leaseMs: 60_000, queue: 'embeddings' });
    expect(claimed?.id).toBe(first.id);
    expect(await jq.claim({ leaseMs: 1000, queue: 'embeddings' })).toBeNull();
    const row = await db.query<{ attempts: number; state: string }>(
      'SELECT state, attempts FROM job_queue WHERE id = $1',
      [first.id]
    );
    expect(row.rows[0]).toMatchObject({ attempts: 1, state: 'running' });
    expect((await jq.getQueueStats('embeddings'))[0]).toMatchObject({
      failedLifetime: 0,
      running: 1,
    });
  });

  it('counts a final lease failure once when workers poll together', async () => {
    const firstWorker = new JobQueue(db as IDatabase);
    const secondWorker = new JobQueue(db as IDatabase);
    const job = await firstWorker.enqueue({
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: {},
      queue: 'embeddings',
    });
    expect(await firstWorker.claim({ leaseMs: 1000, queue: 'embeddings' })).not.toBeNull();
    await db.query('UPDATE job_queue SET leased_until = $1 WHERE id = $2', [
      new Date(Date.now() - 10_000).toISOString(),
      job.id,
    ]);

    const claims = await Promise.all([
      firstWorker.claim({ leaseMs: 1000, queue: 'embeddings' }),
      secondWorker.claim({ leaseMs: 1000, queue: 'embeddings' }),
    ]);
    expect(claims).toEqual([null, null]);
    const row = await db.query<{ state: string }>('SELECT state FROM job_queue WHERE id = $1', [
      job.id,
    ]);
    expect(row.rows[0]?.state).toBe('failed');
    expect((await firstWorker.getQueueStats('embeddings'))[0]?.failedLifetime).toBe(1);
  });

  it('does not fail a final lease extended by its owner before recovery', async () => {
    const jq = new JobQueue(db as IDatabase);
    const first = await jq.enqueue({
      jobType: 'embed_chunk',
      maxAttempts: 1,
      payload: {},
      queue: 'embeddings',
    });
    const claimed = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(claimed?.id).toBe(first.id);
    await db.query('UPDATE job_queue SET leased_until = $1 WHERE id = $2', [
      new Date(Date.now() - 10_000).toISOString(),
      first.id,
    ]);
    const extended = await jq.heartbeat({
      extendMs: 60_000,
      id: first.id,
      leaseToken: claimed?.lease_token as string,
    });
    expect(extended?.state).toBe('running');

    expect(await jq.claim({ leaseMs: 1000, queue: 'embeddings' })).toBeNull();
    const row = await db.query<{ attempts: number; state: string }>(
      'SELECT state, attempts FROM job_queue WHERE id = $1',
      [first.id]
    );
    expect(row.rows[0]).toMatchObject({ attempts: 1, state: 'running' });
    expect((await jq.getQueueStats('embeddings'))[0]?.failedLifetime).toBe(0);
  });
});
