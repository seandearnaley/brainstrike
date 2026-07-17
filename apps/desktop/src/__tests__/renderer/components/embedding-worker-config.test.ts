import {
  createDatabaseWorkScheduler,
  createScheduledDbHandle,
  getDatabaseWorkScheduler,
} from '@brainstrike/db';
import type {
  WorkspaceIndexingQosInputs,
  WorkspaceIndexingQosPolicy,
} from '@brainstrike/utils/workspace-indexing-qos';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerInfoMock, registryStoreState, resolveWorkspaceIndexingQosPolicyMock } = vi.hoisted(
  () => ({
    loggerInfoMock: vi.fn(),
    registryStoreState: {
      setDownloading: vi.fn(),
      setDownloadProgress: vi.fn(),
    },
    resolveWorkspaceIndexingQosPolicyMock: vi.fn(),
  })
);

vi.mock('@brainstrike/preferences/stores/model-registry-store', () => ({
  useModelRegistryStore: {
    getState: () => registryStoreState,
  },
}));

vi.mock('@brainstrike/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logger')>(
    '@brainstrike/utils/logger'
  );
  return {
    ...actual,
    createLogger: () => ({
      info: loggerInfoMock,
    }),
  };
});

vi.mock('@brainstrike/utils/workspace-indexing-qos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/workspace-indexing-qos')>();
  const createMockQosPolicy = (inputs: WorkspaceIndexingQosInputs): WorkspaceIndexingQosPolicy => {
    const foregroundYielding =
      inputs.foregroundQueryActive ||
      (inputs.dbPressure.available && inputs.dbPressure.foregroundPressure);
    const interactive = inputs.dbPressure.available && inputs.dbPressure.normalPressure;
    const memoryConstrained =
      inputs.pipeline.memory.available && inputs.pipeline.memory.pressure === 'high';
    const progressConstrained =
      inputs.pipeline.progress.available &&
      typeof inputs.pipeline.progress.stalledForMs === 'number' &&
      inputs.pipeline.progress.stalledForMs >= 120_000;
    const constrained =
      inputs.powerSource === 'battery' ||
      inputs.thermalState === 'serious' ||
      memoryConstrained ||
      progressConstrained;
    const acceleratorBoost =
      inputs.pipeline.accelerator.available &&
      inputs.pipeline.accelerator.idleRatio >= 0.35 &&
      inputs.pipeline.queueDepth.available &&
      inputs.pipeline.queueDepth.activeEmbeddingJobs >= 128 &&
      !constrained &&
      !foregroundYielding;
    return {
      allowNewWork: !foregroundYielding,
      allowPowerSaveBlocker: false,
      backfillQueueDepth: 0,
      completionOverlapBatches: foregroundYielding
        ? 1
        : interactive || constrained
          ? 1
          : acceleratorBoost
            ? 3
            : 2,
      contentReadBatchSize: foregroundYielding ? 0 : 24,
      contentReadConcurrency: foregroundYielding ? 0 : 1,
      importBatchSize: foregroundYielding ? 0 : acceleratorBoost ? 48 : 24,
      interBatchDelayMs: foregroundYielding ? 250 : 75,
      maxPendingCompletionBytes: foregroundYielding
        ? 3072
        : interactive || constrained
          ? 98_304
          : acceleratorBoost
            ? 1_572_864
            : 786_432,
      maxPendingCompletionChunks: foregroundYielding
        ? 1
        : interactive || constrained
          ? 8
          : acceleratorBoost
            ? 64
            : 32,
      progressThrottleMs: 500,
      reason: foregroundYielding
        ? 'foreground-db-pressure'
        : interactive
          ? 'normal-db-pressure'
          : constrained
            ? memoryConstrained
              ? 'memory-pressure'
              : progressConstrained
                ? 'progress-stalled'
                : inputs.powerSource === 'battery'
                  ? 'battery'
                  : 'thermal-serious'
            : acceleratorBoost
              ? 'accelerator-idle'
              : 'balanced',
      scanBatchSize: foregroundYielding ? 0 : 48,
      state: foregroundYielding
        ? 'foreground-yielding'
        : interactive
          ? 'interactive'
          : constrained
            ? 'system-constrained'
            : 'balanced',
      streamBatchSize: foregroundYielding
        ? 1
        : interactive || constrained
          ? 2
          : acceleratorBoost
            ? 16
            : 8,
      workerClaimBatchSize: foregroundYielding ? 0 : interactive || constrained ? 1 : 16,
    };
  };
  resolveWorkspaceIndexingQosPolicyMock.mockImplementation(
    (inputs: WorkspaceIndexingQosInputs): WorkspaceIndexingQosPolicy => createMockQosPolicy(inputs)
  );
  return {
    ...actual,
    resolveWorkspaceIndexingQosPolicy: resolveWorkspaceIndexingQosPolicyMock,
  };
});

import { createEmbeddingWorkerConfig } from '../../../renderer/components/embedding-worker-config';

function createScheduledTestDb(
  options: Parameters<typeof createDatabaseWorkScheduler>[0] = { foregroundQuietMs: 0 }
) {
  const db = { query: vi.fn(async () => ({ rows: [] })) };
  const scheduler = createDatabaseWorkScheduler(options);
  return {
    db,
    scheduledDb: createScheduledDbHandle(db, scheduler, 'background'),
  };
}

describe('createEmbeddingWorkerConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    import.meta.env['VITE_EMBED_CLAIM_BATCH_SIZE'] = '';
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '';
    import.meta.env['VITE_EMBED_INTER_BATCH_DELAY_MS'] = '';
    import.meta.env['VITE_EMBED_LEASE_MS'] = '';
    import.meta.env['VITE_EMBED_COMPLETION_OVERLAP_BATCHES'] = '';
    import.meta.env['VITE_EMBED_MAX_PENDING_COMPLETION_BYTES'] = '';
    import.meta.env['VITE_EMBED_MAX_PENDING_COMPLETION_CHUNKS'] = '';
    import.meta.env['VITE_EMBED_STREAM_BATCH_SIZE'] = '';
    import.meta.env['VITE_EMBED_MODEL_KEY'] = '';
  });

  it('uses strict defaults when optional env vars are not configured', () => {
    const { db, scheduledDb } = createScheduledTestDb();

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    expect(config).toMatchObject({
      claimBatchSize: 16,
      concurrency: 1,
      db: scheduledDb,
      interBatchDelayMs: 75,
      leaseMs: 60_000,
      log: expect.any(Function),
      maxPendingCompletionBatches: 2,
      maxPendingCompletionBytes: 786_432,
      maxPendingCompletionChunks: 32,
      onDownloadProgress: expect.any(Function),
      resolveClaimBatchSize: expect.any(Function),
      resolvePipelineCapacity: expect.any(Function),
      streamBatchSize: 8,
      waitForBackgroundPermit: expect.any(Function),
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('uses the idle desktop claim batch when no foreground database work is active', async () => {
    const { scheduledDb } = createScheduledTestDb();

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBe(16);
  });

  it('derives desktop claim size from the shared workspace index QoS policy', async () => {
    const { scheduledDb } = createScheduledTestDb();

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBe(16);
    expect(resolveWorkspaceIndexingQosPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPressure: {
          available: true,
          foregroundPressure: false,
          normalPressure: false,
        },
        foregroundQueryActive: false,
        idleState: 'active',
        manualPaused: false,
        pipeline: expect.objectContaining({
          accelerator: { available: false },
          memory: { available: false },
          progress: { available: true, stalledForMs: null },
          queueDepth: { activeEmbeddingJobs: 0, available: true },
        }),
        powerSource: 'unknown',
        providerRateLimited: false,
        thermalState: 'unknown',
        windowVisible: false,
      })
    );
  });

  it('passes measured embedding queue depth into desktop QoS resolution', async () => {
    const { db, scheduledDb } = createScheduledTestDb();
    db.query.mockResolvedValueOnce({ rows: [{ count: 256 }] });

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBe(16);
    expect(resolveWorkspaceIndexingQosPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: expect.objectContaining({
          queueDepth: {
            activeEmbeddingJobs: 256,
            available: true,
          },
        }),
      })
    );
  });

  it('passes renderer memory pressure into desktop QoS resolution', async () => {
    const { scheduledDb } = createScheduledTestDb();
    Object.defineProperty(globalThis.performance, 'memory', {
      configurable: true,
      value: {
        jsHeapSizeLimit: 100,
        usedJSHeapSize: 82,
      },
    });

    try {
      const config = createEmbeddingWorkerConfig(scheduledDb as never);

      await expect(config.resolveClaimBatchSize?.()).resolves.toBe(1);
      expect(resolveWorkspaceIndexingQosPolicyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          pipeline: expect.objectContaining({
            memory: {
              available: true,
              pressure: 'high',
              retainedHeapRatio: 0.82,
            },
          }),
        })
      );
    } finally {
      Reflect.deleteProperty(globalThis.performance, 'memory');
    }
  });

  it('passes accelerator idle ratio and stalled-progress window into desktop QoS resolution', async () => {
    const { db, scheduledDb } = createScheduledTestDb();
    db.query.mockResolvedValue({ rows: [{ count: 256 }] });
    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    config.log?.('embedding_pipeline_timing', {
      completionWaitMs: 90,
      inferenceMs: 10,
    });

    await expect(config.resolvePipelineCapacity?.()).resolves.toMatchObject({
      maxPendingCompletionBatches: 2,
      maxPendingCompletionChunks: 32,
      streamBatchSize: 8,
    });
    expect(resolveWorkspaceIndexingQosPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: expect.objectContaining({
          accelerator: {
            available: true,
            idleRatio: 0.9,
          },
          progress: expect.objectContaining({
            available: true,
            stalledForMs: expect.any(Number),
          }),
        }),
      })
    );
  });

  it('constrains desktop claim size from the power snapshot', async () => {
    const { scheduledDb } = createScheduledTestDb();
    Object.assign(window, {
      power: {
        getSnapshot: vi.fn(async () => ({
          idleState: 'active',
          idleTimeMs: 0,
          powerSource: 'battery',
          sampledAt: 1234,
          thermalState: 'nominal',
        })),
        onPowerState: vi.fn(() => () => {}),
      },
    });

    try {
      const config = createEmbeddingWorkerConfig(scheduledDb as never);

      await expect(config.resolveClaimBatchSize?.()).resolves.toBe(1);
      expect(resolveWorkspaceIndexingQosPolicyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          powerSource: 'battery',
          thermalState: 'nominal',
        })
      );
    } finally {
      Reflect.deleteProperty(window, 'power');
    }
  });

  it('reuses a cached desktop power snapshot across immediate claim-size reads', async () => {
    const { scheduledDb } = createScheduledTestDb();
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        idleState: 'active',
        idleTimeMs: 0,
        powerSource: 'battery',
        sampledAt: 1234,
        thermalState: 'nominal',
      })
      .mockResolvedValueOnce({
        idleState: 'active',
        idleTimeMs: 0,
        powerSource: 'ac',
        sampledAt: 1235,
        thermalState: 'nominal',
      });
    Object.assign(window, {
      power: {
        getSnapshot,
        onPowerState: vi.fn(() => () => {}),
      },
    });

    try {
      const config = createEmbeddingWorkerConfig(scheduledDb as never);

      await expect(config.resolveClaimBatchSize?.()).resolves.toBe(1);
      await expect(config.resolveClaimBatchSize?.()).resolves.toBe(1);

      expect(getSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(window, 'power');
    }
  });

  it('logs a QoS transition once across repeated claim-size reads under unchanged conditions', async () => {
    const { scheduledDb } = createScheduledTestDb();

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBe(16);
    await expect(config.resolveClaimBatchSize?.()).resolves.toBe(16);

    const transitionLogs = loggerInfoMock.mock.calls.filter(
      ([message]) => message === 'Workspace indexing QoS state changed'
    );
    expect(transitionLogs).toHaveLength(1);
    expect(transitionLogs[0]?.[1]).toMatchObject({
      from: null,
      to: { reason: 'balanced', state: 'balanced' },
    });
  });

  it('shares a recent Electron scheduler snapshot between permit and claim-size checks', async () => {
    const { scheduledDb } = createScheduledTestDb();
    const snapshot = getDatabaseWorkScheduler(scheduledDb)?.getSnapshot();
    if (!snapshot) {
      throw new Error('Test scheduled DB handle did not expose its scheduler.');
    }
    const schedulerSnapshot = vi.fn(async () => snapshot);
    Object.assign(window.electronAPI, {
      db: {
        schedulerSnapshot,
      },
    });

    const config = createEmbeddingWorkerConfig({
      query: vi.fn(async () => ({ rows: [{ count: 0 }] })),
    } as never);

    await config.waitForBackgroundPermit?.({ label: 'embedding claim' });
    await expect(config.resolveClaimBatchSize?.()).resolves.toBe(16);

    expect(schedulerSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not reuse an expired Electron scheduler snapshot after a read failure', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const { scheduledDb } = createScheduledTestDb();
      const scheduler = getDatabaseWorkScheduler(scheduledDb);
      const idleSnapshot = scheduler?.getSnapshot();
      if (!idleSnapshot) {
        throw new Error('Test scheduled DB handle did not expose its scheduler.');
      }
      const pressuredSnapshot = {
        ...idleSnapshot,
        queued: {
          ...idleSnapshot.queued,
          foreground: 1,
        },
      };
      const schedulerSnapshot = vi
        .fn()
        .mockResolvedValueOnce(idleSnapshot)
        .mockRejectedValueOnce(new Error('scheduler unavailable'))
        .mockResolvedValueOnce(pressuredSnapshot);
      Object.assign(window.electronAPI, {
        db: {
          schedulerSnapshot,
        },
      });

      const config = createEmbeddingWorkerConfig({
        query: vi.fn(async () => ({ rows: [{ count: 0 }] })),
      } as never);

      await expect(config.resolveClaimBatchSize?.()).resolves.toBe(16);
      vi.setSystemTime(1011);
      await expect(config.resolveClaimBatchSize?.()).rejects.toThrow('scheduler unavailable');
      await expect(config.resolveClaimBatchSize?.()).resolves.toBeNull();

      expect(schedulerSnapshot).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces synchronous Electron scheduler snapshot failures', async () => {
    const schedulerSnapshot = vi.fn(() => {
      throw new Error('scheduler crashed synchronously');
    });
    Object.assign(window.electronAPI, {
      db: {
        schedulerSnapshot,
      },
    });

    const config = createEmbeddingWorkerConfig({
      query: vi.fn(async () => ({ rows: [{ count: 0 }] })),
    } as never);
    const firstRead = config.resolveClaimBatchSize?.();
    const secondRead = config.resolveClaimBatchSize?.();

    await expect(firstRead).rejects.toThrow('scheduler crashed synchronously');
    await expect(secondRead).rejects.toThrow('scheduler crashed synchronously');
    expect(schedulerSnapshot).toHaveBeenCalledTimes(1);
  });

  it('pauses desktop claims while foreground database work is running', async () => {
    const { scheduledDb } = createScheduledTestDb();
    const scheduler = getDatabaseWorkScheduler(scheduledDb);
    if (!scheduler) {
      throw new Error('Test scheduled DB handle did not expose its scheduler.');
    }
    let releaseForegroundWork!: () => void;
    const foregroundWork = scheduler.run(
      () =>
        new Promise<void>((resolve) => {
          releaseForegroundWork = resolve;
        }),
      { label: 'test foreground query', priority: 'foreground' }
    );

    await vi.waitFor(() => {
      expect(scheduler.getSnapshot().runningPriority).toBe('foreground');
    });

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBeNull();

    releaseForegroundWork();
    await foregroundWork;
  });

  it('pauses desktop claims while a foreground query embedding is active', async () => {
    const { scheduledDb } = createScheduledTestDb();
    const gate = {
      begin: vi.fn(),
      end: vi.fn(),
      isActive: vi.fn(() => true),
      waitUntilInactive: vi.fn(async () => {}),
    };

    const config = createEmbeddingWorkerConfig(scheduledDb as never, gate);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBeNull();
    expect(resolveWorkspaceIndexingQosPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        foregroundQueryActive: true,
      })
    );
  });

  it('pauses desktop claims after recent high-latency foreground database work', async () => {
    let now = 1000;
    const { scheduledDb } = createScheduledTestDb({
      foregroundQuietMs: 0,
      now: () => now,
    });
    const scheduler = getDatabaseWorkScheduler(scheduledDb);
    if (!scheduler) {
      throw new Error('Test scheduled DB handle did not expose its scheduler.');
    }

    await scheduler.run(
      async () => {
        now += 130;
      },
      { label: 'slow foreground query', priority: 'foreground' }
    );

    expect(scheduler.getSnapshot().priorityStats.foreground.serviceP95Ms).toBeGreaterThan(120);

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBeNull();
  });

  it('drops and restores desktop pipeline capacity with foreground database pressure', async () => {
    const { scheduledDb } = createScheduledTestDb();
    const scheduler = getDatabaseWorkScheduler(scheduledDb);
    if (!scheduler) {
      throw new Error('Test scheduled DB handle did not expose its scheduler.');
    }
    let releaseForegroundWork!: () => void;
    const foregroundWork = scheduler.run(
      () =>
        new Promise<void>((resolve) => {
          releaseForegroundWork = resolve;
        }),
      { label: 'test foreground query', priority: 'foreground' }
    );

    await vi.waitFor(() => {
      expect(scheduler.getSnapshot().runningPriority).toBe('foreground');
    });

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolvePipelineCapacity?.()).resolves.toMatchObject({
      maxPendingCompletionBatches: 1,
      maxPendingCompletionBytes: 3072,
      maxPendingCompletionChunks: 1,
      streamBatchSize: 1,
    });

    releaseForegroundWork();
    await foregroundWork;

    await expect(config.resolvePipelineCapacity?.()).resolves.toMatchObject({
      maxPendingCompletionBatches: 2,
      maxPendingCompletionBytes: 786_432,
      maxPendingCompletionChunks: 32,
      streamBatchSize: 8,
    });
  });

  it('shrinks desktop claims after recent high-latency normal database work', async () => {
    let now = 1000;
    const { scheduledDb } = createScheduledTestDb({
      foregroundQuietMs: 0,
      now: () => now,
    });
    const scheduler = getDatabaseWorkScheduler(scheduledDb);
    if (!scheduler) {
      throw new Error('Test scheduled DB handle did not expose its scheduler.');
    }

    await scheduler.run(
      async () => {
        now += 130;
      },
      { label: 'collection count refresh', priority: 'normal' }
    );

    expect(scheduler.getSnapshot().priorityStats.normal.serviceP95Ms).toBeGreaterThan(120);

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBe(1);
  });

  it('pauses desktop claims at the foreground quiet-window boundary', async () => {
    let now = 1000;
    const { scheduledDb } = createScheduledTestDb({
      foregroundQuietMs: 50,
      now: () => now,
    });
    const scheduler = getDatabaseWorkScheduler(scheduledDb);
    if (!scheduler) {
      throw new Error('Test scheduled DB handle did not expose its scheduler.');
    }

    await scheduler.run(async () => undefined, {
      label: 'foreground quiet boundary',
      priority: 'foreground',
    });
    now += 50;

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBeNull();
  });

  it('keeps the configured idle desktop claim batch after low-latency foreground work', async () => {
    let now = 1000;
    const { scheduledDb } = createScheduledTestDb({
      foregroundQuietMs: 0,
      now: () => now,
    });
    const scheduler = getDatabaseWorkScheduler(scheduledDb);
    if (!scheduler) {
      throw new Error('Test scheduled DB handle did not expose its scheduler.');
    }

    await scheduler.run(
      async () => {
        now += 20;
      },
      { label: 'fast foreground query', priority: 'foreground' }
    );

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBe(16);
  });

  it('uses configured env vars and forwards logs and download progress updates', () => {
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '3';
    import.meta.env['VITE_EMBED_CLAIM_BATCH_SIZE'] = '4';
    import.meta.env['VITE_EMBED_COMPLETION_OVERLAP_BATCHES'] = '3';
    import.meta.env['VITE_EMBED_INTER_BATCH_DELAY_MS'] = '75';
    import.meta.env['VITE_EMBED_LEASE_MS'] = '45000';
    import.meta.env['VITE_EMBED_MAX_PENDING_COMPLETION_BYTES'] = '123456';
    import.meta.env['VITE_EMBED_MAX_PENDING_COMPLETION_CHUNKS'] = '9';
    import.meta.env['VITE_EMBED_MODEL_KEY'] = 'local:test-model';
    import.meta.env['VITE_EMBED_STREAM_BATCH_SIZE'] = '5';
    const { scheduledDb } = createScheduledTestDb();

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    expect(config).toMatchObject({
      claimBatchSize: 4,
      concurrency: 3,
      db: scheduledDb,
      interBatchDelayMs: 75,
      leaseMs: 45_000,
      maxPendingCompletionBatches: 3,
      maxPendingCompletionBytes: 123_456,
      maxPendingCompletionChunks: 9,
      modelKey: 'local:test-model',
      streamBatchSize: 5,
      waitForBackgroundPermit: expect.any(Function),
    });

    config.log?.('Worker started');
    config.log?.('Worker progress', { batch: 1 });
    config.onDownloadProgress?.('model-a', 40);
    config.onDownloadProgress?.('model-a', 100);

    expect(loggerInfoMock).toHaveBeenNthCalledWith(1, 'Worker started');
    expect(loggerInfoMock).toHaveBeenNthCalledWith(2, 'Worker progress', { batch: 1 });
    expect(registryStoreState.setDownloadProgress).toHaveBeenNthCalledWith(1, 'model-a', 40);
    expect(registryStoreState.setDownloading).toHaveBeenNthCalledWith(1, 'model-a', true);
    expect(registryStoreState.setDownloadProgress).toHaveBeenNthCalledWith(2, 'model-a', 100);
    expect(registryStoreState.setDownloading).toHaveBeenNthCalledWith(2, 'model-a', false);
  });

  it('fails fast when embed concurrency is not a positive integer', () => {
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '0';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_CONCURRENCY must be a positive integer, received "0".'
    );
  });

  it('fails fast when embed concurrency uses non-decimal numeric syntax', () => {
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '1e3';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_CONCURRENCY must be a positive integer, received "1e3".'
    );
  });

  it('fails fast when embed claim batch size is not a positive integer', () => {
    import.meta.env['VITE_EMBED_CLAIM_BATCH_SIZE'] = '0';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_CLAIM_BATCH_SIZE must be a positive integer, received "0".'
    );
  });

  it('fails fast when embed inter-batch delay is not a positive integer', () => {
    import.meta.env['VITE_EMBED_INTER_BATCH_DELAY_MS'] = 'abc';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_INTER_BATCH_DELAY_MS must be a positive integer, received "abc".'
    );
  });

  it('fails fast when embed lease duration is not a positive integer', () => {
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '';
    import.meta.env['VITE_EMBED_LEASE_MS'] = 'abc';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_LEASE_MS must be a positive integer, received "abc".'
    );
  });

  it('fails fast when stream batch size is not a positive integer', () => {
    import.meta.env['VITE_EMBED_STREAM_BATCH_SIZE'] = '0';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_STREAM_BATCH_SIZE must be a positive integer, received "0".'
    );
  });

  it('fails fast when pending completion limits are malformed', () => {
    import.meta.env['VITE_EMBED_MAX_PENDING_COMPLETION_CHUNKS'] = 'abc';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_MAX_PENDING_COMPLETION_CHUNKS must be a positive integer, received "abc".'
    );
  });
});
