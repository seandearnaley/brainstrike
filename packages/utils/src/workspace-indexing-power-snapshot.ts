import type {
  WorkspaceIndexingIdleState,
  WorkspaceIndexingPowerSource,
  WorkspaceIndexingThermalState,
} from './workspace-indexing-qos';

export interface WorkspaceIndexingPowerSnapshot {
  readonly idleState: WorkspaceIndexingIdleState;
  readonly idleTimeMs: number;
  readonly powerSource: WorkspaceIndexingPowerSource;
  readonly thermalState: WorkspaceIndexingThermalState;
}

export const WORKSPACE_INDEXING_IDLE_STATES = [
  'active',
  'idle',
  'locked',
  'unknown',
] as const satisfies readonly WorkspaceIndexingIdleState[];

export const WORKSPACE_INDEXING_POWER_SOURCES = [
  'ac',
  'battery',
  'unknown',
] as const satisfies readonly WorkspaceIndexingPowerSource[];

export const WORKSPACE_INDEXING_THERMAL_STATES = [
  'critical',
  'fair',
  'nominal',
  'serious',
  'unknown',
] as const satisfies readonly WorkspaceIndexingThermalState[];

const VALID_IDLE_STATES: ReadonlySet<string> = new Set(WORKSPACE_INDEXING_IDLE_STATES);
const VALID_POWER_SOURCES: ReadonlySet<string> = new Set(WORKSPACE_INDEXING_POWER_SOURCES);
const VALID_THERMAL_STATES: ReadonlySet<string> = new Set(WORKSPACE_INDEXING_THERMAL_STATES);

export function normalizeWorkspaceIndexingIdleState(
  value: string,
  sourceLabel: string
): WorkspaceIndexingIdleState {
  if (VALID_IDLE_STATES.has(value)) {
    return value as WorkspaceIndexingIdleState;
  }
  throw new Error(`${sourceLabel} returned invalid idle state: ${value}`);
}

export function normalizeWorkspaceIndexingThermalState(
  value: string,
  sourceLabel: string
): WorkspaceIndexingThermalState {
  if (VALID_THERMAL_STATES.has(value)) {
    return value as WorkspaceIndexingThermalState;
  }
  throw new Error(`${sourceLabel} returned invalid thermal state: ${value}`);
}

export function assertValidWorkspaceIndexingPowerSnapshot(
  snapshot: WorkspaceIndexingPowerSnapshot
): WorkspaceIndexingPowerSnapshot {
  if (!VALID_IDLE_STATES.has(snapshot.idleState)) {
    throw new Error(
      `Workspace Index QoS power snapshot has invalid idleState: ${snapshot.idleState}`
    );
  }
  if (!(Number.isFinite(snapshot.idleTimeMs) && snapshot.idleTimeMs >= 0)) {
    throw new Error(
      `Workspace Index QoS power snapshot has invalid idleTimeMs: ${snapshot.idleTimeMs}`
    );
  }
  if (!VALID_POWER_SOURCES.has(snapshot.powerSource)) {
    throw new Error(
      `Workspace Index QoS power snapshot has invalid powerSource: ${snapshot.powerSource}`
    );
  }
  if (!VALID_THERMAL_STATES.has(snapshot.thermalState)) {
    throw new Error(
      `Workspace Index QoS power snapshot has invalid thermalState: ${snapshot.thermalState}`
    );
  }
  return snapshot;
}
