import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue, type JobState } from '../src/queue/job-queue.js';
import {
  DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
  runScheduledDatabaseMaintenance,
} from '../src/services/scheduled-database-maintenance.js';
import { wasmLoader } from '../src/wasm-loader.js';

const NOW_ISO = '2026-05-01T12:00:00.000Z';
const OLD_ISO = '2026-04-29T12:00:00.000Z';
const RECENT_ISO = '2026-05-01T11:59:00.000Z';

async function setJobState(
  db: PGlite,
  jobId: string,
  state: JobState,
  updatedAt: string
): Promise<void> {
  await db.query(
    `UPDATE job_queue
        SET state = $2,
            updated_at = $3
      WHERE id = $1`,
    [jobId, state, updatedAt]
  );
}

async function createJobWithState(
  db: PGlite,
  queue: JobQueue,
  state: JobState,
  updatedAt: string
): Promise<void> {
  const job = await queue.enqueue({
    jobType: 'embed_chunk',
    payload: { state },
    queue: 'embeddings',
  });
  await setJobState(db, job.id, state, updatedAt);
}

async function countJobs(db: PGlite): Promise<number> {
  const result = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM job_queue');
  return Number(result.rows[0]?.count ?? 0);
}

describe('scheduled database maintenance', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(
      `memory://scheduled-database-maintenance-${crypto.randomUUID()}`
    );
    await migrate(db);
  });

  it('prunes finished jobs without vacuum while job queue work is active', async () => {
    // A long backfill keeps the queue active for days; "skip everything while
    // active" let succeeded rows pile into a 1GB table that every status
    // query then scanned. Active passes must still prune succeeded/canceled
    // rows (bounded), keep failed rows for the error UI, and defer VACUUM.
    const queue = new JobQueue(db);
    await createJobWithState(db, queue, 'queued', RECENT_ISO);
    await createJobWithState(db, queue, 'succeeded', OLD_ISO);
    await createJobWithState(db, queue, 'succeeded', OLD_ISO);
    await createJobWithState(db, queue, 'canceled', OLD_ISO);
    await createJobWithState(db, queue, 'failed', OLD_ISO);
    await createJobWithState(db, queue, 'succeeded', RECENT_ISO);

    const result = await runScheduledDatabaseMaintenance(db, {
      now: () => new Date(NOW_ISO),
      terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
    });

    expect(result).toMatchObject({
      activeJobs: 1,
      prunedTerminalJobs: 3,
      reason: 'active-job-queue',
      status: 'partial',
      vacuumedTables: [],
    });
    expect(await countJobs(db)).toBe(3);
    const remainingStates = await db.query<{ state: string }>(
      'SELECT state FROM job_queue ORDER BY state'
    );
    expect(remainingStates.rows.map((row) => row.state)).toEqual(['failed', 'queued', 'succeeded']);
  });

  it('bounds the active-queue prune batch so a huge backlog cannot block the engine', async () => {
    const queue = new JobQueue(db);
    await createJobWithState(db, queue, 'queued', RECENT_ISO);
    await createJobWithState(db, queue, 'succeeded', OLD_ISO);
    await createJobWithState(db, queue, 'succeeded', OLD_ISO);
    await createJobWithState(db, queue, 'succeeded', OLD_ISO);

    const result = await runScheduledDatabaseMaintenance(db, {
      activePruneLimit: 2,
      now: () => new Date(NOW_ISO),
      terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
    });

    expect(result).toMatchObject({
      activeJobs: 1,
      prunedTerminalJobs: 2,
      status: 'partial',
    });
    expect(await countJobs(db)).toBe(2);
  });

  it('rejects a malformed activePruneLimit even when the queue is idle', async () => {
    // No silent fallbacks: a bad option must throw on every pass, not lie
    // dormant until the first active-queue pass exercises the branch.
    await expect(
      runScheduledDatabaseMaintenance(db, {
        activePruneLimit: 0,
        now: () => new Date(NOW_ISO),
      })
    ).rejects.toThrow('activePruneLimit must be a positive integer');
  });

  it('prunes old terminal jobs and vacuums job_queue when the queue is idle', async () => {
    const queue = new JobQueue(db);
    await createJobWithState(db, queue, 'succeeded', OLD_ISO);
    await createJobWithState(db, queue, 'failed', OLD_ISO);
    await createJobWithState(db, queue, 'canceled', OLD_ISO);
    await createJobWithState(db, queue, 'failed', RECENT_ISO);

    const result = await runScheduledDatabaseMaintenance(db, {
      now: () => new Date(NOW_ISO),
      terminalJobRetentionMs: 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      activeJobs: 0,
      prunedTerminalJobs: 3,
      status: 'completed',
      vacuumedTables: ['job_queue'],
    });
    expect(await countJobs(db)).toBe(1);
  });

  it('surfaces vacuum failures instead of reporting a completed maintenance pass', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GROUP BY state')) {
        return { rows: [] };
      }
      return { rows: [{ count: '0' }] };
    });
    const exec = vi.fn(async () => {
      throw new Error('vacuum exploded');
    });

    await expect(
      runScheduledDatabaseMaintenance(
        { exec, query },
        {
          now: () => new Date(NOW_ISO),
          terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
        }
      )
    ).rejects.toThrow('vacuum exploded');
  });

  it('keeps already-pruned terminal jobs when vacuum fails', async () => {
    const queue = new JobQueue(db);
    await createJobWithState(db, queue, 'succeeded', OLD_ISO);
    await createJobWithState(db, queue, 'failed', RECENT_ISO);
    const failingVacuumDb = {
      exec: vi.fn(async (sql: string) => {
        if (sql.startsWith('VACUUM')) {
          throw new Error('vacuum exploded after prune');
        }
        return await db.exec(sql);
      }),
      query: db.query.bind(db),
    };

    await expect(
      runScheduledDatabaseMaintenance(failingVacuumDb, {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: 60 * 60 * 1000,
      })
    ).rejects.toThrow('vacuum exploded after prune');

    expect(await countJobs(db)).toBe(1);
  });
});
