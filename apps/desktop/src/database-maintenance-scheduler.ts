import {
  type BrainstrikeDbRuntimeEngine,
  type DatabaseWorkPriority,
  type DatabaseWorkRunOptions,
  DEFAULT_DATABASE_MAINTENANCE_INTERVAL_MS,
  runScheduledDatabaseMaintenance,
  runTursoScheduledDatabaseMaintenance,
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

export type DesktopDatabaseMaintenanceCapability = 'pglite-postgres' | 'turso-sqlite' | false;

export type DesktopDatabaseMaintenanceSkipReason =
  | 'already-running'
  | 'database-scheduler-busy'
  | 'unsupported-runtime';

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
  readonly getMaintenanceCapability: () => Promise<DesktopDatabaseMaintenanceCapability>;
  readonly getSchedulerSnapshot: () => SchedulerSnapshot;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
  readonly logger: MaintenanceLogger;
  readonly maintenanceOptions?: ScheduledDatabaseMaintenanceOptions;
  readonly now?: () => Date;
  readonly runMaintenance?: RunMaintenance;
  readonly runScheduledWork: RunScheduledWork;
  readonly runTursoMaintenance?: RunMaintenance;
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

export function resolveDesktopDatabaseMaintenanceCapability(
  runtimeEngine: BrainstrikeDbRuntimeEngine
): DesktopDatabaseMaintenanceCapability {
  if (runtimeEngine === 'pglite') {
    return 'pglite-postgres';
  }
  if (runtimeEngine === 'turso') {
    return 'turso-sqlite';
  }
  return false;
}

function isMaintenanceSupportedCapability(
  capability: DesktopDatabaseMaintenanceCapability
): capability is Exclude<DesktopDatabaseMaintenanceCapability, false> {
  return capability !== false;
}

function selectRunMaintenance(
  capability: Exclude<DesktopDatabaseMaintenanceCapability, false>,
  pgliteMaintenance: RunMaintenance,
  tursoMaintenance: RunMaintenance
): RunMaintenance {
  return capability === 'turso-sqlite' ? tursoMaintenance : pgliteMaintenance;
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
  const runTursoMaintenance = options.runTursoMaintenance ?? runTursoScheduledDatabaseMaintenance;
  let maintenanceInFlight: Promise<DesktopDatabaseMaintenanceRunResult> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const runOnce = async (): Promise<DesktopDatabaseMaintenanceRunResult> => {
    if (maintenanceInFlight) {
      return createSkippedResult('already-running', now);
    }

    maintenanceInFlight = (async () => {
      const maintenanceCapability = await options.getMaintenanceCapability();
      if (!isMaintenanceSupportedCapability(maintenanceCapability)) {
        options.logger.debug(
          { maintenanceCapability },
          'Skipped scheduled database maintenance because the runtime has no scheduled maintenance capability'
        );
        return createSkippedResult('unsupported-runtime', now);
      }

      const selectedRunMaintenance = selectRunMaintenance(
        maintenanceCapability,
        runMaintenance,
        runTursoMaintenance
      );
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

      const result = await options.runScheduledWork(MAINTENANCE_WORK_OPTIONS, async () => {
        const db = await options.getDatabase();
        return await selectedRunMaintenance(db, {
          ...options.maintenanceOptions,
          now,
        });
      });

      if (result.status === 'completed') {
        options.logger.info(
          {
            activeJobs: result.activeJobs,
            analyzedTables: result.analyzedTables,
            durationMs: result.durationMs,
            prunedTerminalJobs: result.prunedTerminalJobs,
            vacuumedTables: result.vacuumedTables,
          },
          'Scheduled database maintenance completed'
        );
      } else {
        options.logger.debug(
          {
            activeJobs: result.activeJobs,
            reason: result.reason,
          },
          'Skipped scheduled database maintenance'
        );
      }
      return result;
    })().finally(() => {
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
