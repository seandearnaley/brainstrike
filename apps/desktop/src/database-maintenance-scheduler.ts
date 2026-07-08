import {
  type DatabaseWorkPriority,
  type DatabaseWorkRunOptions,
  DEFAULT_DATABASE_MAINTENANCE_INTERVAL_MS,
  runScheduledDatabaseMaintenance,
  type ScheduledDatabaseMaintenanceOptions,
  type ScheduledDatabaseMaintenanceResult,
} from '@brainstrike/db';

const DEFAULT_DATABASE_MAINTENANCE_INITIAL_DELAY_MS = 30_000;

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
}

export type DesktopDatabaseMaintenanceSkipReason = 'already-running' | 'database-scheduler-busy';

export type DesktopDatabaseMaintenanceRunResult =
  | ScheduledDatabaseMaintenanceResult
  | {
      readonly activeJobs: 0;
      readonly completedAt: string;
      readonly durationMs: 0;
      readonly prunedTerminalJobs: 0;
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
  readonly runMaintenance?: RunMaintenance;
  readonly runScheduledWork: RunScheduledWork;
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
    completedAt: timestamp,
    durationMs: 0,
    prunedTerminalJobs: 0,
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
  const now = options.now ?? (() => new Date());
  const runMaintenance = options.runMaintenance ?? runScheduledDatabaseMaintenance;
  let maintenanceInFlight: Promise<DesktopDatabaseMaintenanceRunResult> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const runOnce = async (): Promise<DesktopDatabaseMaintenanceRunResult> => {
    if (maintenanceInFlight) {
      return createSkippedResult('already-running', now);
    }
    const snapshot = options.getSchedulerSnapshot();
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

    maintenanceInFlight = options
      .runScheduledWork(MAINTENANCE_WORK_OPTIONS, async () => {
        const db = await options.getDatabase();
        return await runMaintenance(db, {
          ...options.maintenanceOptions,
          now,
        });
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
          // queue: bounded prune, vacuum deferred) both did real work.
          options.logger.info(
            {
              activeJobs: result.activeJobs,
              durationMs: result.durationMs,
              prunedTerminalJobs: result.prunedTerminalJobs,
              status: result.status,
              vacuumedTables: result.vacuumedTables,
            },
            'Scheduled database maintenance completed'
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
