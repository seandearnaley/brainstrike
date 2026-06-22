export type DimensionIndexMaintenanceState = 'failed' | 'pending' | 'running' | 'succeeded';
export type DimensionIndexMaintenanceStrategy = 'concurrent' | 'regular';
export type DimensionIndexMaintenanceSkipReason =
  | 'active-job-queue'
  | 'max-attempts'
  | 'no-pending-maintenance';
export type DimensionIndexMaintenanceStatus = 'completed' | 'failed' | 'skipped';

export interface DimensionIndexMaintenanceRow {
  readonly attempts: number;
  readonly completedAt: string | null;
  readonly dimension: number;
  readonly lastDurationMs: number | null;
  readonly lastError: string | null;
  readonly lastForegroundProbeMaxMs: number | null;
  readonly lastForegroundProbeP95Ms: number | null;
  readonly lastInvalidIndexName: string | null;
  readonly nextRunAt: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly state: DimensionIndexMaintenanceState;
  readonly strategy: DimensionIndexMaintenanceStrategy;
}

export interface DimensionIndexSuspensionRow {
  readonly dimension: number;
  readonly reason: string;
  readonly suspendedAt: string;
}

export interface RequestDimensionIndexMaintenanceInput {
  readonly dimension: number;
  readonly now?: () => Date;
  readonly reason: string;
  readonly strategy: DimensionIndexMaintenanceStrategy;
}

export interface DimensionIndexMaintenanceClockOptions {
  readonly now?: () => Date;
  readonly strategy?: DimensionIndexMaintenanceStrategy;
}

export interface RunDimensionIndexMaintenanceOptions {
  readonly createIndex: (request: {
    readonly dimension: number;
    readonly strategy: DimensionIndexMaintenanceStrategy;
  }) => Promise<void>;
  readonly foregroundProbeMaxMs?: number | null;
  readonly foregroundProbeP95Ms?: number | null;
  readonly listInvalidIndexes?: () => Promise<
    readonly { readonly indexName: string; readonly isReady: boolean; readonly isValid: boolean }[]
  >;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
  readonly retryBackoffMs?: number;
  readonly strategy: DimensionIndexMaintenanceStrategy;
}

export type RunDimensionIndexMaintenanceResult =
  | {
      readonly activeJobs: number;
      readonly reason: DimensionIndexMaintenanceSkipReason;
      readonly status: 'skipped';
    }
  | {
      readonly dimension: number;
      readonly durationMs: number;
      readonly status: 'completed';
      readonly strategy: DimensionIndexMaintenanceStrategy;
    }
  | {
      readonly dimension: number;
      readonly error: string;
      readonly status: 'failed';
      readonly strategy: DimensionIndexMaintenanceStrategy;
    };

interface QueryResult<TRecord> {
  readonly rows: readonly TRecord[];
}

interface DimensionIndexMaintenanceDb {
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<QueryResult<TRecord>>;
}

interface MaintenanceRowRecord {
  readonly attempts: number | string;
  readonly completed_at: string | null;
  readonly dimension: number;
  readonly last_duration_ms: number | string | null;
  readonly last_error: string | null;
  readonly last_foreground_probe_max_ms: number | string | null;
  readonly last_foreground_probe_p95_ms: number | string | null;
  readonly last_invalid_index_name: string | null;
  readonly next_run_at: string;
  readonly reason: string;
  readonly requested_at: string;
  readonly started_at: string | null;
  readonly state: DimensionIndexMaintenanceState;
  readonly strategy: DimensionIndexMaintenanceStrategy;
}

interface SuspensionRowRecord {
  readonly dimension: number;
  readonly reason: string;
  readonly suspended_at: string;
}

interface JobStateCountRow {
  readonly count: number | string | null;
  readonly state: string;
}

const ACTIVE_JOB_STATES = new Set(['queued', 'running']);
const DEFAULT_RETRY_BACKOFF_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

function normalizeCount(value: number | string | null | undefined, label: string): number {
  const normalized = Number(value ?? 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return normalized;
}

function normalizeNullableNumber(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }
  return normalizeCount(value, 'dimension index maintenance numeric value');
}

function mapMaintenanceRow(row: MaintenanceRowRecord): DimensionIndexMaintenanceRow {
  return {
    attempts: normalizeCount(row.attempts, 'dimension index maintenance attempts'),
    completedAt: row.completed_at,
    dimension: row.dimension,
    lastDurationMs: normalizeNullableNumber(row.last_duration_ms),
    lastError: row.last_error,
    lastForegroundProbeMaxMs: normalizeNullableNumber(row.last_foreground_probe_max_ms),
    lastForegroundProbeP95Ms: normalizeNullableNumber(row.last_foreground_probe_p95_ms),
    lastInvalidIndexName: row.last_invalid_index_name,
    nextRunAt: row.next_run_at,
    reason: row.reason,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    state: row.state,
    strategy: row.strategy,
  };
}

function validateDimension(dimension: number): void {
  if (!Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error('Dimension index maintenance dimension must be a positive safe integer.');
  }
}

function validateReason(reason: string): void {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('Dimension index maintenance reason must be non-empty.');
  }
}

function validateStrategy(strategy: DimensionIndexMaintenanceStrategy): void {
  if (strategy !== 'regular' && strategy !== 'concurrent') {
    throw new Error(`Invalid dimension index maintenance strategy: ${String(strategy)}`);
  }
}

function resolveNow(now?: () => Date): Date {
  const resolved = now?.() ?? new Date();
  if (!(resolved instanceof Date) || Number.isNaN(resolved.getTime())) {
    throw new Error('Dimension index maintenance now() returned an invalid Date.');
  }
  return resolved;
}

function resolveRetryBackoffMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_RETRY_BACKOFF_MS;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error('Dimension index maintenance retryBackoffMs must be non-negative.');
  }
  return resolved;
}

function resolveMaxAttempts(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error('Dimension index maintenance maxAttempts must be a positive safe integer.');
  }
  return resolved;
}

function validateOptionalProbeMetric(value: number | null | undefined, label: string): void {
  if (value === null || value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readActiveJobCount(db: DimensionIndexMaintenanceDb): Promise<number> {
  const result = await db.query<JobStateCountRow>(
    `SELECT state, COUNT(*)::text AS count
       FROM job_queue
      GROUP BY state`
  );
  return result.rows.reduce((sum, row) => {
    if (!ACTIVE_JOB_STATES.has(row.state)) {
      return sum;
    }
    return sum + normalizeCount(row.count, 'active job count');
  }, 0);
}

export async function listDimensionIndexMaintenance(
  db: DimensionIndexMaintenanceDb
): Promise<readonly DimensionIndexMaintenanceRow[]> {
  const result = await db.query<MaintenanceRowRecord>(
    `SELECT dimension,
            state,
            reason,
            strategy,
            requested_at,
            next_run_at,
            started_at,
            completed_at,
            attempts,
            last_duration_ms,
            last_foreground_probe_p95_ms,
            last_foreground_probe_max_ms,
            last_invalid_index_name,
            last_error
       FROM embedding_dimension_index_maintenance
      ORDER BY dimension`
  );
  return result.rows.map(mapMaintenanceRow);
}

export async function listDimensionIndexSuspensions(
  db: DimensionIndexMaintenanceDb
): Promise<readonly DimensionIndexSuspensionRow[]> {
  const result = await db.query<SuspensionRowRecord>(
    `SELECT dimension, reason, suspended_at
       FROM embedding_dimension_index_suspensions
      ORDER BY dimension`
  );
  return result.rows.map((row) => ({
    dimension: row.dimension,
    reason: row.reason,
    suspendedAt: row.suspended_at,
  }));
}

export async function requestDimensionIndexMaintenance(
  db: DimensionIndexMaintenanceDb,
  request: RequestDimensionIndexMaintenanceInput
): Promise<void> {
  validateDimension(request.dimension);
  validateReason(request.reason);
  validateStrategy(request.strategy);
  const nowIso = resolveNow(request.now).toISOString();

  await db.query(
    `INSERT INTO embedding_dimension_index_maintenance
       (dimension, state, reason, strategy, requested_at, next_run_at, attempts)
     VALUES ($1, 'pending', $2, $3, $4, $4, 0)
     ON CONFLICT (dimension) DO UPDATE
       SET state = 'pending',
           reason = EXCLUDED.reason,
           strategy = EXCLUDED.strategy,
           requested_at = EXCLUDED.requested_at,
           next_run_at = EXCLUDED.next_run_at,
           attempts = 0,
           started_at = NULL,
           completed_at = NULL
     WHERE embedding_dimension_index_maintenance.state <> 'running'`,
    [request.dimension, request.reason, request.strategy, nowIso]
  );
}

export async function reconcileSuspendedDimensionIndexMaintenance(
  db: DimensionIndexMaintenanceDb,
  options: DimensionIndexMaintenanceClockOptions = {}
): Promise<number> {
  const strategy = options.strategy ?? 'regular';
  validateStrategy(strategy);
  const now = resolveNow(options.now);
  const result = await db.query<{ dimension: number; reason: string }>(
    `SELECT s.dimension, s.reason
       FROM embedding_dimension_index_suspensions s
       LEFT JOIN embedding_dimension_index_maintenance m
         ON m.dimension = s.dimension
        AND m.state IN ('pending', 'running')
      WHERE m.dimension IS NULL
      ORDER BY s.dimension`
  );

  for (const row of result.rows) {
    await requestDimensionIndexMaintenance(db, {
      dimension: row.dimension,
      now: () => now,
      reason: row.reason,
      strategy,
    });
  }

  return result.rows.length;
}

async function claimNextMaintenance(
  db: DimensionIndexMaintenanceDb,
  nowIso: string,
  maxAttempts: number,
  strategy: DimensionIndexMaintenanceStrategy
): Promise<DimensionIndexMaintenanceRow | null> {
  const result = await db.query<MaintenanceRowRecord>(
    `WITH candidate AS (
       SELECT dimension
         FROM embedding_dimension_index_maintenance
        WHERE state = 'pending'
          AND next_run_at <= $1
          AND attempts < $2
        ORDER BY next_run_at, requested_at, dimension
        LIMIT 1
     )
     UPDATE embedding_dimension_index_maintenance m
        SET state = 'running',
            strategy = $3,
            started_at = $1,
            completed_at = NULL,
            attempts = attempts + 1
       FROM candidate
      WHERE m.dimension = candidate.dimension
      RETURNING m.dimension,
                m.state,
                m.reason,
                m.strategy,
                m.requested_at,
                m.next_run_at,
                m.started_at,
                m.completed_at,
                m.attempts,
                m.last_duration_ms,
                m.last_foreground_probe_p95_ms,
                m.last_foreground_probe_max_ms,
                m.last_invalid_index_name,
                m.last_error`,
    [nowIso, maxAttempts, strategy]
  );
  const row = result.rows[0];
  return row ? mapMaintenanceRow(row) : null;
}

async function hasMaxAttemptBlockedPending(
  db: DimensionIndexMaintenanceDb,
  nowIso: string,
  maxAttempts: number
): Promise<boolean> {
  const result = await db.query<{ count: number | string | null }>(
    `SELECT COUNT(*)::text AS count
       FROM embedding_dimension_index_maintenance
      WHERE state = 'pending'
        AND next_run_at <= $1
        AND attempts >= $2`,
    [nowIso, maxAttempts]
  );
  return normalizeCount(result.rows[0]?.count, 'max attempt pending count') > 0;
}

async function readLastInvalidIndexName(
  options: RunDimensionIndexMaintenanceOptions,
  dimension: number
): Promise<string | null> {
  const invalidIndexes = (await options.listInvalidIndexes?.()) ?? [];
  const expectedIndexName = `idx_file_chunks_emb_hnsw_${dimension}`;
  return invalidIndexes.find((index) => index.indexName === expectedIndexName)?.indexName ?? null;
}

export async function runNextDimensionIndexMaintenance(
  db: DimensionIndexMaintenanceDb,
  options: RunDimensionIndexMaintenanceOptions
): Promise<RunDimensionIndexMaintenanceResult> {
  validateStrategy(options.strategy);
  validateOptionalProbeMetric(options.foregroundProbeMaxMs, 'foregroundProbeMaxMs');
  validateOptionalProbeMetric(options.foregroundProbeP95Ms, 'foregroundProbeP95Ms');
  const startedAtDate = resolveNow(options.now);
  const startedAt = startedAtDate.toISOString();
  const startedAtMs = startedAtDate.getTime();
  const retryBackoffMs = resolveRetryBackoffMs(options.retryBackoffMs);
  const maxAttempts = resolveMaxAttempts(options.maxAttempts);

  await reconcileSuspendedDimensionIndexMaintenance(db, {
    now: () => startedAtDate,
    strategy: options.strategy,
  });

  const activeJobs = await readActiveJobCount(db);
  if (activeJobs > 0) {
    return {
      activeJobs,
      reason: 'active-job-queue',
      status: 'skipped',
    };
  }

  const claimed = await claimNextMaintenance(db, startedAt, maxAttempts, options.strategy);
  if (!claimed) {
    if (await hasMaxAttemptBlockedPending(db, startedAt, maxAttempts)) {
      return { activeJobs: 0, reason: 'max-attempts', status: 'skipped' };
    }
    return { activeJobs: 0, reason: 'no-pending-maintenance', status: 'skipped' };
  }

  try {
    await options.createIndex({ dimension: claimed.dimension, strategy: claimed.strategy });
    const completedAtDate = resolveNow(options.now);
    const completedAt = completedAtDate.toISOString();
    const durationMs = Math.max(0, completedAtDate.getTime() - startedAtMs);
    await db.query(
      `DELETE FROM embedding_dimension_index_suspensions
        WHERE dimension = $1`,
      [claimed.dimension]
    );
    await db.query(
      `UPDATE embedding_dimension_index_maintenance
          SET state = 'succeeded',
              completed_at = $2,
              last_duration_ms = $3,
              last_foreground_probe_p95_ms = $4,
              last_foreground_probe_max_ms = $5,
              last_invalid_index_name = NULL,
              last_error = NULL
        WHERE dimension = $1`,
      [
        claimed.dimension,
        completedAt,
        durationMs,
        options.foregroundProbeP95Ms ?? null,
        options.foregroundProbeMaxMs ?? null,
      ]
    );
    return {
      dimension: claimed.dimension,
      durationMs,
      status: 'completed',
      strategy: claimed.strategy,
    };
  } catch (error) {
    const message = errorMessage(error);
    const invalidIndexName =
      claimed.strategy === 'concurrent'
        ? await readLastInvalidIndexName(options, claimed.dimension)
        : null;
    const nextState: DimensionIndexMaintenanceState =
      claimed.attempts >= maxAttempts ? 'failed' : 'pending';
    const nextRunAt = new Date(startedAtMs + retryBackoffMs).toISOString();
    await db.query(
      `UPDATE embedding_dimension_index_maintenance
          SET state = $2,
              next_run_at = $3,
              completed_at = $4,
              last_duration_ms = $5,
              last_foreground_probe_p95_ms = $6,
              last_foreground_probe_max_ms = $7,
              last_invalid_index_name = $8,
              last_error = $9
        WHERE dimension = $1`,
      [
        claimed.dimension,
        nextState,
        nextRunAt,
        startedAt,
        Math.max(0, resolveNow(options.now).getTime() - startedAtMs),
        options.foregroundProbeP95Ms ?? null,
        options.foregroundProbeMaxMs ?? null,
        invalidIndexName,
        message,
      ]
    );
    return {
      dimension: claimed.dimension,
      error: message,
      status: 'failed',
      strategy: claimed.strategy,
    };
  }
}
