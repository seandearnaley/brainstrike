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
  pipeline: {
    accelerator: {
      available: false,
    },
    memory: {
      available: false,
    },
    progress: {
      available: false,
    },
    queueDepth: {
      available: false,
    },
  },
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
      completionOverlapBatches: 3,
      contentReadConcurrency: 4,
      importBatchSize: 48,
      maxPendingCompletionChunks: 64,
      reason: 'idle-ac',
      state: 'idle-ac',
      streamBatchSize: 16,
      workerClaimBatchSize: 16,
    });
  });

  it('keeps balanced capacity high enough to feed streaming inference and completion overlap', () => {
    const policy = resolve({ windowVisible: false });

    expect(policy).toMatchObject({
      completionOverlapBatches: 2,
      contentReadConcurrency: 4,
      importBatchSize: 24,
      maxPendingCompletionChunks: 32,
      state: 'balanced',
      streamBatchSize: 8,
      workerClaimBatchSize: 16,
    });
  });

  it('drops pipeline capacity under foreground pressure and restores it after pressure clears', () => {
    const pressured = resolve({
      dbPressure: {
        available: true,
        foregroundPressure: true,
        normalPressure: false,
      },
      windowVisible: false,
    });
    const recovered = resolve({ windowVisible: false });

    expect(pressured).toMatchObject({
      allowNewWork: false,
      completionOverlapBatches: 1,
      maxPendingCompletionChunks: 1,
      state: 'foreground-yielding',
      streamBatchSize: 1,
      workerClaimBatchSize: 0,
    });
    expect(recovered).toMatchObject({
      allowNewWork: true,
      completionOverlapBatches: 2,
      maxPendingCompletionChunks: 32,
      state: 'balanced',
      streamBatchSize: 8,
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

  it('constrains work immediately under high memory pressure and recovers when memory clears', () => {
    const pressured = resolve({
      pipeline: {
        ...baseInputs.pipeline,
        memory: {
          available: true,
          pressure: 'high',
          retainedHeapRatio: 0.82,
        },
      },
    });
    const recovered = resolve({
      pipeline: {
        ...baseInputs.pipeline,
        memory: {
          available: true,
          pressure: 'normal',
          retainedHeapRatio: 0.48,
        },
      },
      windowVisible: false,
    });

    expect(pressured).toMatchObject({
      reason: 'memory-pressure',
      state: 'system-constrained',
      workerClaimBatchSize: 1,
    });
    expect(recovered).toMatchObject({
      reason: 'balanced',
      state: 'balanced',
      workerClaimBatchSize: 16,
    });
  });

  it('boosts unpressured queued work when accelerator idle ratio is high', () => {
    const policy = resolve({
      pipeline: {
        ...baseInputs.pipeline,
        accelerator: {
          available: true,
          idleRatio: 0.5,
        },
        queueDepth: {
          activeEmbeddingJobs: 256,
          available: true,
        },
      },
      windowVisible: false,
    });

    expect(policy).toMatchObject({
      importBatchSize: 48,
      maxPendingCompletionChunks: 64,
      reason: 'accelerator-idle',
      state: 'balanced',
      streamBatchSize: 16,
      workerClaimBatchSize: 16,
    });
  });

  it('constrains work when progress is stalled and recovers when progress resumes', () => {
    const stalled = resolve({
      pipeline: {
        ...baseInputs.pipeline,
        progress: {
          available: true,
          stalledForMs: 120_000,
        },
      },
    });
    const recovered = resolve({
      pipeline: {
        ...baseInputs.pipeline,
        progress: {
          available: true,
          stalledForMs: 0,
        },
      },
      windowVisible: false,
    });

    expect(stalled).toMatchObject({
      reason: 'progress-stalled',
      state: 'system-constrained',
      workerClaimBatchSize: 1,
    });
    expect(recovered).toMatchObject({
      reason: 'balanced',
      state: 'balanced',
      workerClaimBatchSize: 16,
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

  it('downgrades foreground database pressure to gentle constrained work under the starvation bypass', () => {
    const policy = resolve({
      dbPressure: {
        available: true,
        foregroundPressure: true,
        normalPressure: false,
      },
      foregroundDbPressureStarvationBypass: true,
    });

    // A sync pass starved beyond the bound must make progress, but gently.
    expect(policy).toMatchObject({
      allowNewWork: true,
      reason: 'foreground-db-pressure',
      state: 'system-constrained',
    });
  });

  it('still fully yields to an active foreground query even when the starvation bypass is set', () => {
    const policy = resolve({
      dbPressure: {
        available: true,
        foregroundPressure: true,
        normalPressure: false,
      },
      foregroundDbPressureStarvationBypass: true,
      foregroundQueryActive: true,
    });

    // The bypass only relaxes DB pressure; genuine foreground-query activity
    // (the user is waiting on the assistant) must keep blocking new work.
    expect(policy).toMatchObject({
      allowNewWork: false,
      reason: 'foreground-query',
      state: 'foreground-yielding',
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
    const observe = createWorkspaceIndexingQosTransitionLogger('test-loop');

    observe(resolve());

    expect(captured).toHaveLength(1);
    expect(captured[0]?.message).toBe('Workspace indexing QoS state changed');
    expect(captured[0]?.args).toContainEqual(
      expect.objectContaining({
        from: null,
        // Two independent loops (desktop host-claim + app-shell sync) share this
        // scope and message; the loop discriminator keeps their streams separable.
        loop: 'test-loop',
        to: { reason: 'window-visible', state: 'balanced' },
      })
    );
  });

  it('does not log when the same state and reason are observed again', () => {
    const observe = createWorkspaceIndexingQosTransitionLogger('test-loop');

    observe(resolve());
    observe(resolve());
    observe(resolve());

    expect(captured).toHaveLength(1);
  });

  it('logs a from/to transition when the state changes', () => {
    const observe = createWorkspaceIndexingQosTransitionLogger('test-loop');

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
    const observe = createWorkspaceIndexingQosTransitionLogger('test-loop');

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
