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
    resolveWorkspaceIndexingQosPolicyMock: vi.fn(),
    registryStoreState: {
      setDownloadProgress: vi.fn(),
      setDownloading: vi.fn(),
    },
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
    const constrained = inputs.powerSource === 'battery' || inputs.thermalState === 'serious';
    return {
      allowNewWork: !foregroundYielding,
      allowPowerSaveBlocker: false,
      backfillQueueDepth: 0,
      contentReadBatchSize: foregroundYielding ? 0 : 24,
      contentReadConcurrency: foregroundYielding ? 0 : 1,
      importBatchSize: foregroundYielding ? 0 : 24,
      interBatchDelayMs: foregroundYielding ? 250 : 75,
      progressThrottleMs: 500,
      reason: foregroundYielding
        ? 'foreground-db-pressure'
        : interactive
          ? 'normal-db-pressure'
          : constrained
            ? inputs.powerSource === 'battery'
              ? 'battery'
              : 'thermal-serious'
            : 'balanced',
      scanBatchSize: foregroundYielding ? 0 : 48,
      state: foregroundYielding
        ? 'foreground-yielding'
        : interactive
          ? 'interactive'
          : constrained
            ? 'system-constrained'
            : 'balanced',
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
    import.meta.env['VITE_EMBED_MODEL_KEY'] = '';
  });

  it('uses strict defaults when optional env vars are not configured', () => {
    const { db, scheduledDb } = createScheduledTestDb();

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    expect(config).toMatchObject({
      db: scheduledDb,
      claimBatchSize: 16,
      concurrency: 1,
      interBatchDelayMs: 75,
      leaseMs: 60_000,
      log: expect.any(Function),
      onDownloadProgress: expect.any(Function),
      resolveClaimBatchSize: expect.any(Function),
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
        powerSource: 'unknown',
        providerRateLimited: false,
        thermalState: 'unknown',
        windowVisible: false,
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

    const config = createEmbeddingWorkerConfig({ query: vi.fn() } as never);

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

      const config = createEmbeddingWorkerConfig({ query: vi.fn() } as never);

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

    const config = createEmbeddingWorkerConfig({ query: vi.fn() } as never);
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
      { priority: 'foreground', label: 'test foreground query' }
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
      { priority: 'foreground', label: 'slow foreground query' }
    );

    expect(scheduler.getSnapshot().priorityStats.foreground.serviceP95Ms).toBeGreaterThan(120);

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBeNull();
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
      { priority: 'normal', label: 'collection count refresh' }
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
      priority: 'foreground',
      label: 'foreground quiet boundary',
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
      { priority: 'foreground', label: 'fast foreground query' }
    );

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    await expect(config.resolveClaimBatchSize?.()).resolves.toBe(16);
  });

  it('uses configured env vars and forwards logs and download progress updates', () => {
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '3';
    import.meta.env['VITE_EMBED_CLAIM_BATCH_SIZE'] = '4';
    import.meta.env['VITE_EMBED_INTER_BATCH_DELAY_MS'] = '75';
    import.meta.env['VITE_EMBED_LEASE_MS'] = '45000';
    import.meta.env['VITE_EMBED_MODEL_KEY'] = 'local:test-model';
    const { scheduledDb } = createScheduledTestDb();

    const config = createEmbeddingWorkerConfig(scheduledDb as never);

    expect(config).toMatchObject({
      db: scheduledDb,
      claimBatchSize: 4,
      concurrency: 3,
      interBatchDelayMs: 75,
      leaseMs: 45_000,
      modelKey: 'local:test-model',
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
      'VITE_EMBED_CONCURRENCY must be a positive integer when configured.'
    );
  });

  it('fails fast when embed claim batch size is not a positive integer', () => {
    import.meta.env['VITE_EMBED_CLAIM_BATCH_SIZE'] = '0';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_CLAIM_BATCH_SIZE must be a positive integer when configured.'
    );
  });

  it('fails fast when embed inter-batch delay is not a positive integer', () => {
    import.meta.env['VITE_EMBED_INTER_BATCH_DELAY_MS'] = 'abc';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_INTER_BATCH_DELAY_MS must be a positive integer when configured.'
    );
  });

  it('fails fast when embed lease duration is not a positive integer', () => {
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '';
    import.meta.env['VITE_EMBED_LEASE_MS'] = 'abc';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_LEASE_MS must be a positive integer when configured.'
    );
  });
});
