import { createLogger } from '@brainstrike/logging';
import { buildPruneJobsStatement, type JobState } from '../queue/job-queue.js';

const logger = createLogger('ScheduledDatabaseMaintenance');

export const DEFAULT_DATABASE_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS = 60 * 60 * 1000;
// BST-1198 review follow-up: brainstrike_tool_call_telemetry must be VACUUMed
// too, not just pruned. PGlite has no autovacuum launcher (see the ANALYZE
// comment below), so without this the retention DELETE only trades live rows
// for permanently-dead pages — heap and index disk usage keep growing at the
// same rate, just with dead tuples instead of rows. Listing it here also gets
// it ANALYZEd (via `VACUUM (ANALYZE)`), so its readers' plans have
// statistics.
export const DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES = [
  'job_queue',
  'brainstrike_tool_call_telemetry',
  'brainstrike_token_estimate_calibration',
  // Embedding backfills create large numbers of dead file_chunks tuples.
  // Reclaim them here, after the desktop idle/busy gates, rather than inline
  // with backfill completion where a long PGlite VACUUM blocks every query.
  // Ordered last because a vacuum failure aborts the remainder of the pass.
  'file_chunks',
] as const;
// PGlite runs a single standalone backend with no autovacuum launcher, so
// column statistics are never collected unless maintenance runs ANALYZE
// explicitly (plain VACUUM does not build histograms). These tables grow to
// 100k+ rows and drive grep JOIN ordering, tsvector/BM25 estimates, and the
// dedupe CTE plans.
export const DEFAULT_DATABASE_MAINTENANCE_ANALYZE_TABLES = [
  // file_chunks is analyzed by its VACUUM (ANALYZE) entry above.
  'file_records',
  'embedding_cache',
] as const;
export const DEFAULT_DATABASE_MAINTENANCE_ACTIVE_PRUNE_LIMIT = 5000;
export const DEFAULT_DATABASE_MAINTENANCE_SLOW_STATEMENT_MS = 1000;
// BST-1198: brainstrike_tool_call_telemetry (migration 083) grows one row per
// tool call with no other retention path. 60 days comfortably covers the
// bounded before/after baseline windows the table exists for (BASELINE.md)
// while still bounding growth. Mirrors the terminal-job retention shape:
// idle passes do a full sweep, active-queue passes still prune in a bounded
// batch so a huge backlog cannot block the single-connection engine.
export const DEFAULT_DATABASE_MAINTENANCE_TOOL_CALL_TELEMETRY_RETENTION_MS =
  60 * 24 * 60 * 60 * 1000;
export const DEFAULT_DATABASE_MAINTENANCE_TOKEN_ESTIMATE_CALIBRATION_RETENTION_MS =
  60 * 24 * 60 * 60 * 1000;
const TOKEN_ESTIMATE_CALIBRATION_TABLE = 'brainstrike_token_estimate_calibration';
const TOOL_CALL_TELEMETRY_TABLE = 'brainstrike_tool_call_telemetry';
const OCCURRED_AT_RETENTION_TABLES = [
  {
    option: 'toolCallTelemetryRetentionMs',
    resultKey: 'prunedToolCallTelemetryRows',
    table: TOOL_CALL_TELEMETRY_TABLE,
  },
  {
    option: 'tokenEstimateCalibrationRetentionMs',
    resultKey: 'prunedTokenEstimateCalibrationRows',
    table: TOKEN_ESTIMATE_CALIBRATION_TABLE,
  },
] as const;

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
  readonly tokenEstimateCalibrationRetentionMs?: number;
  readonly toolCallTelemetryRetentionMs?: number;
  readonly vacuumTables?: readonly string[];
}

export interface ScheduledDatabaseMaintenanceResult {
  readonly activeJobs: number;
  readonly analyzedTables: readonly string[];
  readonly completedAt: string;
  readonly durationMs: number;
  readonly prunedTerminalJobs: number;
  readonly prunedTokenEstimateCalibrationRows: number;
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

function resolveTokenEstimateCalibrationRetentionMs(
  options: ScheduledDatabaseMaintenanceOptions
): number {
  const retentionMs =
    options.tokenEstimateCalibrationRetentionMs ??
    DEFAULT_DATABASE_MAINTENANCE_TOKEN_ESTIMATE_CALIBRATION_RETENTION_MS;
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error(
      'Scheduled database maintenance tokenEstimateCalibrationRetentionMs must be non-negative.'
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

async function timeMaintenanceStatement<TResult>(
  statement: string,
  operation: () => Promise<TResult>
): Promise<TResult> {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (durationMs >= DEFAULT_DATABASE_MAINTENANCE_SLOW_STATEMENT_MS) {
      logger.warn('Slow scheduled database maintenance statement', {
        durationMs,
        statement,
      });
    }
  }
}

async function readActiveJobCount(db: ScheduledDatabaseMaintenanceDb): Promise<number> {
  const sql = `SELECT state, COUNT(*)::text AS count
       FROM job_queue
      GROUP BY state`;
  const result = await timeMaintenanceStatement(sql, async () => db.query<JobStateCountRow>(sql));
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
  const result = await timeMaintenanceStatement(sql, async () => db.query<CountRow>(sql, params));
  return normalizeCount(result.rows[0]?.count);
}

async function pruneFinishedJobsBounded(
  db: ScheduledDatabaseMaintenanceDb,
  olderThanIso: string,
  limit: number
): Promise<number> {
  const { params, sql } = buildPruneJobsStatement(ACTIVE_PRUNE_JOB_STATES, olderThanIso, limit);
  const result = await timeMaintenanceStatement(sql, async () => db.query<CountRow>(sql, params));
  return normalizeCount(result.rows[0]?.count);
}

async function pruneByOccurredAt(
  db: ScheduledDatabaseMaintenanceDb,
  table: (typeof OCCURRED_AT_RETENTION_TABLES)[number]['table'],
  olderThanIso: string
): Promise<number> {
  const sql = `WITH del AS (
       DELETE FROM ${table}
        WHERE occurred_at < $1
       RETURNING 1
     ) SELECT COUNT(*)::text AS count FROM del`;
  const result = await timeMaintenanceStatement(sql, async () =>
    db.query<CountRow>(sql, [olderThanIso])
  );
  return normalizeCount(result.rows[0]?.count);
}

async function hasExpiredByOccurredAt(
  db: ScheduledDatabaseMaintenanceDb,
  table: (typeof OCCURRED_AT_RETENTION_TABLES)[number]['table'],
  olderThanIso: string
): Promise<boolean> {
  const sql = `SELECT EXISTS (
       SELECT 1 FROM ${table}
        WHERE occurred_at < $1
     ) AS present`;
  const result = await timeMaintenanceStatement(sql, async () =>
    db.query<ExistsRow>(sql, [olderThanIso])
  );
  const present = result.rows[0]?.present;
  if (typeof present !== 'boolean') {
    throw new Error(`Invalid database maintenance EXISTS probe result: ${String(present)}`);
  }
  return present;
}

interface ExistsRow {
  readonly present: boolean;
}

// Cheap-guard probe (BST-1198 review follow-up): the migration-085
// occurred_at-leading index makes this an index scan that stops at the first
// match, so it stays fast even on a large table. The common case on the
// active-queue path is that nothing is past the cutoff yet, and without this
// probe every ~10-minute tick would still pay for planning and running the
// bounded DELETE below for zero deletions.
async function pruneByOccurredAtBounded(
  db: ScheduledDatabaseMaintenanceDb,
  table: (typeof OCCURRED_AT_RETENTION_TABLES)[number]['table'],
  olderThanIso: string,
  limit: number
): Promise<number> {
  if (!(await hasExpiredByOccurredAt(db, table, olderThanIso))) {
    return 0;
  }
  // ORDER BY occurred_at ASC mirrors DiagnosticEventsRepository.purge()'s
  // oldest-first bounded shape (diagnostic-events-repository.ts): once the
  // eligible backlog exceeds `limit`, the oldest rows are evicted first
  // instead of an arbitrary subset.
  const sql = `WITH del AS (
       DELETE FROM ${table}
        WHERE id IN (
          SELECT id FROM ${table}
           WHERE occurred_at < $1
           ORDER BY occurred_at ASC
           LIMIT $2
       )
       RETURNING 1
     ) SELECT COUNT(*)::text AS count FROM del`;
  const result = await timeMaintenanceStatement(sql, async () =>
    db.query<CountRow>(sql, [olderThanIso, limit])
  );
  return normalizeCount(result.rows[0]?.count);
}

async function pruneOccurredAtRetentionTables(
  db: ScheduledDatabaseMaintenanceDb,
  retentionMs: Readonly<Record<(typeof OCCURRED_AT_RETENTION_TABLES)[number]['option'], number>>,
  startedAtMs: number,
  limit?: number
): Promise<
  Pick<
    ScheduledDatabaseMaintenanceResult,
    'prunedTokenEstimateCalibrationRows' | 'prunedToolCallTelemetryRows'
  >
> {
  const counts = {
    prunedTokenEstimateCalibrationRows: 0,
    prunedToolCallTelemetryRows: 0,
  };
  // Registry table names are module-owned constants, never caller input; SQL
  // interpolation therefore retains the existing injection-safe boundary.
  for (const entry of OCCURRED_AT_RETENTION_TABLES) {
    const olderThanIso = new Date(startedAtMs - retentionMs[entry.option]).toISOString();
    counts[entry.resultKey] =
      limit === undefined
        ? await pruneByOccurredAt(db, entry.table, olderThanIso)
        : await pruneByOccurredAtBounded(db, entry.table, olderThanIso, limit);
  }
  return counts;
}

async function runMaintenanceStatement(
  db: ScheduledDatabaseMaintenanceDb,
  sql: string
): Promise<void> {
  await timeMaintenanceStatement(sql, async () => {
    if (typeof db.maintenance?.exec === 'function') {
      await db.maintenance.exec(sql);
    } else if (typeof db.exec === 'function') {
      await db.exec(sql);
    } else {
      await db.query(sql);
    }
  });
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
  const tokenEstimateCalibrationRetentionMs = resolveTokenEstimateCalibrationRetentionMs(options);
  const occurredAtRetentionMs = {
    tokenEstimateCalibrationRetentionMs,
    toolCallTelemetryRetentionMs,
  };
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
    // Telemetry pruning is a bounded age DELETE unrelated to job queue VACUUM
    // cost, so it still runs (bounded) while the queue is busy — otherwise a
    // long-running backfill would let telemetry rows accumulate unbounded for
    // the same reason job rows once did. The migration-085 occurred_at-leading
    // index makes the guard probe and the DELETE itself index scans rather
    // than sequential scans (the migration-083 composite index alone cannot
    // serve this tool_id-less predicate); the shared bounded retention helper
    // also skips each DELETE entirely when nothing is past its cutoff, which
    // is the common case on a ~10-minute tick.
    const { prunedTokenEstimateCalibrationRows, prunedToolCallTelemetryRows } =
      await pruneOccurredAtRetentionTables(
        db,
        occurredAtRetentionMs,
        startedAtMs,
        activePruneLimit
      );
    const partialCompletedAtDate = resolveNow(options);
    return {
      activeJobs,
      analyzedTables: [],
      completedAt: partialCompletedAtDate.toISOString(),
      durationMs: Math.max(0, partialCompletedAtDate.getTime() - startedAtMs),
      prunedTerminalJobs,
      prunedTokenEstimateCalibrationRows,
      prunedToolCallTelemetryRows,
      reason: 'active-job-queue',
      startedAt,
      status: 'partial',
      vacuumedTables: [],
    };
  }

  const olderThanIso = new Date(startedAtMs - retentionMs).toISOString();
  // These maintenance operations are deliberately sequential, not Promise.all'd:
  // 1. PGlite runs a single standalone WASM Postgres backend with no
  //    connection pool (see the PGLITE EXTENSION INVARIANT / durability-gate
  //    notes in docs/agents/database.md) — statements issued concurrently on
  //    one connection are still serialized by the engine, so Promise.all
  //    buys zero real parallelism here, only a misleading appearance of it.
  // 2. There is a genuine data dependency: VACUUM (ANALYZE) on job_queue and
  //    both telemetry tables must observe the dead tuples their prune calls
  //    just created in THOSE SAME tables to reclaim them. Racing a prune and
  //    its own table's VACUUM via Promise.all would be a correctness regression,
  //    not just a missed optimization — VACUUM/ANALYZE also cannot be wrapped
  //    in a normal transaction. The unrelated plain-ANALYZE set runs first so
  //    a slow or failing file_chunks vacuum cannot starve those cheap planner
  //    statistics. If either phase fails after pruning, the next idle pass
  //    retries it; deleted terminal rows stay deleted.
  const prunedTerminalJobs = await pruneTerminalJobs(db, olderThanIso);
  const { prunedTokenEstimateCalibrationRows, prunedToolCallTelemetryRows } =
    await pruneOccurredAtRetentionTables(db, occurredAtRetentionMs, startedAtMs);
  const analyzedTables = await analyzeTables(db, analyzeTableNames);
  const vacuumedTables = await vacuumTables(db, vacuumTableNames);
  const completedAtDate = resolveNow(options);

  return {
    activeJobs,
    analyzedTables,
    completedAt: completedAtDate.toISOString(),
    durationMs: Math.max(0, completedAtDate.getTime() - startedAtMs),
    prunedTerminalJobs,
    prunedTokenEstimateCalibrationRows,
    prunedToolCallTelemetryRows,
    startedAt,
    status: 'completed',
    vacuumedTables,
  };
}
