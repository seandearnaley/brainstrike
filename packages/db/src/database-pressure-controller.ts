import type {
  DatabaseWorkScheduler,
  DatabaseWorkSchedulerSnapshot,
} from './database-work-scheduler.js';

export type DatabasePressureWaitingReason =
  | 'foreground-latency'
  | 'foreground-queued'
  | 'foreground-quiet-window'
  | 'foreground-running'
  | 'normal-latency'
  | 'normal-quiet-window';

export interface DatabasePressurePermitOptions {
  readonly label?: string;
  readonly signal?: AbortSignal;
}

export interface DatabasePressureControllerSnapshot {
  readonly lastPermitAt: number | null;
  readonly lastYieldAt: number | null;
  readonly permitWaiting: boolean;
  readonly permitWaitingSince: number | null;
  readonly permitYieldCount: number;
  readonly waitingLabel: string | null;
  readonly waitingReason: DatabasePressureWaitingReason | null;
}

export interface DatabasePressureController {
  readonly getSnapshot: () => DatabasePressureControllerSnapshot;
  readonly waitForBackgroundPermit: (options?: DatabasePressurePermitOptions) => Promise<void>;
}

export interface DatabasePressureSnapshotSource {
  readonly getSnapshot: () =>
    | DatabaseWorkSchedulerSnapshot
    | Promise<DatabaseWorkSchedulerSnapshot>;
  readonly subscribe?: (listener: (snapshot: DatabaseWorkSchedulerSnapshot) => void) => () => void;
}

export interface DatabasePressureControllerOptions {
  readonly foregroundPressureWindowMs?: number;
  readonly foregroundServiceP95ThresholdMs?: number;
  readonly foregroundWaitP95ThresholdMs?: number;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly scheduler?: DatabaseWorkScheduler;
  readonly snapshotSource?: DatabasePressureSnapshotSource;
}

export interface DatabasePressurePolicyOptions {
  readonly foregroundPressureWindowMs?: number;
  readonly foregroundServiceP95ThresholdMs?: number;
  readonly foregroundWaitP95ThresholdMs?: number;
}

const DEFAULT_FOREGROUND_PRESSURE_WINDOW_MS = 1500;
const DEFAULT_FOREGROUND_SERVICE_P95_THRESHOLD_MS = 120;
const DEFAULT_FOREGROUND_WAIT_P95_THRESHOLD_MS = 75;
const DEFAULT_POLL_MS = 25;

function createInitialSnapshot(): DatabasePressureControllerSnapshot {
  return {
    lastPermitAt: null,
    lastYieldAt: null,
    permitWaiting: false,
    permitWaitingSince: null,
    permitYieldCount: 0,
    waitingLabel: null,
    waitingReason: null,
  };
}

function resolveSource(options: DatabasePressureControllerOptions): DatabasePressureSnapshotSource {
  const source = options.scheduler ?? options.snapshotSource;
  if (!source) {
    throw new Error('DatabasePressureController requires a scheduler or snapshot source.');
  }
  return source;
}

function getLatencyPressureReason(
  snapshot: DatabaseWorkSchedulerSnapshot,
  now: number,
  pressureWindowMs: number,
  waitP95ThresholdMs: number,
  serviceP95ThresholdMs: number
): DatabasePressureWaitingReason | null {
  const foregroundStats = snapshot.priorityStats.foreground;
  const normalStats = snapshot.priorityStats.normal;
  if (
    snapshot.lastForegroundAt !== null &&
    now - snapshot.lastForegroundAt <= pressureWindowMs &&
    (foregroundStats.waitP95Ms > waitP95ThresholdMs ||
      foregroundStats.serviceP95Ms > serviceP95ThresholdMs)
  ) {
    return 'foreground-latency';
  }
  if (
    snapshot.lastNormalAt !== null &&
    now - snapshot.lastNormalAt <= pressureWindowMs &&
    (normalStats.waitP95Ms > waitP95ThresholdMs || normalStats.serviceP95Ms > serviceP95ThresholdMs)
  ) {
    return 'normal-latency';
  }
  return null;
}

function resolvePolicyOptions(
  options: DatabasePressurePolicyOptions
): Required<DatabasePressurePolicyOptions> {
  return {
    foregroundPressureWindowMs:
      options.foregroundPressureWindowMs ?? DEFAULT_FOREGROUND_PRESSURE_WINDOW_MS,
    foregroundServiceP95ThresholdMs:
      options.foregroundServiceP95ThresholdMs ?? DEFAULT_FOREGROUND_SERVICE_P95_THRESHOLD_MS,
    foregroundWaitP95ThresholdMs:
      options.foregroundWaitP95ThresholdMs ?? DEFAULT_FOREGROUND_WAIT_P95_THRESHOLD_MS,
  };
}

export function getDatabasePressureWaitingReason(
  snapshot: DatabaseWorkSchedulerSnapshot,
  now: number,
  options: DatabasePressurePolicyOptions = {}
): DatabasePressureWaitingReason | null {
  const policy = resolvePolicyOptions(options);
  if (snapshot.runningPriority === 'foreground' || snapshot.runningPriority === 'normal') {
    return 'foreground-running';
  }
  if (snapshot.queued.foreground > 0 || snapshot.queued.normal > 0) {
    return 'foreground-queued';
  }
  if (
    snapshot.lastForegroundAt !== null &&
    now - snapshot.lastForegroundAt <= snapshot.foregroundQuietMs
  ) {
    return 'foreground-quiet-window';
  }
  // Normal priority is foreground-visible DB work, so it uses the same
  // post-activity quiet window while keeping a distinct diagnostic reason.
  if (snapshot.lastNormalAt !== null && now - snapshot.lastNormalAt <= snapshot.foregroundQuietMs) {
    return 'normal-quiet-window';
  }
  return getLatencyPressureReason(
    snapshot,
    now,
    policy.foregroundPressureWindowMs,
    policy.foregroundWaitP95ThresholdMs,
    policy.foregroundServiceP95ThresholdMs
  );
}

export function createDatabasePressureController(
  options: DatabasePressureControllerOptions
): DatabasePressureController {
  const source = resolveSource(options);
  const now = options.now ?? (() => Date.now());
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
  const policy = resolvePolicyOptions(options);
  let snapshot = createInitialSnapshot();

  const getSnapshot = (): DatabasePressureControllerSnapshot => ({ ...snapshot });
  const readWaitingReason = async (): Promise<DatabasePressureWaitingReason | null> =>
    getDatabasePressureWaitingReason(await source.getSnapshot(), now(), policy);

  const waitForBackgroundPermit = async (
    permitOptions: DatabasePressurePermitOptions = {}
  ): Promise<void> => {
    if (permitOptions.signal?.aborted) {
      throw new Error('Background database permit aborted');
    }

    const firstReason = await readWaitingReason();
    if (!firstReason) {
      snapshot = {
        ...snapshot,
        lastPermitAt: now(),
        permitWaiting: false,
        permitWaitingSince: null,
        waitingLabel: null,
        waitingReason: null,
      };
      return;
    }

    const waitingSince = now();
    snapshot = {
      ...snapshot,
      lastYieldAt: waitingSince,
      permitWaiting: true,
      permitWaitingSince: waitingSince,
      permitYieldCount: snapshot.permitYieldCount + 1,
      waitingLabel: permitOptions.label ?? null,
      waitingReason: firstReason,
    };

    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;

      const cleanup = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        permitOptions.signal?.removeEventListener('abort', onAbort);
      };

      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        snapshot = {
          ...snapshot,
          lastPermitAt: now(),
          permitWaiting: false,
          permitWaitingSince: null,
          waitingLabel: null,
          waitingReason: null,
        };
        resolve();
      };

      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        snapshot = {
          ...snapshot,
          permitWaiting: false,
          permitWaitingSince: null,
          waitingLabel: null,
          waitingReason: null,
        };
        reject(new Error('Background database permit aborted'));
      };

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        snapshot = {
          ...snapshot,
          permitWaiting: false,
          permitWaitingSince: null,
          waitingLabel: null,
          waitingReason: null,
        };
        reject(error);
      };

      let checking = false;
      const clearPendingCheck = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };
      const check = async (): Promise<void> => {
        if (checking || settled) {
          return;
        }
        clearPendingCheck();
        checking = true;
        let reason: DatabasePressureWaitingReason | null;
        try {
          reason = await readWaitingReason();
        } catch (error) {
          checking = false;
          fail(error);
          return;
        }
        checking = false;
        if (settled) {
          return;
        }
        if (!reason) {
          finish();
          return;
        }
        snapshot = {
          ...snapshot,
          waitingReason: reason,
        };
        timeout = setTimeout(() => {
          void check();
        }, pollMs);
      };

      permitOptions.signal?.addEventListener('abort', onAbort, { once: true });
      unsubscribe =
        source.subscribe?.(() => {
          void check();
        }) ?? null;
      timeout = setTimeout(() => {
        void check();
      }, pollMs);
    });
  };

  return {
    getSnapshot,
    waitForBackgroundPermit,
  };
}
