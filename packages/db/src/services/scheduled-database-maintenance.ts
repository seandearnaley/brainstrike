import type { JobState } from '../queue/job-queue.js';

export const DEFAULT_DATABASE_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_DATABASE_MAINTENANCE_ANALYZE_TABLES = ['job_queue'] as const;
export const DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS = 60 * 60 * 1000;
export const DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES = ['job_queue'] as const;

const ACTIVE_JOB_STATES = ['queued', 'running'] as const satisfies readonly JobState[];
const TERMINAL_JOB_STATES = [
  'succeeded',
  'failed',
  'canceled',
] as const satisfies readonly JobState[];
const ACTIVE_JOB_STATE_SET: ReadonlySet<JobState> = new Set(ACTIVE_JOB_STATES);
const MAINTENANCE_TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/u;

export type ScheduledDatabaseMaintenanceStatus = 'completed' | 'skipped';
export type ScheduledDatabaseMaintenanceSkipReason = 'active-job-queue';

export interface ScheduledDatabaseMaintenanceOptions {
  readonly analyzeTables?: readonly string[];
  readonly now?: () => Date;
  readonly terminalJobRetentionMs?: number;
  readonly vacuumTables?: readonly string[];
}

export interface ScheduledDatabaseMaintenanceResult {
  readonly activeJobs: number;
  readonly analyzedTables?: readonly string[];
  readonly completedAt: string;
  readonly durationMs: number;
  readonly prunedTerminalJobs: number;
  readonly reason?: ScheduledDatabaseMaintenanceSkipReason;
  readonly startedAt: string;
  readonly status: ScheduledDatabaseMaintenanceStatus;
  readonly vacuumedTables: readonly string[];
}

interface QueryResult<TRecord> {
  readonly rows: readonly TRecord[];
}

interface ScheduledDatabaseMaintenanceDb {
  readonly exec?: (sql: string) => Promise<unknown>;
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<QueryResult<TRecord>>;
}

interface JobStateCountRow {
  readonly count: number | string | null;
  readonly state: JobState;
}

interface CountRow {
  readonly count: number | string | null;
}

function normalizeCount(value: number | string | null | undefined): number {
  const count = Number(value ?? 0);
  if (!Number.isFinite(count) || count < 0) {
    throw new Error(`Invalid database maintenance count: ${String(value)}`);
  }
  return count;
}

function resolveNow(options: ScheduledDatabaseMaintenanceOptions): Date {
  const now = options.now?.() ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error('Scheduled database maintenance now() returned an invalid Date.');
  }
  return now;
}

function resolveTerminalJobRetentionMs(options: ScheduledDatabaseMaintenanceOptions): number {
  const retentionMs =
    options.terminalJobRetentionMs ?? DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS;
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error('Scheduled database maintenance terminalJobRetentionMs must be non-negative.');
  }
  return retentionMs;
}

function resolveVacuumTables(options: ScheduledDatabaseMaintenanceOptions): readonly string[] {
  const tables = options.vacuumTables ?? DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES;
  for (const table of tables) {
    if (!MAINTENANCE_TABLE_NAME_PATTERN.test(table)) {
      throw new Error(`Invalid database maintenance VACUUM table: ${table}`);
    }
  }
  return tables;
}

function resolveAnalyzeTables(options: ScheduledDatabaseMaintenanceOptions): readonly string[] {
  const tables = options.analyzeTables ?? DEFAULT_DATABASE_MAINTENANCE_ANALYZE_TABLES;
  for (const table of tables) {
    if (!MAINTENANCE_TABLE_NAME_PATTERN.test(table)) {
      throw new Error(`Invalid database maintenance ANALYZE table: ${table}`);
    }
  }
  return tables;
}

async function readActiveJobCount(db: ScheduledDatabaseMaintenanceDb): Promise<number> {
  const result = await db.query<JobStateCountRow>(
    `SELECT state, COUNT(*)::text AS count
       FROM job_queue
      GROUP BY state`
  );
  return result.rows.reduce((sum, row) => {
    if (!ACTIVE_JOB_STATE_SET.has(row.state)) {
      return sum;
    }
    return sum + normalizeCount(row.count);
  }, 0);
}

async function readTursoActiveJobCount(db: ScheduledDatabaseMaintenanceDb): Promise<number> {
  const result = await db.query<JobStateCountRow>(
    `SELECT state, COUNT(*) AS count
       FROM job_queue
      GROUP BY state`
  );
  return result.rows.reduce((sum, row) => {
    if (!ACTIVE_JOB_STATE_SET.has(row.state)) {
      return sum;
    }
    return sum + normalizeCount(row.count);
  }, 0);
}

async function pruneTerminalJobs(
  db: ScheduledDatabaseMaintenanceDb,
  olderThanIso: string
): Promise<number> {
  const placeholders = TERMINAL_JOB_STATES.map((_, index) => `$${index + 2}`).join(',');
  const result = await db.query<CountRow>(
    `WITH del AS (
       DELETE FROM job_queue
        WHERE updated_at < $1
          AND state IN (${placeholders})
       RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM del`,
    [olderThanIso, ...TERMINAL_JOB_STATES]
  );
  return normalizeCount(result.rows[0]?.count);
}

async function pruneTursoTerminalJobs(
  db: ScheduledDatabaseMaintenanceDb,
  olderThanIso: string
): Promise<number> {
  const placeholders = TERMINAL_JOB_STATES.map(() => '?').join(',');
  const result = await db.query<{ readonly deleted: number }>(
    `DELETE FROM job_queue
      WHERE updated_at < ?
        AND state IN (${placeholders})
      RETURNING 1 AS deleted`,
    [olderThanIso, ...TERMINAL_JOB_STATES]
  );
  return result.rows.length;
}

async function vacuumTables(
  db: ScheduledDatabaseMaintenanceDb,
  tables: readonly string[]
): Promise<readonly string[]> {
  for (const table of tables) {
    if (!MAINTENANCE_TABLE_NAME_PATTERN.test(table)) {
      throw new Error(`Invalid database maintenance VACUUM table: ${table}`);
    }
    if (typeof db.exec === 'function') {
      await db.exec(`VACUUM ${table}`);
    } else {
      await db.query(`VACUUM ${table}`);
    }
  }
  return tables;
}

async function analyzeTursoTables(
  db: ScheduledDatabaseMaintenanceDb,
  tables: readonly string[]
): Promise<readonly string[]> {
  for (const table of tables) {
    if (!MAINTENANCE_TABLE_NAME_PATTERN.test(table)) {
      throw new Error(`Invalid database maintenance ANALYZE table: ${table}`);
    }
    if (typeof db.exec === 'function') {
      await db.exec(`ANALYZE ${table}`);
    } else {
      await db.query(`ANALYZE ${table}`);
    }
  }
  return tables;
}

export async function runScheduledDatabaseMaintenance(
  db: ScheduledDatabaseMaintenanceDb,
  options: ScheduledDatabaseMaintenanceOptions = {}
): Promise<ScheduledDatabaseMaintenanceResult> {
  const startedAtDate = resolveNow(options);
  const startedAtMs = startedAtDate.getTime();
  const retentionMs = resolveTerminalJobRetentionMs(options);
  const vacuumTableNames = resolveVacuumTables(options);
  const activeJobs = await readActiveJobCount(db);
  const startedAt = startedAtDate.toISOString();

  if (activeJobs > 0) {
    return {
      activeJobs,
      completedAt: startedAt,
      durationMs: 0,
      prunedTerminalJobs: 0,
      reason: 'active-job-queue',
      startedAt,
      status: 'skipped',
      vacuumedTables: [],
    };
  }

  const olderThanIso = new Date(startedAtMs - retentionMs).toISOString();
  // VACUUM cannot be wrapped in a normal transaction. If VACUUM fails after pruning,
  // the next idle maintenance pass retries VACUUM; deleted terminal rows stay deleted.
  const prunedTerminalJobs = await pruneTerminalJobs(db, olderThanIso);
  const vacuumedTables = await vacuumTables(db, vacuumTableNames);
  const completedAtDate = resolveNow(options);

  return {
    activeJobs,
    completedAt: completedAtDate.toISOString(),
    durationMs: Math.max(0, completedAtDate.getTime() - startedAtMs),
    prunedTerminalJobs,
    startedAt,
    status: 'completed',
    vacuumedTables,
  };
}

export async function runTursoScheduledDatabaseMaintenance(
  db: ScheduledDatabaseMaintenanceDb,
  options: ScheduledDatabaseMaintenanceOptions = {}
): Promise<ScheduledDatabaseMaintenanceResult> {
  const startedAtDate = resolveNow(options);
  const startedAtMs = startedAtDate.getTime();
  const retentionMs = resolveTerminalJobRetentionMs(options);
  const analyzeTableNames = resolveAnalyzeTables(options);
  const activeJobs = await readTursoActiveJobCount(db);
  const startedAt = startedAtDate.toISOString();

  if (activeJobs > 0) {
    return {
      activeJobs,
      analyzedTables: [],
      completedAt: startedAt,
      durationMs: 0,
      prunedTerminalJobs: 0,
      reason: 'active-job-queue',
      startedAt,
      status: 'skipped',
      vacuumedTables: [],
    };
  }

  const olderThanIso = new Date(startedAtMs - retentionMs).toISOString();
  const prunedTerminalJobs = await pruneTursoTerminalJobs(db, olderThanIso);
  const analyzedTables = await analyzeTursoTables(db, analyzeTableNames);
  const completedAtDate = resolveNow(options);

  return {
    activeJobs,
    analyzedTables,
    completedAt: completedAtDate.toISOString(),
    durationMs: Math.max(0, completedAtDate.getTime() - startedAtMs),
    prunedTerminalJobs,
    startedAt,
    status: 'completed',
    vacuumedTables: [],
  };
}
