import type {
  DatabaseWorkOptions,
  DatabaseWorkPriority,
  ScheduledDatabaseMaintenanceResult,
} from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopDatabaseMaintenanceScheduler,
  type DesktopDatabaseMaintenanceSchedulerOptions,
} from '../database-maintenance-scheduler';

const COMPLETED_MAINTENANCE_RESULT: ScheduledDatabaseMaintenanceResult = {
  activeJobs: 0,
  analyzedTables: ['file_records', 'embedding_cache'],
  completedAt: '2026-05-01T12:00:00.100Z',
  durationMs: 100,
  prunedTerminalJobs: 2,
  prunedTokenEstimateCalibrationRows: 3,
  prunedToolCallTelemetryRows: 7,
  startedAt: '2026-05-01T12:00:00.000Z',
  status: 'completed',
  vacuumedTables: [
    'job_queue',
    'brainstrike_tool_call_telemetry',
    'brainstrike_token_estimate_calibration',
    'file_chunks',
  ],
};

interface SchedulerSnapshotForTest {
  readonly queued: Record<DatabaseWorkPriority, number>;
  readonly runningPriority: DatabaseWorkPriority | null;
}

function createQueuedCounts(
  overrides: Partial<Record<DatabaseWorkPriority, number>> = {}
): Record<DatabaseWorkPriority, number> {
  return {
    background: overrides.background ?? 0,
    foreground: overrides.foreground ?? 0,
    normal: overrides.normal ?? 0,
  };
}

/**
 * BST-1333: the quiet-period gate. A measured `VACUUM (ANALYZE) file_chunks`
 * ran 7.3s and, because the DB host dispatches serially and cannot preempt it,
 * every renderer query queued behind it — it had started in a momentary gap
 * between the renderer's startup query bursts, which the instantaneous
 * "is it busy right now?" check read as safe.
 */
describe('DesktopDatabaseMaintenanceScheduler quiet period (BST-1333)', () => {
  interface QuietPeriodHarness {
    readonly advance: (ms: number) => void;
    readonly reportBusy: () => void;
    readonly runMaintenance: ReturnType<typeof vi.fn>;
    readonly scheduler: ReturnType<typeof createDesktopDatabaseMaintenanceScheduler>;
  }

  function createHarness(quietPeriodMs?: number): QuietPeriodHarness {
    let nowMs = 1_000_000;
    let listener: ((snapshot: SchedulerSnapshotForTest) => void) | null = null;
    const runMaintenance = vi.fn(async () => COMPLETED_MAINTENANCE_RESULT);
    const scheduler = createDesktopDatabaseMaintenanceScheduler({
      getDatabase: vi.fn(async () => ({ query: vi.fn() })),
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts(),
        runningPriority: null,
      }),
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      now: () => new Date(nowMs),
      ...(quietPeriodMs === undefined ? {} : { quietPeriodMs }),
      runMaintenance,
      runScheduledWork: (async <TResult>(
        _options: DatabaseWorkOptions,
        work: () => Promise<TResult>
      ): Promise<TResult> =>
        await work()) as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'],
      subscribeToSchedulerSnapshots: (snapshotListener) => {
        listener = snapshotListener;
        return () => {
          listener = null;
        };
      },
    });
    return {
      advance: (ms: number) => {
        nowMs += ms;
      },
      reportBusy: () => {
        listener?.({ queued: createQueuedCounts(), runningPriority: 'foreground' });
      },
      runMaintenance,
      scheduler,
    };
  }

  it('refuses to start a pass while the scheduler has only just gone idle', async () => {
    const harness = createHarness();
    harness.scheduler.start(); // start seeds "busy": the app is booting
    harness.advance(5000);

    const result = await harness.scheduler.runOnce();

    expect(result.status).toBe('skipped');
    expect((result as { reason: string }).reason).toBe('database-scheduler-recently-busy');
    expect(harness.runMaintenance).not.toHaveBeenCalled();
    harness.scheduler.stop();
  });

  it('runs once the scheduler has been continuously idle for the quiet period', async () => {
    const harness = createHarness();
    harness.scheduler.start();
    harness.advance(20_000);

    const result = await harness.scheduler.runOnce();

    expect(result).toBe(COMPLETED_MAINTENANCE_RESULT);
    expect(harness.runMaintenance).toHaveBeenCalledTimes(1);
    harness.scheduler.stop();
  });

  it('restarts the quiet window when observed work arrives between passes', async () => {
    // The failure this pins: the instantaneous check samples only at run time,
    // so a burst that ended microseconds ago looked identical to a long lull.
    const harness = createHarness();
    harness.scheduler.start();
    harness.advance(20_000);
    harness.reportBusy(); // a renderer query burst lands via the subscription
    harness.advance(2000);

    const result = await harness.scheduler.runOnce();

    expect(result.status).toBe('skipped');
    expect((result as { reason: string }).reason).toBe('database-scheduler-recently-busy');
    expect(harness.runMaintenance).not.toHaveBeenCalled();
    harness.scheduler.stop();
  });

  it('honors quietPeriodMs: 0 for callers that opt out of the gate', async () => {
    const harness = createHarness(0);
    harness.scheduler.start();

    const result = await harness.scheduler.runOnce();

    expect(result).toBe(COMPLETED_MAINTENANCE_RESULT);
    harness.scheduler.stop();
  });

  it('rejects a negative quiet period instead of coercing it', () => {
    expect(() =>
      createDesktopDatabaseMaintenanceScheduler({
        getDatabase: vi.fn(async () => ({ query: vi.fn() })),
        getSchedulerSnapshot: () => ({
          queued: createQueuedCounts(),
          runningPriority: null,
        }),
        logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
        quietPeriodMs: -1,
        runScheduledWork: (async <TResult>(
          _options: DatabaseWorkOptions,
          work: () => Promise<TResult>
        ): Promise<TResult> =>
          await work()) as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'],
      })
    ).toThrow(/quietPeriodMs must be a non-negative number/);
  });
});

describe('DesktopDatabaseMaintenanceScheduler', () => {
  it('does not request a database handle while scheduled DB work is already busy', async () => {
    const getDatabase = vi.fn(async () => ({ query: vi.fn() }));
    const runScheduledWork = vi.fn();
    const runMaintenance = vi.fn();
    const scheduler = createDesktopDatabaseMaintenanceScheduler({
      getDatabase,
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts({ foreground: 1 }),
        runningPriority: null,
      }),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      },
      runMaintenance,
      runScheduledWork,
    });

    const result = await scheduler.runOnce();

    expect(result).toMatchObject({
      reason: 'database-scheduler-busy',
      status: 'skipped',
    });
    expect(getDatabase).not.toHaveBeenCalled();
    expect(runScheduledWork).not.toHaveBeenCalled();
    expect(runMaintenance).not.toHaveBeenCalled();
  });

  it('runs maintenance through the background database lane when the scheduler is idle', async () => {
    const db = { query: vi.fn() };
    const getDatabase = vi.fn(async () => db);
    let capturedOptions: DatabaseWorkOptions | null = null;
    const runScheduledWork = vi.fn(
      async <TResult>(
        options: DatabaseWorkOptions,
        work: () => Promise<TResult>
      ): Promise<TResult> => {
        capturedOptions = options;
        return await work();
      }
    ) as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'];
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    const runMaintenance = vi.fn(async () => COMPLETED_MAINTENANCE_RESULT);
    const scheduler = createDesktopDatabaseMaintenanceScheduler({
      getDatabase,
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts(),
        runningPriority: null,
      }),
      logger,
      runMaintenance,
      runScheduledWork,
    });

    const result = await scheduler.runOnce();

    expect(result).toBe(COMPLETED_MAINTENANCE_RESULT);
    expect(capturedOptions).toEqual({
      label: 'scheduled-db-maintenance',
      priority: 'background',
    });
    expect(runMaintenance).toHaveBeenCalledWith(db, expect.any(Object));
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        analyzedTables: ['file_records', 'embedding_cache'],
        prunedTerminalJobs: 2,
        prunedTokenEstimateCalibrationRows: 3,
        prunedToolCallTelemetryRows: 7,
        vacuumedTables: [
          'job_queue',
          'brainstrike_tool_call_telemetry',
          'brainstrike_token_estimate_calibration',
          'file_chunks',
        ],
      }),
      'Scheduled database maintenance completed'
    );
  });

  it('logs a partial maintenance pass as info, not as a skip', async () => {
    const db = { query: vi.fn() };
    const runScheduledWork = vi.fn(
      async <TResult>(
        _options: DatabaseWorkOptions,
        work: () => Promise<TResult>
      ): Promise<TResult> => await work()
    ) as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'];
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    const partialResult: ScheduledDatabaseMaintenanceResult = {
      activeJobs: 496_198,
      analyzedTables: [],
      completedAt: '2026-05-01T12:00:00.300Z',
      durationMs: 300,
      prunedTerminalJobs: 5000,
      prunedTokenEstimateCalibrationRows: 6,
      prunedToolCallTelemetryRows: 12,
      reason: 'active-job-queue',
      startedAt: '2026-05-01T12:00:00.000Z',
      status: 'partial',
      vacuumedTables: [],
    };
    const scheduler = createDesktopDatabaseMaintenanceScheduler({
      getDatabase: vi.fn(async () => db),
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts(),
        runningPriority: null,
      }),
      logger,
      runMaintenance: vi.fn(async () => partialResult),
      runScheduledWork,
    });

    const result = await scheduler.runOnce();

    expect(result).toBe(partialResult);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        activeJobs: 496_198,
        prunedTerminalJobs: 5000,
        status: 'partial',
      }),
      'Scheduled database maintenance pruned while queue active (vacuum deferred)'
    );
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.anything(),
      'Skipped scheduled database maintenance'
    );
  });

  it('prevents overlapping maintenance passes', async () => {
    let resolveMaintenance: ((result: ScheduledDatabaseMaintenanceResult) => void) | null = null;
    const runScheduledWork = vi.fn(
      async <TResult>(
        _options: DatabaseWorkOptions,
        work: () => Promise<TResult>
      ): Promise<TResult> => await work()
    ) as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'];
    const runMaintenance = vi.fn(
      async () =>
        await new Promise<ScheduledDatabaseMaintenanceResult>((resolve) => {
          resolveMaintenance = resolve;
        })
    );
    const scheduler = createDesktopDatabaseMaintenanceScheduler({
      getDatabase: vi.fn(async () => ({ query: vi.fn() })),
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts(),
        runningPriority: null,
      }),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      },
      runMaintenance,
      runScheduledWork,
    });

    const firstRun = scheduler.runOnce();
    await Promise.resolve();

    const secondRun = await scheduler.runOnce();

    expect(secondRun).toMatchObject({
      reason: 'already-running',
      status: 'skipped',
    });
    expect(runScheduledWork).toHaveBeenCalledTimes(1);

    const finishMaintenance = resolveMaintenance as
      | ((result: ScheduledDatabaseMaintenanceResult) => void)
      | null;
    if (!finishMaintenance) {
      throw new Error('Expected database maintenance to be pending.');
    }
    finishMaintenance(COMPLETED_MAINTENANCE_RESULT);
    await firstRun;
  });

  it('runs an initial pass after the configured startup delay', async () => {
    vi.useFakeTimers();
    try {
      const runScheduledWork = vi.fn(
        async <TResult>(
          _options: DatabaseWorkOptions,
          work: () => Promise<TResult>
        ): Promise<TResult> => await work()
      ) as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'];
      const scheduler = createDesktopDatabaseMaintenanceScheduler({
        getDatabase: vi.fn(async () => ({ query: vi.fn() })),
        getSchedulerSnapshot: () => ({
          queued: createQueuedCounts(),
          runningPriority: null,
        }),
        initialDelayMs: 250,
        intervalMs: 10_000,
        logger: {
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
        },
        // Timer mechanics in isolation: opt out of the BST-1333 quiet-period
        // gate, which start() would otherwise arm for 15s and which has its
        // own describe block above.
        quietPeriodMs: 0,
        runMaintenance: vi.fn(async () => COMPLETED_MAINTENANCE_RESULT),
        runScheduledWork,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(249);
      expect(runScheduledWork).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(runScheduledWork).toHaveBeenCalledTimes(1);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts recurring passes after the initial startup delay', async () => {
    vi.useFakeTimers();
    try {
      const runScheduledWork = vi.fn(
        async <TResult>(
          _options: DatabaseWorkOptions,
          work: () => Promise<TResult>
        ): Promise<TResult> => await work()
      ) as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'];
      const scheduler = createDesktopDatabaseMaintenanceScheduler({
        getDatabase: vi.fn(async () => ({ query: vi.fn() })),
        getSchedulerSnapshot: () => ({
          queued: createQueuedCounts(),
          runningPriority: null,
        }),
        initialDelayMs: 1000,
        intervalMs: 100,
        logger: {
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
        },
        // Timer mechanics in isolation — see the note on the initial-pass test.
        quietPeriodMs: 0,
        runMaintenance: vi.fn(async () => COMPLETED_MAINTENANCE_RESULT),
        runScheduledWork,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(999);
      expect(runScheduledWork).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(runScheduledWork).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(runScheduledWork).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(runScheduledWork).toHaveBeenCalledTimes(2);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
