import {
  type DatabaseWorkPriority,
  type DatabaseWorkRunOptions,
  hnswParams,
  type RunDimensionIndexMaintenanceOptions,
  type RunDimensionIndexMaintenanceResult,
  runNextDimensionIndexMaintenance,
  withIndexBuildMaintenanceWorkMem,
} from '@brainstrike/db';
import type { WorkspaceIndexingPowerSnapshot } from '@brainstrike/utils/workspace-indexing-power-snapshot';
import type { DimensionIndexStrategySelection } from './dimension-index-maintenance-capabilities';

const DEFAULT_DIMENSION_INDEX_MAINTENANCE_INITIAL_DELAY_MS = 45_000;
const DEFAULT_DIMENSION_INDEX_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
const MIN_IDLE_MS = 120_000;

interface SchedulerSnapshot {
  readonly queued: Record<DatabaseWorkPriority, number>;
  readonly runningPriority: DatabaseWorkPriority | null;
}

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
  | 'database-scheduler-busy'
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
  readonly runOnce: () => Promise<DesktopDimensionIndexMaintenanceRunResult>;
  readonly start: () => void;
  readonly stop: () => void;
}

export interface DesktopDimensionIndexMaintenanceSchedulerOptions {
  readonly getDatabase: () => Promise<DimensionIndexMaintenanceDb>;
  readonly getDimensionIndexStrategy: () => DimensionIndexStrategySelection | null;
  readonly getPowerSnapshot: () => WorkspaceIndexingPowerSnapshot;
  readonly getSchedulerSnapshot: () => SchedulerSnapshot;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
  readonly logger: MaintenanceLogger;
  readonly now?: () => Date;
  readonly runDimensionMaintenance?: RunDimensionMaintenance;
  readonly runScheduledWork: RunScheduledWork;
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

function hasQueuedDatabaseWork(snapshot: SchedulerSnapshot): boolean {
  return (
    snapshot.queued.background > 0 || snapshot.queued.foreground > 0 || snapshot.queued.normal > 0
  );
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

function createDimensionIndexSql(
  dimension: number,
  strategy: DimensionIndexStrategySelection['strategy']
): string {
  validateDimension(dimension);
  const indexName = `idx_file_chunks_emb_hnsw_${dimension}`;
  if (!/^idx_file_chunks_emb_hnsw_\d+$/.test(indexName)) {
    throw new Error(`Invalid dimension index name: ${indexName}`);
  }
  const params = hnswParams();
  const createPrefix =
    strategy === 'concurrent'
      ? 'CREATE INDEX CONCURRENTLY IF NOT EXISTS'
      : 'CREATE INDEX IF NOT EXISTS';

  return `
    ${createPrefix} ${indexName} ON file_chunks
    USING hnsw ((embedding::halfvec(${dimension})) halfvec_cosine_ops)
    WITH (m=${params.m}, ef_construction=${params.ef})
    WHERE vector_dims(embedding) = ${dimension}
  `;
}

async function createDimensionIndexWithMaintenanceExec(
  db: DimensionIndexMaintenanceDb,
  request: {
    readonly dimension: number;
    readonly strategy: DimensionIndexStrategySelection['strategy'];
  }
): Promise<void> {
  const maintenanceExec = db.maintenance?.exec;
  if (!maintenanceExec) {
    throw new Error('Dimension index maintenance requires DB maintenance exec support.');
  }
  const sql = createDimensionIndexSql(request.dimension, request.strategy);
  // The maintenance_work_mem SET/RESET around the build MUST ride the SAME
  // maintenance channel as the CREATE INDEX: the setting is session-local, so
  // split routing would silently leave the build untuned at the 64MB default
  // (benchmarked 5x slower at 100k chunks x 1024 dims — see
  // MAX_INDEX_BUILD_MAINTENANCE_WORK_MEM_MB in @brainstrike/db).
  await withIndexBuildMaintenanceWorkMem(
    {
      exec: async (sqlStatement: string): Promise<unknown> =>
        await maintenanceExec(sqlStatement, []),
      query: async <TRecord = unknown>(sqlStatement: string): Promise<{ rows: TRecord[] }> => {
        const result = await db.query<TRecord>(sqlStatement);
        return { rows: [...result.rows] };
      },
    },
    request.dimension,
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
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const runOnce = async (): Promise<DesktopDimensionIndexMaintenanceRunResult> => {
    if (maintenanceInFlight) {
      return createSkippedResult('already-running');
    }

    const snapshot = options.getSchedulerSnapshot();
    if (snapshot.runningPriority !== null || hasQueuedDatabaseWork(snapshot)) {
      options.logger.debug(
        { queued: snapshot.queued, runningPriority: snapshot.runningPriority },
        'Skipped dimension index maintenance because database scheduler is busy'
      );
      return createSkippedResult('database-scheduler-busy');
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

    const strategySelection = options.getDimensionIndexStrategy();
    if (!strategySelection) {
      options.logger.warn?.(
        { reason: 'dimension-index-strategy-unavailable' },
        'Skipped dimension index maintenance because capability probe is unavailable'
      );
      return createSkippedResult('strategy-unavailable');
    }

    maintenanceInFlight = options
      .runScheduledWork(MAINTENANCE_WORK_OPTIONS, async () => {
        const db = await options.getDatabase();
        return await runDimensionMaintenance(db, {
          createIndex: async (request) =>
            await createDimensionIndexWithMaintenanceExec(db, request),
          now,
          strategy: strategySelection.strategy,
        });
      })
      .then((result) => {
        if (isCompletedResult(result)) {
          options.logger.info(
            {
              dimension: result.dimension,
              durationMs: result.durationMs,
              strategy: result.strategy,
              strategyReason: strategySelection.reason,
            },
            'Dimension index maintenance completed'
          );
        } else {
          options.logger.debug(
            { result, strategyReason: strategySelection.reason },
            'Dimension index maintenance did not complete'
          );
        }
        return result;
      })
      .finally(() => {
        maintenanceInFlight = null;
      });

    return await maintenanceInFlight;
  };

  return {
    runOnce,
    start: () => {
      if (initialTimer !== null || timer !== null) {
        return;
      }
      initialTimer = setTimeout(() => {
        initialTimer = null;
        void runOnce().catch((error: unknown) => {
          options.logger.error({ error }, 'Dimension index maintenance failed');
        });
        timer = setInterval(() => {
          void runOnce().catch((error: unknown) => {
            options.logger.error({ error }, 'Dimension index maintenance failed');
          });
        }, intervalMs);
        timer.unref?.();
      }, initialDelayMs);
      initialTimer.unref?.();
    },
    stop: () => {
      if (initialTimer !== null) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (timer === null) {
        return;
      }
      clearInterval(timer);
      timer = null;
    },
  };
}
