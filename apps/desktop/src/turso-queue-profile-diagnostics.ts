import type { DatabaseWorkSchedulerSnapshot } from '@brainstrike/db';
import type {
  DatabaseTursoOwnerClientQoSDiagnostics,
  DatabaseTursoOwnerClientQueuedOperationDiagnostic,
} from '@brainstrike/types';

export type TursoQueueProfileStatus =
  | 'accepted'
  | 'blocked'
  | 'insufficient-evidence'
  | 'unavailable';

export type TursoQueueProfileReason =
  | 'foreground-owner-queued-behind-background'
  | 'foreground-scheduler-wait-threshold-exceeded'
  | 'missing-background-work'
  | 'missing-foreground-work'
  | 'owner-diagnostics-malformed'
  | 'owner-client-not-open'
  | 'owner-diagnostics-unsupported'
  | 'runtime-not-turso'
  | 'scheduler-unavailable'
  | 'within-thresholds';

export interface TursoQueueProfileDiagnostics {
  readonly backgroundCompleted: number;
  readonly blockingForegroundLabels: readonly string[];
  readonly foregroundWaitP95Ms: number;
  readonly foregroundWorstWaitMs: number;
  readonly observedBackgroundWork: boolean;
  readonly observedForegroundWork: boolean;
  readonly ownerQueuedOperationCount: number;
  readonly ownerSlowForegroundQueuedOperationCount: number;
  readonly ownerSlowQueuedOperationCount: number;
  readonly reason: TursoQueueProfileReason;
  readonly status: TursoQueueProfileStatus;
  readonly thresholdMs: number;
}

export interface CreateTursoQueueProfileDiagnosticsInput {
  readonly databaseDiagnostics: unknown;
  readonly foregroundWaitThresholdMs?: number;
  readonly scheduler: DatabaseWorkSchedulerSnapshot | null;
}

const DEFAULT_FOREGROUND_WAIT_THRESHOLD_MS = 1000;

function getRecordValue(record: unknown, key: string): unknown {
  if (!(record && typeof record === 'object')) {
    return;
  }
  return (record as Record<string, unknown>)[key];
}

function getRuntimeEngine(databaseDiagnostics: unknown): string | null {
  const report = getRecordValue(databaseDiagnostics, 'profileBootstrapReport');
  const runtime = getRecordValue(report, 'runtime');
  const engine = getRecordValue(runtime, 'engine');
  return typeof engine === 'string' ? engine : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOwnerOperationKind(value: unknown): boolean {
  return value === 'exec' || value === 'query' || value === 'transaction';
}

function isOwnerOperationPriority(value: unknown): boolean {
  return value === null || value === 'background' || value === 'foreground' || value === 'normal';
}

function isBaseOwnerOperationDiagnostic(operation: unknown): boolean {
  return (
    Boolean(operation && typeof operation === 'object') &&
    isFiniteNumber(getRecordValue(operation, 'id')) &&
    isOwnerOperationKind(getRecordValue(operation, 'kind')) &&
    typeof getRecordValue(operation, 'label') === 'string' &&
    isOwnerOperationPriority(getRecordValue(operation, 'priority')) &&
    isFiniteNumber(getRecordValue(operation, 'queuedAt'))
  );
}

function isQueuedOwnerOperationDiagnostic(
  operation: unknown
): operation is DatabaseTursoOwnerClientQueuedOperationDiagnostic {
  return (
    isBaseOwnerOperationDiagnostic(operation) &&
    isFiniteNumber(getRecordValue(operation, 'queuedForMs'))
  );
}

function isActiveOwnerOperationDiagnostic(operation: unknown): boolean {
  return (
    isBaseOwnerOperationDiagnostic(operation) &&
    isFiniteNumber(getRecordValue(operation, 'activeDurationMs')) &&
    isFiniteNumber(getRecordValue(operation, 'queueWaitMs')) &&
    isFiniteNumber(getRecordValue(operation, 'startedAt'))
  );
}

function isAvailableOwnerQoS(
  qos: unknown
): qos is Extract<DatabaseTursoOwnerClientQoSDiagnostics, { available: true }> {
  const activeOperation = getRecordValue(qos, 'activeOperation');
  const queuedOperations = getRecordValue(qos, 'queuedOperations');
  return (
    Boolean(qos && typeof qos === 'object') &&
    getRecordValue(qos, 'available') === true &&
    (activeOperation === null || isActiveOwnerOperationDiagnostic(activeOperation)) &&
    Array.isArray(queuedOperations) &&
    queuedOperations.every(isQueuedOwnerOperationDiagnostic) &&
    isFiniteNumber(getRecordValue(qos, 'queuedOperationCount')) &&
    isFiniteNumber(getRecordValue(qos, 'slowQueuedOperationCount')) &&
    isFiniteNumber(getRecordValue(qos, 'slowQueueThresholdMs')) &&
    isFiniteNumber(getRecordValue(qos, 'totalCompletedOperations')) &&
    isFiniteNumber(getRecordValue(qos, 'totalFailedOperations')) &&
    isFiniteNumber(getRecordValue(qos, 'totalQueuedOperations')) &&
    isFiniteNumber(getRecordValue(qos, 'totalStartedOperations'))
  );
}

function isUnavailableOwnerQoS(
  qos: unknown
): qos is Extract<DatabaseTursoOwnerClientQoSDiagnostics, { available: false }> {
  const reason = getRecordValue(qos, 'reason');
  return (
    Boolean(qos && typeof qos === 'object') &&
    getRecordValue(qos, 'available') === false &&
    (reason === 'diagnostics-unsupported' ||
      reason === 'owner-client-not-open' ||
      reason === 'runtime-not-turso')
  );
}

type OwnerQoSParseResult = DatabaseTursoOwnerClientQoSDiagnostics | 'malformed' | null;

function getOwnerQoS(databaseDiagnostics: unknown): OwnerQoSParseResult {
  const qos = getRecordValue(databaseDiagnostics, 'tursoOwnerClientQoS');
  if (!(qos && typeof qos === 'object')) {
    return null;
  }
  const available = getRecordValue(qos, 'available');
  if (available !== true && available !== false) {
    return null;
  }
  if (!(isAvailableOwnerQoS(qos) || isUnavailableOwnerQoS(qos))) {
    return 'malformed';
  }
  return qos as DatabaseTursoOwnerClientQoSDiagnostics;
}

function unavailable(
  reason: TursoQueueProfileReason,
  thresholdMs: number
): TursoQueueProfileDiagnostics {
  return {
    backgroundCompleted: 0,
    blockingForegroundLabels: [],
    foregroundWaitP95Ms: 0,
    foregroundWorstWaitMs: 0,
    observedBackgroundWork: false,
    observedForegroundWork: false,
    ownerQueuedOperationCount: 0,
    ownerSlowForegroundQueuedOperationCount: 0,
    ownerSlowQueuedOperationCount: 0,
    reason,
    status: 'unavailable',
    thresholdMs,
  };
}

function isForegroundVisiblePriority(
  operation: DatabaseTursoOwnerClientQueuedOperationDiagnostic
): boolean {
  return operation.priority === 'foreground' || operation.priority === 'normal';
}

function getBlockingForegroundLabels(
  qos: Extract<DatabaseTursoOwnerClientQoSDiagnostics, { available: true }>,
  thresholdMs: number
): string[] {
  if (qos.activeOperation?.priority !== 'background') {
    return [];
  }
  return qos.queuedOperations
    .filter((operation: DatabaseTursoOwnerClientQueuedOperationDiagnostic) =>
      isForegroundVisiblePriority(operation)
    )
    .filter(
      (operation: DatabaseTursoOwnerClientQueuedOperationDiagnostic) =>
        operation.queuedForMs >= thresholdMs
    )
    .map((operation: DatabaseTursoOwnerClientQueuedOperationDiagnostic) => operation.label);
}

function hasSchedulerWork(
  scheduler: DatabaseWorkSchedulerSnapshot,
  priority: 'background' | 'foreground' | 'normal'
): boolean {
  const stats = scheduler.priorityStats[priority];
  return (
    stats.started > 0 ||
    stats.completed > 0 ||
    scheduler.queued[priority] > 0 ||
    scheduler.runningPriority === priority
  );
}

function getForegroundWaitP95Ms(scheduler: DatabaseWorkSchedulerSnapshot): number {
  return Math.max(
    scheduler.priorityStats.foreground.waitP95Ms,
    scheduler.priorityStats.normal.waitP95Ms
  );
}

function getForegroundWorstWaitMs(scheduler: DatabaseWorkSchedulerSnapshot): number {
  return Math.max(
    scheduler.priorityStats.foreground.longestWaitMs,
    scheduler.priorityStats.normal.longestWaitMs
  );
}

export function createTursoQueueProfileDiagnostics({
  databaseDiagnostics,
  foregroundWaitThresholdMs,
  scheduler,
}: CreateTursoQueueProfileDiagnosticsInput): TursoQueueProfileDiagnostics {
  const ownerQoSResult = getOwnerQoS(databaseDiagnostics);
  const ownerQoS = ownerQoSResult === 'malformed' ? null : ownerQoSResult;
  const thresholdMs =
    foregroundWaitThresholdMs ??
    (ownerQoS?.available ? ownerQoS.slowQueueThresholdMs : DEFAULT_FOREGROUND_WAIT_THRESHOLD_MS);

  if (getRuntimeEngine(databaseDiagnostics) !== 'turso') {
    return unavailable('runtime-not-turso', thresholdMs);
  }
  if (ownerQoSResult === 'malformed') {
    return unavailable('owner-diagnostics-malformed', thresholdMs);
  }
  if (!ownerQoS?.available) {
    return unavailable(
      ownerQoS?.reason === 'diagnostics-unsupported'
        ? 'owner-diagnostics-unsupported'
        : 'owner-client-not-open',
      thresholdMs
    );
  }
  if (!scheduler) {
    return unavailable('scheduler-unavailable', thresholdMs);
  }

  const observedBackgroundWork = hasSchedulerWork(scheduler, 'background');
  const observedForegroundWork =
    hasSchedulerWork(scheduler, 'foreground') || hasSchedulerWork(scheduler, 'normal');
  const foregroundWaitP95Ms = getForegroundWaitP95Ms(scheduler);
  const foregroundWorstWaitMs = getForegroundWorstWaitMs(scheduler);
  const blockingForegroundLabels = getBlockingForegroundLabels(ownerQoS, thresholdMs);
  const ownerSlowForegroundQueuedOperationCount = blockingForegroundLabels.length;

  if (ownerSlowForegroundQueuedOperationCount > 0) {
    return {
      backgroundCompleted: scheduler.priorityStats.background.completed,
      blockingForegroundLabels,
      foregroundWaitP95Ms,
      foregroundWorstWaitMs,
      observedBackgroundWork,
      observedForegroundWork,
      ownerQueuedOperationCount: ownerQoS.queuedOperationCount,
      ownerSlowForegroundQueuedOperationCount,
      ownerSlowQueuedOperationCount: ownerQoS.slowQueuedOperationCount,
      reason: 'foreground-owner-queued-behind-background',
      status: 'blocked',
      thresholdMs,
    };
  }
  if (foregroundWaitP95Ms >= thresholdMs || foregroundWorstWaitMs >= thresholdMs) {
    return {
      backgroundCompleted: scheduler.priorityStats.background.completed,
      blockingForegroundLabels,
      foregroundWaitP95Ms,
      foregroundWorstWaitMs,
      observedBackgroundWork,
      observedForegroundWork,
      ownerQueuedOperationCount: ownerQoS.queuedOperationCount,
      ownerSlowForegroundQueuedOperationCount,
      ownerSlowQueuedOperationCount: ownerQoS.slowQueuedOperationCount,
      reason: 'foreground-scheduler-wait-threshold-exceeded',
      status: 'blocked',
      thresholdMs,
    };
  }
  if (!observedForegroundWork) {
    return {
      backgroundCompleted: scheduler.priorityStats.background.completed,
      blockingForegroundLabels,
      foregroundWaitP95Ms,
      foregroundWorstWaitMs,
      observedBackgroundWork,
      observedForegroundWork,
      ownerQueuedOperationCount: ownerQoS.queuedOperationCount,
      ownerSlowForegroundQueuedOperationCount,
      ownerSlowQueuedOperationCount: ownerQoS.slowQueuedOperationCount,
      reason: 'missing-foreground-work',
      status: 'insufficient-evidence',
      thresholdMs,
    };
  }
  if (!observedBackgroundWork) {
    return {
      backgroundCompleted: scheduler.priorityStats.background.completed,
      blockingForegroundLabels,
      foregroundWaitP95Ms,
      foregroundWorstWaitMs,
      observedBackgroundWork,
      observedForegroundWork,
      ownerQueuedOperationCount: ownerQoS.queuedOperationCount,
      ownerSlowForegroundQueuedOperationCount,
      ownerSlowQueuedOperationCount: ownerQoS.slowQueuedOperationCount,
      reason: 'missing-background-work',
      status: 'insufficient-evidence',
      thresholdMs,
    };
  }

  return {
    backgroundCompleted: scheduler.priorityStats.background.completed,
    blockingForegroundLabels,
    foregroundWaitP95Ms,
    foregroundWorstWaitMs,
    observedBackgroundWork,
    observedForegroundWork,
    ownerQueuedOperationCount: ownerQoS.queuedOperationCount,
    ownerSlowForegroundQueuedOperationCount,
    ownerSlowQueuedOperationCount: ownerQoS.slowQueuedOperationCount,
    reason: 'within-thresholds',
    status: 'accepted',
    thresholdMs,
  };
}
