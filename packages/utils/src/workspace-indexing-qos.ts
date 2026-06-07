export type WorkspaceIndexingQosState =
  | 'balanced'
  | 'foreground-yielding'
  | 'idle-ac'
  | 'interactive'
  | 'paused'
  | 'system-constrained';

export type WorkspaceIndexingQosReason =
  | 'balanced'
  | 'battery'
  | 'foreground-db-pressure'
  | 'foreground-query'
  | 'idle-ac'
  | 'manual-paused'
  | 'normal-db-pressure'
  | 'provider-rate-limited'
  | 'recent-user-input'
  | 'thermal-critical'
  | 'thermal-serious'
  | 'window-visible';

export type WorkspaceIndexingIdleState = 'active' | 'idle' | 'locked' | 'unknown';
export type WorkspaceIndexingPowerSource = 'ac' | 'battery' | 'unknown';
export type WorkspaceIndexingThermalState = 'critical' | 'fair' | 'nominal' | 'serious' | 'unknown';

export type WorkspaceIndexingDatabasePressure =
  | {
      available: false;
    }
  | {
      available: true;
      foregroundPressure: boolean;
      normalPressure: boolean;
    };

export interface WorkspaceIndexingQosInputs {
  dbPressure: WorkspaceIndexingDatabasePressure;
  foregroundQueryActive: boolean;
  idleState: WorkspaceIndexingIdleState;
  idleTimeMs: number | null;
  manualPaused: boolean;
  powerSource: WorkspaceIndexingPowerSource;
  providerRateLimited: boolean;
  queueDepth: number;
  recentUserInputMs: number | null;
  thermalState: WorkspaceIndexingThermalState;
  windowVisible: boolean;
}

export interface WorkspaceIndexingQosPolicy {
  allowNewWork: boolean;
  allowPowerSaveBlocker: boolean;
  backfillQueueDepth: number;
  contentReadBatchSize: number;
  contentReadConcurrency: number;
  importBatchSize: number;
  interBatchDelayMs: number;
  progressThrottleMs: number;
  reason: WorkspaceIndexingQosReason;
  scanBatchSize: number;
  state: WorkspaceIndexingQosState;
  workerClaimBatchSize: number;
}

const RECENT_USER_INPUT_WINDOW_MS = 30_000;
const IDLE_AC_MIN_IDLE_MS = 60_000;

const PAUSED_POLICY: WorkspaceIndexingQosPolicy = {
  allowNewWork: false,
  allowPowerSaveBlocker: false,
  backfillQueueDepth: 0,
  contentReadBatchSize: 0,
  contentReadConcurrency: 0,
  importBatchSize: 0,
  interBatchDelayMs: 1000,
  progressThrottleMs: 1000,
  reason: 'manual-paused',
  scanBatchSize: 0,
  state: 'paused',
  workerClaimBatchSize: 0,
};

function createForegroundYieldingPolicy(
  reason: Extract<WorkspaceIndexingQosReason, 'foreground-db-pressure' | 'foreground-query'>
): WorkspaceIndexingQosPolicy {
  return {
    ...PAUSED_POLICY,
    interBatchDelayMs: 250,
    progressThrottleMs: 500,
    reason,
    state: 'foreground-yielding',
  };
}

function createSystemConstrainedPolicy(
  reason: Extract<
    WorkspaceIndexingQosReason,
    'battery' | 'provider-rate-limited' | 'thermal-critical' | 'thermal-serious'
  >
): WorkspaceIndexingQosPolicy {
  return {
    allowNewWork: true,
    allowPowerSaveBlocker: false,
    backfillQueueDepth: 32,
    contentReadBatchSize: 4,
    contentReadConcurrency: 1,
    importBatchSize: 4,
    interBatchDelayMs: 1000,
    progressThrottleMs: 1000,
    reason,
    scanBatchSize: 8,
    state: 'system-constrained',
    workerClaimBatchSize: 1,
  };
}

function createInteractivePolicy(
  reason: Extract<WorkspaceIndexingQosReason, 'normal-db-pressure' | 'recent-user-input'>
): WorkspaceIndexingQosPolicy {
  return {
    allowNewWork: true,
    allowPowerSaveBlocker: false,
    backfillQueueDepth: 64,
    contentReadBatchSize: 8,
    contentReadConcurrency: 1,
    importBatchSize: 8,
    interBatchDelayMs: 250,
    progressThrottleMs: 500,
    reason,
    scanBatchSize: 16,
    state: 'interactive',
    workerClaimBatchSize: 1,
  };
}

function createIdleAcPolicy(): WorkspaceIndexingQosPolicy {
  return {
    allowNewWork: true,
    allowPowerSaveBlocker: true,
    backfillQueueDepth: 512,
    contentReadBatchSize: 48,
    contentReadConcurrency: 4,
    importBatchSize: 48,
    interBatchDelayMs: 50,
    progressThrottleMs: 250,
    reason: 'idle-ac',
    scanBatchSize: 96,
    state: 'idle-ac',
    workerClaimBatchSize: 16,
  };
}

function createBalancedPolicy(inputs: WorkspaceIndexingQosInputs): WorkspaceIndexingQosPolicy {
  return {
    allowNewWork: true,
    allowPowerSaveBlocker: inputs.powerSource !== 'battery',
    backfillQueueDepth: 256,
    contentReadBatchSize: 24,
    contentReadConcurrency: 4,
    importBatchSize: 24,
    interBatchDelayMs: 100,
    progressThrottleMs: 500,
    reason: inputs.windowVisible ? 'window-visible' : 'balanced',
    scanBatchSize: 48,
    state: 'balanced',
    workerClaimBatchSize: 16,
  };
}

function hasRecentUserInput(recentUserInputMs: number | null): boolean {
  return (
    typeof recentUserInputMs === 'number' &&
    Number.isFinite(recentUserInputMs) &&
    recentUserInputMs >= 0 &&
    recentUserInputMs < RECENT_USER_INPUT_WINDOW_MS
  );
}

function isIdleOnAc(inputs: WorkspaceIndexingQosInputs): boolean {
  return (
    inputs.powerSource === 'ac' &&
    inputs.idleState === 'idle' &&
    typeof inputs.idleTimeMs === 'number' &&
    inputs.idleTimeMs >= IDLE_AC_MIN_IDLE_MS &&
    !inputs.windowVisible
  );
}

export function resolveWorkspaceIndexingQosPolicy(
  inputs: WorkspaceIndexingQosInputs
): WorkspaceIndexingQosPolicy {
  if (!inputs.dbPressure.available) {
    throw new Error('Workspace Index QoS requires a database pressure snapshot.');
  }
  if (inputs.manualPaused) {
    return PAUSED_POLICY;
  }
  if (inputs.foregroundQueryActive) {
    return createForegroundYieldingPolicy('foreground-query');
  }
  if (inputs.dbPressure.foregroundPressure) {
    return createForegroundYieldingPolicy('foreground-db-pressure');
  }
  if (inputs.powerSource === 'battery') {
    return createSystemConstrainedPolicy('battery');
  }
  if (inputs.thermalState === 'critical') {
    return createSystemConstrainedPolicy('thermal-critical');
  }
  if (inputs.thermalState === 'serious') {
    return createSystemConstrainedPolicy('thermal-serious');
  }
  if (inputs.providerRateLimited) {
    return createSystemConstrainedPolicy('provider-rate-limited');
  }
  if (inputs.dbPressure.normalPressure) {
    return createInteractivePolicy('normal-db-pressure');
  }
  if (hasRecentUserInput(inputs.recentUserInputMs)) {
    return createInteractivePolicy('recent-user-input');
  }
  if (isIdleOnAc(inputs)) {
    return createIdleAcPolicy();
  }
  return createBalancedPolicy(inputs);
}
