import { buildPruneJobsStatement, type JobState } from '../queue/job-queue.js';

export const DEFAULT_DATABASE_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS = 60 * 60 * 1000;
export const DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES = ['job_queue'] as const;
// PGlite runs a single standalone backend with no autovacuum launcher, so
// column statistics are never collected unless maintenance runs ANALYZE
// explicitly (plain VACUUM does not build histograms). These tables grow to
// 100k+ rows and drive grep JOIN ordering, tsvector/BM25 estimates, and the
// dedupe CTE plans.
export const DEFAULT_DATABASE_MAINTENANCE_ANALYZE_TABLES = [
  'file_chunks',
  'file_records',
  'embedding_cache',
] as const;
export const DEFAULT_DATABASE_MAINTENANCE_ACTIVE_PRUNE_LIMIT = 5000;
// BST-1198: brainstrike_tool_call_telemetry (migration 083) grows one row per
// tool call with no other retention path. 60 days comfortably covers the
// bounded before/after baseline windows the table exists for (BASELINE.md)
// while still bounding growth. Mirrors the terminal-job retention shape:
// idle passes do a full sweep, active-queue passes still prune in a bounded
// batch so a huge backlog cannot block the single-connection engine.
export const DEFAULT_DATABASE_MAINTENANCE_TOOL_CALL_TELEMETRY_RETENTION_MS =
  60 * 24 * 60 * 60 * 1000;
const TOOL_CALL_TELEMETRY_TABLE = 'brainstrike_tool_call_telemetry';

const ACTIVE_JOB_STATES = ['queued', 'running'] as const satisfies readonly JobState[];
const TERMINAL_JOB_STATES = [
  'succeeded',
  'failed',
  'canceled',
] as const satisfies readonly JobState[];
// While the queue is active, failed rows stay (they feed the failed-count
// badge, last-error display, and retry); only finished/abandoned rows go.
const ACTIVE_PRUNE_JOB_STATES = ['succeeded', 'canceled'] as const satisfies readonly JobState[];
const ACTIVE_JOB_STATE_SET: ReadonlySet<JobState> = new Set(ACTIVE_JOB_STATES);
const VACUUM_TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/u;

export type ScheduledDatabaseMaintenanceStatus = 'completed' | 'partial' | 'skipped';
export type ScheduledDatabaseMaintenanceSkipReason = 'active-job-queue';

export interface ScheduledDatabaseMaintenanceOptions {
  readonly activePruneLimit?: number;
  readonly analyzeTables?: readonly string[];
  readonly now?: () => Date;
  readonly terminalJobRetentionMs?: number;
  readonly toolCallTelemetryRetentionMs?: number;
  readonly vacuumTables?: readonly string[];
}

export interface ScheduledDatabaseMaintenanceResult {
  readonly activeJobs: number;
  readonly analyzedTables: readonly string[];
  readonly completedAt: string;
  readonly durationMs: number;
  readonly prunedTerminalJobs: number;
  readonly prunedToolCallTelemetryRows: number;
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
  // Desktop's RemoteDbClient exposes a dedicated maintenance channel with a
  // long-running timeout (db-host-manager maintenanceRequestTimeoutMs); the
  // ordinary query/exec path uses the short request timeout and can abandon a
  // large VACUUM/ANALYZE in the main process while the DB host keeps running it.
  readonly maintenance?: {
    readonly exec?: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  };
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

function resolveToolCallTelemetryRetentionMs(options: ScheduledDatabaseMaintenanceOptions): number {
  const retentionMs =
    options.toolCallTelemetryRetentionMs ??
    DEFAULT_DATABASE_MAINTENANCE_TOOL_CALL_TELEMETRY_RETENTION_MS;
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error(
      'Scheduled database maintenance toolCallTelemetryRetentionMs must be non-negative.'
    );
  }
  return retentionMs;
}

function resolveActivePruneLimit(options: ScheduledDatabaseMaintenanceOptions): number {
  const limit = options.activePruneLimit ?? DEFAULT_DATABASE_MAINTENANCE_ACTIVE_PRUNE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('Scheduled database maintenance activePruneLimit must be a positive integer.');
  }
  return limit;
}

function resolveVacuumTables(options: ScheduledDatabaseMaintenanceOptions): readonly string[] {
  const tables = options.vacuumTables ?? DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES;
  for (const table of tables) {
    if (!VACUUM_TABLE_NAME_PATTERN.test(table)) {
      throw new Error(`Invalid database maintenance VACUUM table: ${table}`);
    }
  }
  return tables;
}

function resolveAnalyzeTables(options: ScheduledDatabaseMaintenanceOptions): readonly string[] {
  const tables = options.analyzeTables ?? DEFAULT_DATABASE_MAINTENANCE_ANALYZE_TABLES;
  for (const table of tables) {
    if (!VACUUM_TABLE_NAME_PATTERN.test(table)) {
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

async function pruneTerminalJobs(
  db: ScheduledDatabaseMaintenanceDb,
  olderThanIso: string
): Promise<number> {
  // Shared statement builder (BST-991 slice 2): this DELETE was hand-written
  // here AND in JobQueue.prune — one source now.
  const { params, sql } = buildPruneJobsStatement(TERMINAL_JOB_STATES, olderThanIso);
  const result = await db.query<CountRow>(sql, params);
  return normalizeCount(result.rows[0]?.count);
}

async function pruneFinishedJobsBounded(
  db: ScheduledDatabaseMaintenanceDb,
  olderThanIso: string,
  limit: number
): Promise<number> {
  const { params, sql } = buildPruneJobsStatement(ACTIVE_PRUNE_JOB_STATES, olderThanIso, limit);
  const result = await db.query<CountRow>(sql, params);
  return normalizeCount(result.rows[0]?.count);
}

async function pruneToolCallTelemetry(
  db: ScheduledDatabaseMaintenanceDb,
  olderThanIso: string
): Promise<number> {
  const result = await db.query<CountRow>(
    `WITH del AS (
       DELETE FROM ${TOOL_CALL_TELEMETRY_TABLE}
        WHERE occurred_at < $1
       RETURNING 1
     ) SELECT COUNT(*)::text AS count FROM del`,
    [olderThanIso]
  );
  return normalizeCount(result.rows[0]?.count);
}

async function pruneToolCallTelemetryBounded(
  db: ScheduledDatabaseMaintenanceDb,
  olderThanIso: string,
  limit: number
): Promise<number> {
  const result = await db.query<CountRow>(
    `WITH del AS (
       DELETE FROM ${TOOL_CALL_TELEMETRY_TABLE}
        WHERE id IN (
          SELECT id FROM ${TOOL_CALL_TELEMETRY_TABLE}
           WHERE occurred_at < $1
           LIMIT $2
        )
       RETURNING 1
     ) SELECT COUNT(*)::text AS count FROM del`,
    [olderThanIso, limit]
  );
  return normalizeCount(result.rows[0]?.count);
}

async function runMaintenanceStatement(
  db: ScheduledDatabaseMaintenanceDb,
  sql: string
): Promise<void> {
  if (typeof db.maintenance?.exec === 'function') {
    await db.maintenance.exec(sql);
  } else if (typeof db.exec === 'function') {
    await db.exec(sql);
  } else {
    await db.query(sql);
  }
}

async function vacuumTables(
  db: ScheduledDatabaseMaintenanceDb,
  tables: readonly string[]
): Promise<readonly string[]> {
  for (const table of tables) {
    if (!VACUUM_TABLE_NAME_PATTERN.test(table)) {
      throw new Error(`Invalid database maintenance VACUUM table: ${table}`);
    }
    // ANALYZE piggybacks on the vacuum pass so the planner gets fresh column
    // statistics for these tables too (no autovacuum launcher in PGlite).
    await runMaintenanceStatement(db, `VACUUM (ANALYZE) ${table}`);
  }
  return tables;
}

async function analyzeTables(
  db: ScheduledDatabaseMaintenanceDb,
  tables: readonly string[]
): Promise<readonly string[]> {
  for (const table of tables) {
    if (!VACUUM_TABLE_NAME_PATTERN.test(table)) {
      throw new Error(`Invalid database maintenance ANALYZE table: ${table}`);
    }
    await runMaintenanceStatement(db, `ANALYZE ${table}`);
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
  // Validated on every pass (not just idle ones) for the same reason as the
  // other retention/limit options below: a malformed value must fail loudly
  // immediately, not lie dormant until the queue happens to go idle.
  const toolCallTelemetryRetentionMs = resolveToolCallTelemetryRetentionMs(options);
  const vacuumTableNames = resolveVacuumTables(options);
  // Validated on every pass (not just idle ones) so a malformed option
  // throws immediately instead of lying dormant until the queue goes idle.
  const analyzeTableNames = resolveAnalyzeTables(options);
  // Validated on every pass (not just active ones) so a malformed option
  // throws immediately instead of lying dormant until the queue gets busy.
  const activePruneLimit = resolveActivePruneLimit(options);
  const activeJobs = await readActiveJobCount(db);
  const startedAt = startedAtDate.toISOString();

  if (activeJobs > 0) {
    // A long backfill keeps the queue active for days. Skipping maintenance
    // outright let finished rows accumulate into a table every status query
    // then scanned, so active passes still prune succeeded/canceled rows in a
    // bounded batch (one short statement on the single-statement engine) and
    // only defer the heavyweight VACUUM until the queue is idle.
    const activeOlderThanIso = new Date(startedAtMs - retentionMs).toISOString();
    const prunedTerminalJobs = await pruneFinishedJobsBounded(
      db,
      activeOlderThanIso,
      activePruneLimit
    );
    // Telemetry pruning is a bounded, index-backed age DELETE unrelated to job
    // queue VACUUM cost, so it still runs (bounded) while the queue is busy —
    // otherwise a long-running backfill would let telemetry rows accumulate
    // unbounded for the same reason job rows once did.
    const telemetryActiveOlderThanIso = new Date(
      startedAtMs - toolCallTelemetryRetentionMs
    ).toISOString();
    const prunedToolCallTelemetryRows = await pruneToolCallTelemetryBounded(
      db,
      telemetryActiveOlderThanIso,
      activePruneLimit
    );
    const partialCompletedAtDate = resolveNow(options);
    return {
      activeJobs,
      analyzedTables: [],
      completedAt: partialCompletedAtDate.toISOString(),
      durationMs: Math.max(0, partialCompletedAtDate.getTime() - startedAtMs),
      prunedTerminalJobs,
      prunedToolCallTelemetryRows,
      reason: 'active-job-queue',
      startedAt,
      status: 'partial',
      vacuumedTables: [],
    };
  }

  const olderThanIso = new Date(startedAtMs - retentionMs).toISOString();
  const telemetryOlderThanIso = new Date(startedAtMs - toolCallTelemetryRetentionMs).toISOString();
  // VACUUM/ANALYZE cannot be wrapped in a normal transaction. If VACUUM or
  // ANALYZE fails after pruning, the next idle maintenance pass retries them;
  // deleted terminal rows stay deleted.
  const prunedTerminalJobs = await pruneTerminalJobs(db, olderThanIso);
  const prunedToolCallTelemetryRows = await pruneToolCallTelemetry(db, telemetryOlderThanIso);
  const vacuumedTables = await vacuumTables(db, vacuumTableNames);
  const analyzedTables = await analyzeTables(db, analyzeTableNames);
  const completedAtDate = resolveNow(options);

  return {
    activeJobs,
    analyzedTables,
    completedAt: completedAtDate.toISOString(),
    durationMs: Math.max(0, completedAtDate.getTime() - startedAtMs),
    prunedTerminalJobs,
    prunedToolCallTelemetryRows,
    startedAt,
    status: 'completed',
    vacuumedTables,
  };
}
