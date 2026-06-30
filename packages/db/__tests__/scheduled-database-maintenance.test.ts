import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue, type JobState } from '../src/queue/job-queue.js';
import {
  DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
  runScheduledDatabaseMaintenance,
  runTursoScheduledDatabaseMaintenance,
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

  it('skips pruning and vacuum while job queue work is active', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GROUP BY state')) {
        return { rows: [{ count: '2', state: 'queued' }] };
      }
      return { rows: [{ count: '0' }] };
    });
    const exec = vi.fn(async () => undefined);

    const result = await runScheduledDatabaseMaintenance(
      { exec, query },
      {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
      }
    );

    expect(result).toMatchObject({
      activeJobs: 2,
      reason: 'active-job-queue',
      status: 'skipped',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();
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
      query: db.query.bind(db),
      exec: vi.fn(async (sql: string) => {
        if (sql.startsWith('VACUUM')) {
          throw new Error('vacuum exploded after prune');
        }
        return await db.exec(sql);
      }),
    };

    await expect(
      runScheduledDatabaseMaintenance(failingVacuumDb, {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: 60 * 60 * 1000,
      })
    ).rejects.toThrow('vacuum exploded after prune');

    expect(await countJobs(db)).toBe(1);
  });

  it('prunes old terminal jobs and analyzes SQLite tables without unsupported maintenance SQL', async () => {
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      expect(sql).not.toMatch(/\$[0-9]|::text|WITH\s+del|VACUUM\s+[a-z_]|PRAGMA\s+optimize/i);
      if (sql.includes('GROUP BY state')) {
        return { rows: [{ count: 8, state: 'succeeded' }] };
      }
      if (sql.startsWith('DELETE FROM job_queue')) {
        expect(params).toEqual(['2026-05-01T11:00:00.000Z', 'succeeded', 'failed', 'canceled']);
        return { rows: [{ deleted: 1 }, { deleted: 1 }] };
      }
      throw new Error(`Unexpected Turso maintenance query: ${sql}`);
    });
    const exec = vi.fn(async (sql: string) => {
      expect(sql).toBe('ANALYZE job_queue');
    });

    const result = await runTursoScheduledDatabaseMaintenance(
      { exec, query },
      {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: 60 * 60 * 1000,
      }
    );

    expect(result).toMatchObject({
      activeJobs: 0,
      analyzedTables: ['job_queue'],
      prunedTerminalJobs: 2,
      status: 'completed',
      vacuumedTables: [],
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
