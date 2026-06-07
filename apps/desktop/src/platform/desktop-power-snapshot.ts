import type {
  WorkspaceIndexingIdleState,
  WorkspaceIndexingPowerSource,
  WorkspaceIndexingThermalState,
} from '@brainstrike/utils/workspace-indexing-qos';

const IDLE_THRESHOLD_SECONDS = 60;
const VALID_IDLE_STATES = new Set<WorkspaceIndexingIdleState>([
  'active',
  'idle',
  'locked',
  'unknown',
]);
const VALID_THERMAL_STATES = new Set<WorkspaceIndexingThermalState>([
  'critical',
  'fair',
  'nominal',
  'serious',
  'unknown',
]);

export interface DesktopPowerSnapshot {
  readonly idleState: WorkspaceIndexingIdleState;
  readonly idleTimeMs: number;
  readonly powerSource: WorkspaceIndexingPowerSource;
  readonly sampledAt: number;
  readonly thermalState: WorkspaceIndexingThermalState;
}

interface DesktopPowerMonitor {
  readonly getCurrentThermalState?: () => string;
  readonly getSystemIdleState: (idleThreshold: number) => string;
  readonly getSystemIdleTime: () => number;
  readonly isOnBatteryPower?: () => boolean;
  readonly onBatteryPower?: boolean;
}

function normalizeIdleState(value: string): WorkspaceIndexingIdleState {
  if (VALID_IDLE_STATES.has(value as WorkspaceIndexingIdleState)) {
    return value as WorkspaceIndexingIdleState;
  }
  throw new Error(`Electron powerMonitor returned invalid idle state: ${value}`);
}

function normalizeThermalState(value: string): WorkspaceIndexingThermalState {
  if (VALID_THERMAL_STATES.has(value as WorkspaceIndexingThermalState)) {
    return value as WorkspaceIndexingThermalState;
  }
  throw new Error(`Electron powerMonitor returned invalid thermal state: ${value}`);
}

function resolvePowerSource(powerMonitor: DesktopPowerMonitor): WorkspaceIndexingPowerSource {
  if (typeof powerMonitor.isOnBatteryPower === 'function') {
    return powerMonitor.isOnBatteryPower() ? 'battery' : 'ac';
  }
  if (typeof powerMonitor.onBatteryPower === 'boolean') {
    return powerMonitor.onBatteryPower ? 'battery' : 'ac';
  }
  return 'unknown';
}

function resolveThermalState(powerMonitor: DesktopPowerMonitor): WorkspaceIndexingThermalState {
  if (typeof powerMonitor.getCurrentThermalState !== 'function') {
    return 'unknown';
  }
  return normalizeThermalState(powerMonitor.getCurrentThermalState());
}

function resolveIdleTimeMs(powerMonitor: DesktopPowerMonitor): number {
  const idleTimeSeconds = powerMonitor.getSystemIdleTime();
  if (!(Number.isFinite(idleTimeSeconds) && idleTimeSeconds >= 0)) {
    throw new Error(`Electron powerMonitor returned invalid idle time: ${idleTimeSeconds}`);
  }
  return Math.round(idleTimeSeconds * 1000);
}

export function readDesktopPowerSnapshot(
  powerMonitor: DesktopPowerMonitor,
  now: () => number = () => Date.now()
): DesktopPowerSnapshot {
  return {
    idleState: normalizeIdleState(powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS)),
    idleTimeMs: resolveIdleTimeMs(powerMonitor),
    powerSource: resolvePowerSource(powerMonitor),
    sampledAt: now(),
    thermalState: resolveThermalState(powerMonitor),
  };
}
