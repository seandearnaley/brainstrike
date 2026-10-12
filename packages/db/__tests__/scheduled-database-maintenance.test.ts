import { addLogListener, type LogRecord } from '@brainstrike/logging';
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue, type JobState } from '../src/queue/job-queue.js';
import {
  DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
  DEFAULT_DATABASE_MAINTENANCE_TOKEN_ESTIMATE_CALIBRATION_RETENTION_MS,
  DEFAULT_DATABASE_MAINTENANCE_TOOL_CALL_TELEMETRY_RETENTION_MS,
  runScheduledDatabaseMaintenance,
} from '../src/services/scheduled-database-maintenance.js';
import { wasmLoader } from '../src/wasm-loader.js';

const NOW_ISO = '2026-05-01T12:00:00.000Z';
const OLD_ISO = '2026-04-29T12:00:00.000Z';
const RECENT_ISO = '2026-05-01T11:59:00.000Z';
// 60-day retention cutoff from NOW_ISO is 2026-03-02T12:00:00.000Z.
const TELEMETRY_OLD_ISO = '2026-02-01T00:00:00.000Z';
const TELEMETRY_RECENT_ISO = '2026-04-25T00:00:00.000Z';

async function insertToolCallTelemetry(
  db: PGlite,
  id: string,
  occurredAtIso: string
): Promise<void> {
  await db.query(
    `INSERT INTO brainstrike_tool_call_telemetry
      (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup)
     VALUES ($1, 'thread', 'run', 'grepSearch', $2, 100, false, false, false)`,
    [id, occurredAtIso]
  );
}

async function countToolCallTelemetry(db: PGlite): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM brainstrike_tool_call_telemetry'
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function insertTokenEstimateCalibration(
  db: PGlite,
  id: string,
  occurredAtIso: string
): Promise<void> {
  await db.query(
    `INSERT INTO brainstrike_token_estimate_calibration
      (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
       final_step_prompt_tokens, occurred_at)
     VALUES ($1, 'thread', 'run', 'gpt-5.6-terra', 'openai', 100, 125, $2)`,
    [id, occurredAtIso]
  );
}

async function countTokenEstimateCalibration(db: PGlite): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM brainstrike_token_estimate_calibration'
  );
  return Number(result.rows[0]?.count ?? 0);
}

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
      analyzedTables: [],
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

  it('prunes old terminal jobs, vacuums job_queue, and analyzes stats tables when the queue is idle', async () => {
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
      analyzedTables: ['file_records', 'embedding_cache'],
      prunedTerminalJobs: 3,
      status: 'completed',
      vacuumedTables: [
        'job_queue',
        'brainstrike_tool_call_telemetry',
        'brainstrike_token_estimate_calibration',
        'file_chunks',
      ],
    });
    expect(await countJobs(db)).toBe(1);
  });

  it('runs VACUUM (ANALYZE) on vacuum tables and plain ANALYZE on analyze tables when idle', async () => {
    // PGlite runs as one standalone backend with no autovacuum launcher, so
    // nothing ever collects column statistics unless maintenance runs ANALYZE
    // explicitly. Plain VACUUM does not build histograms; the planner would
    // keep empty-table stats against 100k+ row tables.
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GROUP BY state')) {
        return { rows: [] };
      }
      return { rows: [{ count: '0' }] };
    });
    const exec = vi.fn(async (sql: string) => {
      statements.push(sql);
      return [];
    });

    const result = await runScheduledDatabaseMaintenance(
      { exec, query },
      {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
      }
    );

    expect(statements).toEqual([
      'ANALYZE file_records',
      'ANALYZE embedding_cache',
      'VACUUM (ANALYZE) job_queue',
      'VACUUM (ANALYZE) brainstrike_tool_call_telemetry',
      'VACUUM (ANALYZE) brainstrike_token_estimate_calibration',
      'VACUUM (ANALYZE) file_chunks',
    ]);
    expect(result).toMatchObject({
      analyzedTables: ['file_records', 'embedding_cache'],
      status: 'completed',
      vacuumedTables: [
        'job_queue',
        'brainstrike_tool_call_telemetry',
        'brainstrike_token_estimate_calibration',
        'file_chunks',
      ],
    });
  });

  it('warns with per-statement attribution when maintenance exceeds one second', async () => {
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.scope === 'ScheduledDatabaseMaintenance') {
        records.push(record);
      }
    });
    let clockMs = 0;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GROUP BY state')) {
        return { rows: [] };
      }
      return { rows: [{ count: '0' }] };
    });
    const exec = vi.fn(async (sql: string) => {
      if (sql === 'ANALYZE file_records') {
        clockMs = 1501;
      }
      return [];
    });

    try {
      await runScheduledDatabaseMaintenance(
        { exec, query },
        {
          analyzeTables: ['file_records'],
          now: () => new Date(NOW_ISO),
          vacuumTables: ['job_queue'],
        }
      );
    } finally {
      dateNow.mockRestore();
      unsubscribe();
    }

    const warning = records.find(
      (record) => record.message === 'Slow scheduled database maintenance statement'
    );
    expect(warning?.level).toBe('warn');
    expect(warning?.args).toContainEqual({
      durationMs: 1501,
      statement: 'ANALYZE file_records',
    });
  });

  it('attributes a slow retention prune to its exact DELETE statement', async () => {
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.scope === 'ScheduledDatabaseMaintenance') {
        records.push(record);
      }
    });
    let clockMs = 0;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GROUP BY state')) {
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM job_queue')) {
        clockMs = 1500;
      }
      return { rows: [{ count: '0' }] };
    });

    try {
      await runScheduledDatabaseMaintenance(
        { exec: vi.fn(async () => []), query },
        {
          analyzeTables: [],
          now: () => new Date(NOW_ISO),
          vacuumTables: [],
        }
      );
    } finally {
      dateNow.mockRestore();
      unsubscribe();
    }

    const warning = records.find(
      (record) => record.message === 'Slow scheduled database maintenance statement'
    );
    expect(warning?.level).toBe('warn');
    expect(warning?.args).toContainEqual({
      durationMs: 1500,
      statement: expect.stringContaining('DELETE FROM job_queue'),
    });
  });

  it('does not run ANALYZE while job queue work is active', async () => {
    const statements: string[] = [];
    const queue = new JobQueue(db);
    await createJobWithState(db, queue, 'queued', RECENT_ISO);
    const trackingDb = {
      exec: async (sql: string) => {
        statements.push(sql);
        return await db.exec(sql);
      },
      query: db.query.bind(db),
    };

    const result = await runScheduledDatabaseMaintenance(trackingDb, {
      now: () => new Date(NOW_ISO),
      terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
    });

    expect(result).toMatchObject({ analyzedTables: [], status: 'partial' });
    expect(statements).toEqual([]);
  });

  it('rejects a malformed analyzeTables entry even when the queue is active', async () => {
    const queue = new JobQueue(db);
    await createJobWithState(db, queue, 'queued', RECENT_ISO);

    await expect(
      runScheduledDatabaseMaintenance(db, {
        analyzeTables: ['file_chunks; DROP TABLE file_chunks'],
        now: () => new Date(NOW_ISO),
      })
    ).rejects.toThrow('Invalid database maintenance ANALYZE table');
  });

  it('surfaces ANALYZE failures so the next idle pass retries', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GROUP BY state')) {
        return { rows: [] };
      }
      return { rows: [{ count: '0' }] };
    });
    const exec = vi.fn(async (sql: string) => {
      if (sql.startsWith('ANALYZE')) {
        throw new Error('analyze exploded');
      }
      return [];
    });

    await expect(
      runScheduledDatabaseMaintenance(
        { exec, query },
        {
          now: () => new Date(NOW_ISO),
          terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
        }
      )
    ).rejects.toThrow('analyze exploded');
    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith('ANALYZE file_records');
  });

  it('routes VACUUM/ANALYZE through the maintenance exec channel when available', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GROUP BY state')) {
        return { rows: [] };
      }
      return { rows: [{ count: '0' }] };
    });
    const exec = vi.fn(async () => []);
    const maintenanceExec = vi.fn(async () => []);

    const result = await runScheduledDatabaseMaintenance(
      { exec, maintenance: { exec: maintenanceExec }, query },
      {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
      }
    );

    // Desktop's RemoteDbClient gives maintenance.exec the long-running timeout;
    // ordinary exec/query use the short request timeout and can abandon a large
    // VACUUM/ANALYZE mid-flight, so every maintenance statement must prefer it.
    expect(maintenanceExec).toHaveBeenCalledWith('VACUUM (ANALYZE) job_queue');
    expect(maintenanceExec).toHaveBeenCalledWith(
      'VACUUM (ANALYZE) brainstrike_tool_call_telemetry'
    );
    expect(maintenanceExec).toHaveBeenCalledWith(
      'VACUUM (ANALYZE) brainstrike_token_estimate_calibration'
    );
    expect(maintenanceExec).toHaveBeenCalledWith('VACUUM (ANALYZE) file_chunks');
    expect(maintenanceExec).toHaveBeenCalledWith('ANALYZE file_records');
    expect(maintenanceExec).toHaveBeenCalledWith('ANALYZE embedding_cache');
    expect(exec).not.toHaveBeenCalled();
    expect(result.vacuumedTables).toEqual([
      'job_queue',
      'brainstrike_tool_call_telemetry',
      'brainstrike_token_estimate_calibration',
      'file_chunks',
    ]);
    expect(result.analyzedTables).toEqual(['file_records', 'embedding_cache']);
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

  describe('tool_call_telemetry retention (BST-1198)', () => {
    it('prunes rows older than 60 days on an idle maintenance tick and keeps newer rows', async () => {
      await insertToolCallTelemetry(db, 'old-1', TELEMETRY_OLD_ISO);
      await insertToolCallTelemetry(db, 'old-2', TELEMETRY_OLD_ISO);
      await insertToolCallTelemetry(db, 'recent-1', TELEMETRY_RECENT_ISO);

      const result = await runScheduledDatabaseMaintenance(db, {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
      });

      expect(result).toMatchObject({
        prunedToolCallTelemetryRows: 2,
        status: 'completed',
      });
      expect(await countToolCallTelemetry(db)).toBe(1);
      const remaining = await db.query<{ id: string }>(
        'SELECT id FROM brainstrike_tool_call_telemetry'
      );
      expect(remaining.rows.map((row) => row.id)).toEqual(['recent-1']);
    });

    it('honors a custom toolCallTelemetryRetentionMs and rejects a malformed one', async () => {
      await insertToolCallTelemetry(db, 'row-1', RECENT_ISO);

      const result = await runScheduledDatabaseMaintenance(db, {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
        toolCallTelemetryRetentionMs: 1000,
      });

      expect(result).toMatchObject({ prunedToolCallTelemetryRows: 1, status: 'completed' });
      expect(await countToolCallTelemetry(db)).toBe(0);

      await expect(
        runScheduledDatabaseMaintenance(db, {
          now: () => new Date(NOW_ISO),
          toolCallTelemetryRetentionMs: -1,
        })
      ).rejects.toThrow('toolCallTelemetryRetentionMs must be non-negative');
    });

    it('still prunes old telemetry rows (bounded) while the job queue is active', async () => {
      const queue = new JobQueue(db);
      await createJobWithState(db, queue, 'queued', RECENT_ISO);
      await insertToolCallTelemetry(db, 'old-1', TELEMETRY_OLD_ISO);
      await insertToolCallTelemetry(db, 'recent-1', TELEMETRY_RECENT_ISO);

      const result = await runScheduledDatabaseMaintenance(db, {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
      });

      expect(result).toMatchObject({
        prunedToolCallTelemetryRows: 1,
        status: 'partial',
      });
      expect(await countToolCallTelemetry(db)).toBe(1);
    });

    it('skips the bounded DELETE entirely while active when nothing is past the cutoff (cheap-guard EXISTS probe)', async () => {
      const queue = new JobQueue(db);
      await createJobWithState(db, queue, 'queued', RECENT_ISO);
      await insertToolCallTelemetry(db, 'recent-1', TELEMETRY_RECENT_ISO);
      const statements: string[] = [];
      const trackingDb = {
        query: async <TRecord = unknown>(sql: string, params?: readonly unknown[]) => {
          statements.push(sql);
          return await db.query<TRecord>(sql, params as unknown[]);
        },
      };

      const result = await runScheduledDatabaseMaintenance(trackingDb, {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
      });

      expect(result).toMatchObject({ prunedToolCallTelemetryRows: 0, status: 'partial' });
      expect(await countToolCallTelemetry(db)).toBe(1);
      expect(statements.some((sql) => sql.includes('EXISTS'))).toBe(true);
      expect(
        statements.some((sql) => sql.includes('DELETE FROM brainstrike_tool_call_telemetry'))
      ).toBe(false);
    });

    it('evicts the oldest rows first when the active-queue backlog exceeds the bound (ORDER BY occurred_at ASC)', async () => {
      const queue = new JobQueue(db);
      await createJobWithState(db, queue, 'queued', RECENT_ISO);
      await insertToolCallTelemetry(db, 'oldest', '2026-01-01T00:00:00.000Z');
      await insertToolCallTelemetry(db, 'older', '2026-01-05T00:00:00.000Z');
      await insertToolCallTelemetry(db, 'old', '2026-01-10T00:00:00.000Z');
      await insertToolCallTelemetry(db, 'less-old', '2026-01-15T00:00:00.000Z');

      const result = await runScheduledDatabaseMaintenance(db, {
        activePruneLimit: 2,
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
      });

      expect(result).toMatchObject({ prunedToolCallTelemetryRows: 2, status: 'partial' });
      const remaining = await db.query<{ id: string }>(
        'SELECT id FROM brainstrike_tool_call_telemetry ORDER BY occurred_at ASC'
      );
      expect(remaining.rows.map((row) => row.id)).toEqual(['old', 'less-old']);
    });
  });

  describe('token_estimate_calibration retention (BST-1205)', () => {
    it('prunes rows older than 60 days on an idle pass and keeps newer rows', async () => {
      await insertTokenEstimateCalibration(db, 'old-calibration', TELEMETRY_OLD_ISO);
      await insertTokenEstimateCalibration(db, 'recent-calibration', TELEMETRY_RECENT_ISO);

      const result = await runScheduledDatabaseMaintenance(db, {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
      });

      expect(result).toMatchObject({
        prunedTokenEstimateCalibrationRows: 1,
        status: 'completed',
      });
      expect(await countTokenEstimateCalibration(db)).toBe(1);
    });

    it('honors a custom retention window and rejects malformed configuration', async () => {
      await insertTokenEstimateCalibration(db, 'calibration', TELEMETRY_RECENT_ISO);

      const result = await runScheduledDatabaseMaintenance(db, {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
        tokenEstimateCalibrationRetentionMs: 1000,
      });

      expect(result.prunedTokenEstimateCalibrationRows).toBe(1);
      await expect(
        runScheduledDatabaseMaintenance(db, {
          now: () => new Date(NOW_ISO),
          tokenEstimateCalibrationRetentionMs: -1,
        })
      ).rejects.toThrow('tokenEstimateCalibrationRetentionMs must be non-negative');
      expect(DEFAULT_DATABASE_MAINTENANCE_TOKEN_ESTIMATE_CALIBRATION_RETENTION_MS).toBe(
        DEFAULT_DATABASE_MAINTENANCE_TOOL_CALL_TELEMETRY_RETENTION_MS
      );
    });

    it('runs the oldest-first bounded prune while the job queue is active', async () => {
      const queue = new JobQueue(db);
      await createJobWithState(db, queue, 'queued', RECENT_ISO);
      await insertTokenEstimateCalibration(db, 'oldest', '2026-01-01T00:00:00.000Z');
      await insertTokenEstimateCalibration(db, 'older', '2026-01-05T00:00:00.000Z');
      await insertTokenEstimateCalibration(db, 'old', '2026-01-10T00:00:00.000Z');

      const result = await runScheduledDatabaseMaintenance(db, {
        activePruneLimit: 2,
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
      });

      expect(result).toMatchObject({
        prunedTokenEstimateCalibrationRows: 2,
        status: 'partial',
      });
      const remaining = await db.query<{ id: string }>(
        'SELECT id FROM brainstrike_token_estimate_calibration ORDER BY occurred_at ASC'
      );
      expect(remaining.rows.map((row) => row.id)).toEqual(['old']);
    });

    it('skips the active bounded DELETE when the guard finds no expired row', async () => {
      const queue = new JobQueue(db);
      await createJobWithState(db, queue, 'queued', RECENT_ISO);
      await insertTokenEstimateCalibration(db, 'recent', TELEMETRY_RECENT_ISO);
      const statements: string[] = [];
      const trackingDb = {
        query: async <TRecord = unknown>(sql: string, params?: readonly unknown[]) => {
          statements.push(sql);
          return await db.query<TRecord>(sql, params as unknown[]);
        },
      };

      const result = await runScheduledDatabaseMaintenance(trackingDb, {
        now: () => new Date(NOW_ISO),
        terminalJobRetentionMs: DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
      });

      expect(result.prunedTokenEstimateCalibrationRows).toBe(0);
      expect(
        statements.some((sql) => sql.includes('DELETE FROM brainstrike_token_estimate_calibration'))
      ).toBe(false);
    });
  });
});
