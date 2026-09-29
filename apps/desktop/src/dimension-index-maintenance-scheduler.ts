import {
  type DatabaseWorkRunOptions,
  type DimensionIndexMaintenanceStrategy,
  estimateEmbeddedRowCount,
  hnswParams,
  isBackgroundDatabaseWorkAdmitted,
  type RunDimensionIndexMaintenanceOptions,
  type RunDimensionIndexMaintenanceResult,
  runNextDimensionIndexMaintenance,
  withIndexBuildMaintenanceWorkMem,
} from '@brainstrike/db';
import type { WorkspaceIndexingPowerSnapshot } from '@brainstrike/indexing-contract/workspace-indexing-power-snapshot';
import type { Effect, Scope } from 'effect';
import {
  containDatabaseIntegrityError,
  type DesktopDatabaseIntegrity,
} from './database-integrity-state';
import type { DimensionIndexBuildStrategy } from './dimension-index-maintenance-capabilities';
import {
  createSustainedIdleObserver,
  DEFAULT_MAINTENANCE_QUIET_PERIOD_MS,
  isDatabaseSchedulerBusy,
  type MaintenanceSchedulerSnapshot,
  readInFlightAssistantWork,
} from './maintenance-admission';
import {
  acquireMaintenanceTriggerResources,
  createMaintenanceTriggerRuntime,
} from './maintenance-trigger-runtime';

const DEFAULT_DIMENSION_INDEX_MAINTENANCE_INITIAL_DELAY_MS = 45_000;
const DEFAULT_DIMENSION_INDEX_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
const MIN_IDLE_MS = 120_000;

interface DimensionIndexMaintenanceDb {
  readonly maintenance?: {
    readonly exec: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  };
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<{ rows: readonly TRecord[] }>;
}

type RunScheduledWork = <TResult>(
  options: DatabaseWorkRunOptions,
  work: () => Promise<TResult>
) => Promise<TResult>;

type RunDimensionMaintenance = (
  db: DimensionIndexMaintenanceDb,
  options: RunDimensionIndexMaintenanceOptions
) => Promise<RunDimensionIndexMaintenanceResult>;

interface MaintenanceLogger {
  readonly debug: (context: Record<string, unknown>, message: string) => void;
  readonly error: (context: Record<string, unknown>, message: string) => void;
  readonly info: (context: Record<string, unknown>, message: string) => void;
  readonly warn?: (context: Record<string, unknown>, message: string) => void;
}

export type DesktopDimensionIndexMaintenanceSkipReason =
  | 'already-running'
  | 'assistant-work-in-flight'
  | 'database-integrity-contained'
  | 'database-scheduler-busy'
  | 'database-scheduler-recently-busy'
  | 'power-not-ac'
  | 'power-not-idle'
  | 'strategy-unavailable'
  | 'thermal-pressure';

export type DesktopDimensionIndexMaintenanceRunResult =
  | RunDimensionIndexMaintenanceResult
  | {
      readonly reason: DesktopDimensionIndexMaintenanceSkipReason;
      readonly status: 'skipped';
    };

export interface DesktopDimensionIndexMaintenanceScheduler {
  readonly acquireTrigger: (isLive: () => boolean) => Effect.Effect<void, never, Scope.Scope>;
  readonly close: () => Promise<void>;
  readonly runOnce: () => Promise<DesktopDimensionIndexMaintenanceRunResult>;
  readonly start: () => Promise<void>;
  readonly stop: () => void;
}

export interface DesktopDimensionIndexMaintenanceSchedulerOptions {
  readonly getDatabase: () => Promise<DimensionIndexMaintenanceDb>;
  readonly getDimensionIndexStrategy: () => DimensionIndexBuildStrategy | null;
  readonly getPowerSnapshot: () => WorkspaceIndexingPowerSnapshot;
  readonly getSchedulerSnapshot: () => MaintenanceSchedulerSnapshot;
  readonly initialDelayMs?: number;
  /**
   * Required, never defaulted: a build must not run while background database
   * work is paused by an integrity error (BST-1870).
   */
  readonly integrity: Pick<DesktopDatabaseIntegrity, 'contain' | 'getSnapshot'>;
  readonly intervalMs?: number;
  readonly logger: MaintenanceLogger;
  readonly now?: () => Date;
  /** Continuous scheduler idle required before a build may start (BST-1333). */
  readonly quietPeriodMs?: number;
  readonly runDimensionMaintenance?: RunDimensionMaintenance;
  readonly runScheduledWork: RunScheduledWork;
  /**
   * Required: the build runs for tens of seconds and cannot be preempted, so
   * admission needs the scheduler's history, never a single sample.
   */
  readonly subscribeToSchedulerSnapshots: (
    listener: (snapshot: MaintenanceSchedulerSnapshot) => void
  ) => () => void;
}

const MAINTENANCE_WORK_OPTIONS: DatabaseWorkRunOptions = {
  label: 'dimension-index-maintenance',
  priority: 'background',
};

function resolveIntervalMs(intervalMs: number | undefined): number {
  const resolved = intervalMs ?? DEFAULT_DIMENSION_INDEX_MAINTENANCE_INTERVAL_MS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error('Desktop dimension index maintenance intervalMs must be a positive number.');
  }
  return resolved;
}

function resolveInitialDelayMs(initialDelayMs: number | undefined): number {
  const resolved = initialDelayMs ?? DEFAULT_DIMENSION_INDEX_MAINTENANCE_INITIAL_DELAY_MS;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(
      'Desktop dimension index maintenance initialDelayMs must be a non-negative number.'
    );
  }
  return resolved;
}

function resolveQuietPeriodMs(quietPeriodMs: number | undefined): number {
  const resolved = quietPeriodMs ?? DEFAULT_MAINTENANCE_QUIET_PERIOD_MS;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(
      'Desktop dimension index maintenance quietPeriodMs must be a non-negative number.'
    );
  }
  return resolved;
}

function createSkippedResult(
  reason: DesktopDimensionIndexMaintenanceSkipReason
): DesktopDimensionIndexMaintenanceRunResult {
  return { reason, status: 'skipped' };
}

function resolvePowerSkipReason(
  snapshot: WorkspaceIndexingPowerSnapshot
): DesktopDimensionIndexMaintenanceSkipReason | null {
  if (snapshot.powerSource !== 'ac') {
    return 'power-not-ac';
  }
  if (snapshot.thermalState === 'serious' || snapshot.thermalState === 'critical') {
    return 'thermal-pressure';
  }
  if (
    (snapshot.idleState !== 'idle' && snapshot.idleState !== 'locked') ||
    snapshot.idleTimeMs < MIN_IDLE_MS
  ) {
    return 'power-not-idle';
  }
  return null;
}

function validateDimension(dimension: number): void {
  if (!Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error('Dimension index maintenance requires a positive safe integer dimension.');
  }
}

function createDimensionIndexSql(dimension: number): string {
  validateDimension(dimension);
  const indexName = `idx_file_chunks_emb_hnsw_${dimension}`;
  if (!/^idx_file_chunks_emb_hnsw_\d+$/.test(indexName)) {
    throw new Error(`Invalid dimension index name: ${indexName}`);
  }
  const params = hnswParams();

  return `
    CREATE INDEX IF NOT EXISTS ${indexName} ON file_chunks
    USING hnsw ((embedding::halfvec(${dimension})) halfvec_cosine_ops)
    WITH (m=${params.m}, ef_construction=${params.ef})
    WHERE vector_dims(embedding) = ${dimension}
  `;
}

async function createDimensionIndexWithMaintenanceExec(
  db: DimensionIndexMaintenanceDb,
  request: {
    readonly dimension: number;
    readonly strategy: DimensionIndexMaintenanceStrategy;
  }
): Promise<void> {
  if (request.strategy !== 'regular') {
    throw new Error('Dimension index maintenance no longer supports the concurrent strategy.');
  }
  const maintenanceExec = db.maintenance?.exec;
  if (!maintenanceExec) {
    throw new Error('Dimension index maintenance requires DB maintenance exec support.');
  }
  const sql = createDimensionIndexSql(request.dimension);
  // The maintenance_work_mem SET/RESET around the build MUST ride the SAME
  // maintenance channel as the CREATE INDEX: the setting is session-local, so
  // split routing would silently leave the build untuned at the 64MB default
  // (benchmarked 5x slower at 100k chunks x 1024 dims — see
  // MAX_INDEX_BUILD_MAINTENANCE_WORK_MEM_MB in @brainstrike/db).
  const rowCount = await estimateEmbeddedRowCount({
    query: async <TRecord = unknown>(sqlStatement: string): Promise<{ rows: TRecord[] }> => {
      const result = await db.query<TRecord>(sqlStatement);
      return { rows: [...result.rows] };
    },
  });
  await withIndexBuildMaintenanceWorkMem(
    {
      exec: async (sqlStatement: string): Promise<unknown> =>
        await maintenanceExec(sqlStatement, []),
    },
    { dimension: request.dimension, rowCount },
    async () => {
      await maintenanceExec(sql, []);
    }
  );
}

function isCompletedResult(
  result: DesktopDimensionIndexMaintenanceRunResult
): result is Extract<RunDimensionIndexMaintenanceResult, { status: 'completed' }> {
  return result.status === 'completed';
}

export function createDesktopDimensionIndexMaintenanceScheduler(
  options: DesktopDimensionIndexMaintenanceSchedulerOptions
): DesktopDimensionIndexMaintenanceScheduler {
  const initialDelayMs = resolveInitialDelayMs(options.initialDelayMs);
  const intervalMs = resolveIntervalMs(options.intervalMs);
  const now = options.now ?? (() => new Date());
  const runDimensionMaintenance =
    options.runDimensionMaintenance ?? runNextDimensionIndexMaintenance;
  let maintenanceInFlight: Promise<DesktopDimensionIndexMaintenanceRunResult> | null = null;
  const quietPeriodMs = resolveQuietPeriodMs(options.quietPeriodMs);
  const idle = createSustainedIdleObserver(now);
  // An integrity error contains the database and surfaces as the typed error;
  // nothing is replaced. The build's own failure is caught by
  // `runNextDimensionIndexMaintenance` and recorded as text, so `createIndex`
  // is where its SQLSTATE is still readable.
  const containIntegrityError = (error: unknown): unknown =>
    containDatabaseIntegrityError('dimension-index-maintenance', error, options.integrity) ?? error;

  const runOnce = async (): Promise<DesktopDimensionIndexMaintenanceRunResult> => {
    if (maintenanceInFlight) {
      return createSkippedResult('already-running');
    }

    // Containment pauses background writes; skip before reading anything.
    const integritySnapshot = options.integrity.getSnapshot();
    if (!isBackgroundDatabaseWorkAdmitted(integritySnapshot.state)) {
      options.logger.info(
        { integrityState: integritySnapshot.state.kind, revision: integritySnapshot.revision },
        'Skipped dimension index maintenance because database integrity containment is active'
      );
      return createSkippedResult('database-integrity-contained');
    }

    const snapshot = options.getSchedulerSnapshot();
    // Fold the current sample in first: the subscription fires only on change.
    idle.observe(snapshot);
    if (isDatabaseSchedulerBusy(snapshot)) {
      options.logger.debug(
        { queued: snapshot.queued, runningPriority: snapshot.runningPriority },
        'Skipped dimension index maintenance because database scheduler is busy'
      );
      return createSkippedResult('database-scheduler-busy');
    }
    // Idle right now is not enough (BST-1333): the build cannot be preempted.
    const idleForMs = idle.idleForMs();
    if (quietPeriodMs > 0 && idleForMs !== null && idleForMs < quietPeriodMs) {
      options.logger.debug(
        { idleForMs, quietPeriodMs },
        'Skipped dimension index maintenance because the database scheduler was recently busy'
      );
      return createSkippedResult('database-scheduler-recently-busy');
    }

    const powerSnapshot = options.getPowerSnapshot();
    const powerSkipReason = resolvePowerSkipReason(powerSnapshot);
    if (powerSkipReason) {
      options.logger.debug(
        { powerSnapshot, reason: powerSkipReason },
        'Skipped dimension index maintenance because power state is not eligible'
      );
      return createSkippedResult(powerSkipReason);
    }

    const strategy = options.getDimensionIndexStrategy();
    if (!strategy) {
      options.logger.warn?.(
        { reason: 'dimension-index-strategy-unavailable' },
        'Skipped dimension index maintenance because capability probe is unavailable'
      );
      return createSkippedResult('strategy-unavailable');
    }

    maintenanceInFlight = options
      .runScheduledWork(
        MAINTENANCE_WORK_OPTIONS,
        async (): Promise<DesktopDimensionIndexMaintenanceRunResult> => {
          try {
            const db = await options.getDatabase();
            // Read inside the lane: the work scheduler is serial, so any run-scoped
            // query submitted after this read queues behind the build.
            const inFlight = await readInFlightAssistantWork(db);
            if (inFlight.runs > 0 || inFlight.backgroundTasks > 0) {
              options.logger.info(
                { inFlight },
                'Skipped dimension index maintenance because assistant work is in flight'
              );
              return createSkippedResult('assistant-work-in-flight');
            }
            return await runDimensionMaintenance(db, {
              createIndex: async (request) => {
                try {
                  await createDimensionIndexWithMaintenanceExec(db, request);
                } catch (error) {
                  throw containIntegrityError(error);
                }
              },
              now,
              strategy,
            });
          } catch (error) {
            throw containIntegrityError(error);
          }
        }
      )
      .then((result) => {
        if (isCompletedResult(result)) {
          options.logger.info(
            {
              dimension: result.dimension,
              durationMs: result.durationMs,
              strategy: result.strategy,
            },
            'Dimension index maintenance completed'
          );
        } else {
          options.logger.debug({ result }, 'Dimension index maintenance did not complete');
        }
        return result;
      })
      .finally(() => {
        maintenanceInFlight = null;
      });

    return await maintenanceInFlight;
  };

  const triggerOptions = {
    initialDelayMs,
    intervalMs,
    onCloseError: (error: unknown) => {
      options.logger.error({ error }, 'Dimension index maintenance trigger cleanup failed');
    },
    subscribe: () => {
      idle.seedBusy();
      return options.subscribeToSchedulerSnapshots(idle.observe);
    },
    tick: () => {
      void runOnce().catch((error: unknown) => {
        options.logger.error({ error }, 'Dimension index maintenance failed');
      });
    },
  };
  const trigger = createMaintenanceTriggerRuntime(triggerOptions);

  return {
    acquireTrigger: (isLive) => acquireMaintenanceTriggerResources(triggerOptions, isLive),
    close: trigger.close,
    runOnce,
    start: trigger.start,
    stop: trigger.stop,
  };
}
