import { beforeEach, describe, expect, it } from 'vitest';
import { addLogListener, configureLogger, LogLevel, type LogRecord, setLogLevel } from '../logger';
import {
  createWorkspaceIndexingQosTransitionLogger,
  resolveWorkspaceIndexingQosPolicy,
  type WorkspaceIndexingQosInputs,
} from '../workspace-indexing-qos';

const baseInputs: WorkspaceIndexingQosInputs = {
  dbPressure: {
    available: true,
    foregroundPressure: false,
    normalPressure: false,
  },
  foregroundQueryActive: false,
  idleState: 'active',
  idleTimeMs: 0,
  manualPaused: false,
  powerSource: 'ac',
  providerRateLimited: false,
  recentUserInputMs: null,
  thermalState: 'nominal',
  windowVisible: true,
};

function resolve(overrides: Partial<WorkspaceIndexingQosInputs> = {}) {
  return resolveWorkspaceIndexingQosPolicy({
    ...baseInputs,
    ...overrides,
  });
}

describe('resolveWorkspaceIndexingQosPolicy', () => {
  it('returns zero new-work capacity while manually paused', () => {
    const policy = resolve({ manualPaused: true });

    expect(policy).toMatchObject({
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      contentReadBatchSize: 0,
      contentReadConcurrency: 0,
      importBatchSize: 0,
      interBatchDelayMs: 1000,
      reason: 'manual-paused',
      scanBatchSize: 0,
      state: 'paused',
      workerClaimBatchSize: 0,
    });
  });

  it('returns a fresh paused policy object on each resolve', () => {
    const firstPolicy = resolve({ manualPaused: true });
    const secondPolicy = resolve({ manualPaused: true });

    expect(firstPolicy).not.toBe(secondPolicy);
  });

  it('blocks new background claims while a foreground query is active', () => {
    const policy = resolve({ foregroundQueryActive: true });

    expect(policy).toMatchObject({
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      reason: 'foreground-query',
      state: 'foreground-yielding',
      workerClaimBatchSize: 0,
    });
  });

  it('constrains work after recent user activity', () => {
    const policy = resolve({ recentUserInputMs: 1200 });

    expect(policy.state).toBe('interactive');
    expect(policy.contentReadConcurrency).toBe(1);
    expect(policy.workerClaimBatchSize).toBe(1);
    expect(policy.importBatchSize).toBeLessThan(24);
  });

  it('raises throughput only when idle on AC power without DB pressure', () => {
    const policy = resolve({
      idleState: 'idle',
      idleTimeMs: 90_000,
      windowVisible: false,
    });

    expect(policy).toMatchObject({
      allowNewWork: true,
      allowPowerSaveBlocker: true,
      contentReadConcurrency: 4,
      importBatchSize: 48,
      reason: 'idle-ac',
      state: 'idle-ac',
      workerClaimBatchSize: 16,
    });
  });

  it('uses constrained policy on battery or serious thermal pressure', () => {
    expect(resolve({ powerSource: 'battery' })).toMatchObject({
      allowPowerSaveBlocker: false,
      contentReadConcurrency: 1,
      reason: 'battery',
      state: 'system-constrained',
      workerClaimBatchSize: 1,
    });

    expect(resolve({ thermalState: 'serious' })).toMatchObject({
      allowPowerSaveBlocker: false,
      reason: 'thermal-serious',
      state: 'system-constrained',
      workerClaimBatchSize: 1,
    });
  });

  it('yields to foreground database pressure', () => {
    const policy = resolve({
      dbPressure: {
        available: true,
        foregroundPressure: true,
        normalPressure: false,
      },
    });

    expect(policy).toMatchObject({
      reason: 'foreground-db-pressure',
      state: 'foreground-yielding',
      workerClaimBatchSize: 0,
    });
  });

  it('throws when the required DB pressure snapshot is missing', () => {
    expect(() =>
      resolve({
        dbPressure: {
          available: false,
        },
      })
    ).toThrow('Workspace Index QoS requires a database pressure snapshot.');
  });

  it('preserves the existing balanced worker claim throughput', () => {
    const policy = resolve({ windowVisible: false });

    expect(policy).toMatchObject({
      state: 'balanced',
      workerClaimBatchSize: 16,
    });
  });
});

describe('createWorkspaceIndexingQosTransitionLogger', () => {
  let captured: LogRecord[];
  let removeListener: () => void;

  beforeEach(() => {
    configureLogger({ enableInProduction: true });
    setLogLevel(LogLevel.INFO);
    captured = [];
    removeListener = addLogListener((record) => {
      if (record.scope === 'WorkspaceIndexingQos') {
        captured.push(record);
      }
    });
    return () => {
      removeListener();
    };
  });

  it('logs the initial policy observation with a null from', () => {
    const observe = createWorkspaceIndexingQosTransitionLogger();

    observe(resolve());

    expect(captured).toHaveLength(1);
    expect(captured[0]?.message).toBe('Workspace indexing QoS state changed');
    expect(captured[0]?.args).toContainEqual(
      expect.objectContaining({
        from: null,
        to: { reason: 'window-visible', state: 'balanced' },
      })
    );
  });

  it('does not log when the same state and reason are observed again', () => {
    const observe = createWorkspaceIndexingQosTransitionLogger();

    observe(resolve());
    observe(resolve());
    observe(resolve());

    expect(captured).toHaveLength(1);
  });

  it('logs a from/to transition when the state changes', () => {
    const observe = createWorkspaceIndexingQosTransitionLogger();

    observe(resolve());
    observe(resolve({ foregroundQueryActive: true }));

    expect(captured).toHaveLength(2);
    expect(captured[1]?.args).toContainEqual(
      expect.objectContaining({
        from: { reason: 'window-visible', state: 'balanced' },
        to: { reason: 'foreground-query', state: 'foreground-yielding' },
      })
    );
  });

  it('logs a reason change even when the state is unchanged', () => {
    const observe = createWorkspaceIndexingQosTransitionLogger();

    // Both resolve to system-constrained, but for different reasons.
    observe(resolve({ powerSource: 'battery' }));
    observe(resolve({ thermalState: 'serious' }));

    expect(captured).toHaveLength(2);
    expect(captured[1]?.args).toContainEqual(
      expect.objectContaining({
        from: { reason: 'battery', state: 'system-constrained' },
        to: { reason: 'thermal-serious', state: 'system-constrained' },
      })
    );
  });
});
