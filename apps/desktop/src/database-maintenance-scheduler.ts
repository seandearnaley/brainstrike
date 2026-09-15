import {
  type DatabaseWorkPriority,
  type DatabaseWorkRunOptions,
  DEFAULT_DATABASE_MAINTENANCE_INTERVAL_MS,
  runScheduledDatabaseMaintenance,
  type ScheduledDatabaseMaintenanceOptions,
  type ScheduledDatabaseMaintenanceResult,
} from '@brainstrike/db';
import { isCorruptionError } from './db-main';
import {
  type RuntimeDatabaseCorruptionHandler,
  recoverRuntimeDatabaseCorruption,
} from './ipc-domains/runtime-database-corruption';

const DEFAULT_DATABASE_MAINTENANCE_INITIAL_DELAY_MS = 30_000;

/** Runtime-recovery context for corruption found by a maintenance pass. */
const MAINTENANCE_CORRUPTION_CONTEXT = 'maintenance';

/**
 * BST-1333: how long the database scheduler must have been CONTINUOUSLY idle
 * before a maintenance pass may start.
 *
 * The pre-existing gate below asks "is the scheduler busy right now?", which is
 * the wrong question for this workload: maintenance issues statements that can
 * run for seconds (a measured `VACUUM (ANALYZE) file_chunks` took 7.3s), and
 * the DB host dispatches envelopes STRICTLY SERIALLY — once such a statement
 * starts, nothing can preempt it and every renderer query queues behind it.
 * A momentary lull is therefore not evidence that starting is safe.
 *
 * Measured case: during window startup the renderer's queries arrive in bursts;
 * an instantaneous check landed in a gap between them and a 7.3s VACUUM began
 * while the window was still loading, stalling every startup query behind it.
 * Requiring sustained quiet turns "the scheduler happens to be idle this
 * millisecond" into "the app has actually settled".
 */
const DEFAULT_DATABASE_MAINTENANCE_QUIET_PERIOD_MS = 15_000;

interface SchedulerSnapshot {
  readonly queued: Record<DatabaseWorkPriority, number>;
  readonly runningPriority: DatabaseWorkPriority | null;
}

type MaintenanceDb = Parameters<typeof runScheduledDatabaseMaintenance>[0];

type RunScheduledWork = <TResult>(
  options: DatabaseWorkRunOptions,
  work: () => Promise<TResult>
) => Promise<TResult>;

type RunMaintenance = (
  db: MaintenanceDb,
  options?: ScheduledDatabaseMaintenanceOptions
) => Promise<ScheduledDatabaseMaintenanceResult>;

interface MaintenanceLogger {
  readonly debug: (context: Record<string, unknown>, message: string) => void;
  readonly error: (context: Record<string, unknown>, message: string) => void;
  readonly info: (context: Record<string, unknown>, message: string) => void;
  readonly warn: (context: Record<string, unknown>, message: string) => void;
}

export type DesktopDatabaseMaintenanceSkipReason =
  | 'already-running'
  | 'database-scheduler-busy'
  | 'database-scheduler-recently-busy';

export type DesktopDatabaseMaintenanceRunResult =
  | ScheduledDatabaseMaintenanceResult
  | {
      readonly activeJobs: 0;
      readonly analyzedTables: readonly [];
      readonly completedAt: string;
      readonly durationMs: 0;
      readonly prunedTerminalJobs: 0;
      readonly prunedTokenEstimateCalibrationRows: 0;
      readonly prunedToolCallTelemetryRows: 0;
      readonly reason: DesktopDatabaseMaintenanceSkipReason;
      readonly startedAt: string;
      readonly status: 'skipped';
      readonly vacuumedTables: readonly [];
    };

export interface DesktopDatabaseMaintenanceScheduler {
  readonly runOnce: () => Promise<DesktopDatabaseMaintenanceRunResult>;
  readonly start: () => void;
  readonly stop: () => void;
}

export interface DesktopDatabaseMaintenanceSchedulerOptions {
  readonly getDatabase: () => Promise<MaintenanceDb>;
  readonly getSchedulerSnapshot: () => SchedulerSnapshot;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
  readonly logger: MaintenanceLogger;
  readonly maintenanceOptions?: ScheduledDatabaseMaintenanceOptions;
  readonly now?: () => Date;
  /**
   * Runtime corruption recovery: backup, DB host replacement, window reload.
   * Required, never defaulted: a pass that finds corruption must not leave the
   * app serving the corrupt database.
   */
  readonly onRuntimeCorruption: RuntimeDatabaseCorruptionHandler;
  /**
   * Continuous idle required before a pass may start (BST-1333). Observed via
   * `subscribeToSchedulerSnapshots`; when that is not supplied the gate cannot
   * see history and degrades to the instantaneous check — deliberately, and
   * only for callers that opt out by omitting the subscription.
   */
  readonly quietPeriodMs?: number;
  readonly runMaintenance?: RunMaintenance;
  readonly runScheduledWork: RunScheduledWork;
  readonly subscribeToSchedulerSnapshots?: (
    listener: (snapshot: SchedulerSnapshot) => void
  ) => () => void;
}

const MAINTENANCE_WORK_OPTIONS: DatabaseWorkRunOptions = {
  label: 'scheduled-db-maintenance',
  priority: 'background',
};

function resolveIntervalMs(intervalMs: number | undefined): number {
  const resolvedIntervalMs = intervalMs ?? DEFAULT_DATABASE_MAINTENANCE_INTERVAL_MS;
  if (!Number.isFinite(resolvedIntervalMs) || resolvedIntervalMs <= 0) {
    throw new Error('Desktop database maintenance intervalMs must be a positive number.');
  }
  return resolvedIntervalMs;
}

function resolveQuietPeriodMs(quietPeriodMs: number | undefined): number {
  const resolved = quietPeriodMs ?? DEFAULT_DATABASE_MAINTENANCE_QUIET_PERIOD_MS;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error('Desktop database maintenance quietPeriodMs must be a non-negative number.');
  }
  return resolved;
}

function resolveInitialDelayMs(initialDelayMs: number | undefined): number {
  const resolvedInitialDelayMs = initialDelayMs ?? DEFAULT_DATABASE_MAINTENANCE_INITIAL_DELAY_MS;
  if (!Number.isFinite(resolvedInitialDelayMs) || resolvedInitialDelayMs < 0) {
    throw new Error('Desktop database maintenance initialDelayMs must be a non-negative number.');
  }
  return resolvedInitialDelayMs;
}

function hasQueuedDatabaseWork(snapshot: SchedulerSnapshot): boolean {
  return (
    snapshot.queued.background > 0 || snapshot.queued.foreground > 0 || snapshot.queued.normal > 0
  );
}

function createSkippedResult(
  reason: DesktopDatabaseMaintenanceSkipReason,
  now: () => Date
): DesktopDatabaseMaintenanceRunResult {
  const timestamp = now().toISOString();
  return {
    activeJobs: 0,
    analyzedTables: [],
    completedAt: timestamp,
    durationMs: 0,
    prunedTerminalJobs: 0,
    prunedTokenEstimateCalibrationRows: 0,
    prunedToolCallTelemetryRows: 0,
    reason,
    startedAt: timestamp,
    status: 'skipped',
    vacuumedTables: [],
  };
}

export function createDesktopDatabaseMaintenanceScheduler(
  options: DesktopDatabaseMaintenanceSchedulerOptions
): DesktopDatabaseMaintenanceScheduler {
  const initialDelayMs = resolveInitialDelayMs(options.initialDelayMs);
  const intervalMs = resolveIntervalMs(options.intervalMs);
  const quietPeriodMs = resolveQuietPeriodMs(options.quietPeriodMs);
  const now = options.now ?? (() => new Date());
  const runMaintenance = options.runMaintenance ?? runScheduledDatabaseMaintenance;
  let maintenanceInFlight: Promise<DesktopDatabaseMaintenanceRunResult> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeFromScheduler: (() => void) | null = null;
  // Null means "no busy observation yet", which start() seeds so a scheduler
  // that has been quiet since startup still has to serve out the quiet period
  // rather than counting as quiet since the epoch.
  let lastBusyAtMs: number | null = null;

  const observeSnapshot = (snapshot: SchedulerSnapshot): void => {
    if (snapshot.runningPriority !== null || hasQueuedDatabaseWork(snapshot)) {
      lastBusyAtMs = now().getTime();
    }
  };

  const runOnce = async (): Promise<DesktopDatabaseMaintenanceRunResult> => {
    if (maintenanceInFlight) {
      return createSkippedResult('already-running', now);
    }
    const snapshot = options.getSchedulerSnapshot();
    // Fold the current sample in first: the subscription only fires on change,
    // so a scheduler busy since the last event would otherwise go unrecorded.
    observeSnapshot(snapshot);
    if (snapshot.runningPriority !== null || hasQueuedDatabaseWork(snapshot)) {
      options.logger.debug(
        {
          queued: snapshot.queued,
          runningPriority: snapshot.runningPriority,
        },
        'Skipped scheduled database maintenance because database scheduler is busy'
      );
      return createSkippedResult('database-scheduler-busy', now);
    }

    // Idle right now is not enough (BST-1333): maintenance statements can run
    // for seconds and cannot be preempted once dispatched, so require that the
    // scheduler has been continuously idle for the quiet period. Skipping is
    // free — the next interval tick retries.
    if (quietPeriodMs > 0 && lastBusyAtMs !== null) {
      const idleForMs = now().getTime() - lastBusyAtMs;
      if (idleForMs < quietPeriodMs) {
        options.logger.debug(
          { idleForMs, quietPeriodMs },
          'Skipped scheduled database maintenance because the database scheduler was recently busy'
        );
        return createSkippedResult('database-scheduler-recently-busy', now);
      }
    }

    maintenanceInFlight = options
      .runScheduledWork(MAINTENANCE_WORK_OPTIONS, async () => {
        try {
          const db = await options.getDatabase();
          return await runMaintenance(db, {
            ...options.maintenanceOptions,
            now,
          });
        } catch (error) {
          if (!isCorruptionError(error)) {
            throw error;
          }
          // Same rule and path as db:query: recover while this operation still
          // owns the lane, and never retry against the replacement database.
          options.logger.warn(
            { context: MAINTENANCE_CORRUPTION_CONTEXT, error },
            `Corruption detected in ${MAINTENANCE_CORRUPTION_CONTEXT}; replacing the database without retrying.`
          );
          return await recoverRuntimeDatabaseCorruption(
            MAINTENANCE_CORRUPTION_CONTEXT,
            options.onRuntimeCorruption
          );
        }
      })
      .then((result) => {
        if (result.status === 'skipped') {
          options.logger.debug(
            {
              activeJobs: result.activeJobs,
              reason: result.reason,
            },
            'Skipped scheduled database maintenance'
          );
        } else {
          // 'completed' (idle: full prune + vacuum) and 'partial' (active
          // queue: bounded prune, vacuum deferred) both did real work; the
          // message says which so 'completed' never claims a deferred vacuum.
          options.logger.info(
            {
              activeJobs: result.activeJobs,
              analyzedTables: result.analyzedTables,
              durationMs: result.durationMs,
              prunedTerminalJobs: result.prunedTerminalJobs,
              prunedTokenEstimateCalibrationRows: result.prunedTokenEstimateCalibrationRows,
              prunedToolCallTelemetryRows: result.prunedToolCallTelemetryRows,
              status: result.status,
              vacuumedTables: result.vacuumedTables,
            },
            result.status === 'partial'
              ? 'Scheduled database maintenance pruned while queue active (vacuum deferred)'
              : 'Scheduled database maintenance completed'
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
      // Treat start as a busy observation: the app is booting, which is
      // exactly the window the quiet period exists to protect.
      lastBusyAtMs = now().getTime();
      unsubscribeFromScheduler = options.subscribeToSchedulerSnapshots?.(observeSnapshot) ?? null;
      initialTimer = setTimeout(() => {
        initialTimer = null;
        void runOnce().catch((error: unknown) => {
          options.logger.error({ error }, 'Scheduled database maintenance failed');
        });
        timer = setInterval(() => {
          void runOnce().catch((error: unknown) => {
            options.logger.error({ error }, 'Scheduled database maintenance failed');
          });
        }, intervalMs);
        timer.unref?.();
      }, initialDelayMs);
      initialTimer.unref?.();
    },
    stop: () => {
      unsubscribeFromScheduler?.();
      unsubscribeFromScheduler = null;
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
