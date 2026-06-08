import {
  normalizeWorkspaceIndexingIdleState,
  normalizeWorkspaceIndexingThermalState,
  type WorkspaceIndexingPowerSnapshot,
} from '@brainstrike/utils/workspace-indexing-power-snapshot';
import type { WorkspaceIndexingPowerSource } from '@brainstrike/utils/workspace-indexing-qos';

const IDLE_THRESHOLD_SECONDS = 60;

export interface DesktopPowerSnapshot extends WorkspaceIndexingPowerSnapshot {
  readonly sampledAt: number;
}

interface DesktopPowerMonitor {
  readonly getCurrentThermalState?: () => string;
  readonly getSystemIdleState: (idleThreshold: number) => string;
  readonly getSystemIdleTime: () => number;
  readonly isOnBatteryPower?: () => boolean;
  readonly onBatteryPower?: boolean;
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

function resolveThermalState(
  powerMonitor: DesktopPowerMonitor
): DesktopPowerSnapshot['thermalState'] {
  if (typeof powerMonitor.getCurrentThermalState !== 'function') {
    return 'unknown';
  }
  return normalizeWorkspaceIndexingThermalState(
    powerMonitor.getCurrentThermalState(),
    'Electron powerMonitor'
  );
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
    idleState: normalizeWorkspaceIndexingIdleState(
      powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS),
      'Electron powerMonitor'
    ),
    idleTimeMs: resolveIdleTimeMs(powerMonitor),
    powerSource: resolvePowerSource(powerMonitor),
    sampledAt: now(),
    thermalState: resolveThermalState(powerMonitor),
  };
}
