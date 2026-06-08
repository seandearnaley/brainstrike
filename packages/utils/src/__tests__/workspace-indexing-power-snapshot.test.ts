import { describe, expect, it } from 'vitest';
import {
  assertValidWorkspaceIndexingPowerSnapshot,
  normalizeWorkspaceIndexingIdleState,
  normalizeWorkspaceIndexingThermalState,
  type WorkspaceIndexingPowerSnapshot,
} from '../workspace-indexing-power-snapshot';

describe('workspace-indexing power snapshot helpers', () => {
  it('accepts a valid workspace-indexing power snapshot', () => {
    const snapshot: WorkspaceIndexingPowerSnapshot = {
      idleState: 'idle',
      idleTimeMs: 90_000,
      powerSource: 'ac',
      thermalState: 'nominal',
    };

    expect(assertValidWorkspaceIndexingPowerSnapshot(snapshot)).toBe(snapshot);
  });

  it('rejects invalid snapshot values instead of guessing', () => {
    expect(() =>
      assertValidWorkspaceIndexingPowerSnapshot({
        idleState: 'sleeping',
        idleTimeMs: 0,
        powerSource: 'ac',
        thermalState: 'nominal',
      } as unknown as WorkspaceIndexingPowerSnapshot)
    ).toThrow('Workspace Index QoS power snapshot has invalid idleState: sleeping');

    expect(() =>
      assertValidWorkspaceIndexingPowerSnapshot({
        idleState: 'idle',
        idleTimeMs: -1,
        powerSource: 'ac',
        thermalState: 'nominal',
      } as WorkspaceIndexingPowerSnapshot)
    ).toThrow('Workspace Index QoS power snapshot has invalid idleTimeMs: -1');

    expect(() =>
      assertValidWorkspaceIndexingPowerSnapshot({
        idleState: 'idle',
        idleTimeMs: 0,
        powerSource: 'solar',
        thermalState: 'nominal',
      } as unknown as WorkspaceIndexingPowerSnapshot)
    ).toThrow('Workspace Index QoS power snapshot has invalid powerSource: solar');

    expect(() =>
      assertValidWorkspaceIndexingPowerSnapshot({
        idleState: 'idle',
        idleTimeMs: 0,
        powerSource: 'ac',
        thermalState: 'hot',
      } as unknown as WorkspaceIndexingPowerSnapshot)
    ).toThrow('Workspace Index QoS power snapshot has invalid thermalState: hot');
  });

  it('normalizes Electron idle and thermal strings through the shared valid sets', () => {
    expect(normalizeWorkspaceIndexingIdleState('locked', 'Electron powerMonitor')).toBe('locked');
    expect(normalizeWorkspaceIndexingThermalState('serious', 'Electron powerMonitor')).toBe(
      'serious'
    );
    expect(() => normalizeWorkspaceIndexingIdleState('sleeping', 'Electron powerMonitor')).toThrow(
      'Electron powerMonitor returned invalid idle state: sleeping'
    );
    expect(() => normalizeWorkspaceIndexingThermalState('hot', 'Electron powerMonitor')).toThrow(
      'Electron powerMonitor returned invalid thermal state: hot'
    );
  });
});
