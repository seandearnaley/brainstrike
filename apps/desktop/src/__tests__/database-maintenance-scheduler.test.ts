import type {
  DatabaseWorkOptions,
  DatabaseWorkPriority,
  ScheduledDatabaseMaintenanceResult,
} from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { isCorruptionError } from '../database-corruption-classifier';
import { createDesktopDatabaseIntegrity } from '../database-integrity-state';
import {
  createDesktopDatabaseMaintenanceScheduler,
  type DesktopDatabaseMaintenanceSchedulerOptions,
} from '../database-maintenance-scheduler';

function createHealthyIntegrity() {
  return createDesktopDatabaseIntegrity({
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  });
}

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

/** A database reporting the given in-flight assistant work (none by default). */
function databaseWithAssistantWork(inFlight = { backgroundTasks: 0, runs: 0 }) {
  // Untyped like the vi.fn() it replaces, so it fits the generic query seam.
  const query = vi.fn();
  query.mockImplementation(async (sql: string) =>
    sql.includes('brainstrike_assistant_thread_runs') ? { rows: [inFlight] } : { rows: [] }
  );
  return { query };
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
      getDatabase: vi.fn(async () => databaseWithAssistantWork()),
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts(),
        runningPriority: null,
      }),
      integrity: createHealthyIntegrity(),
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      now: () => new Date(nowMs),
      onRuntimeCorruption: vi.fn(),
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

  it('does not restart the quiet window when start is called twice', async () => {
    const harness = createHarness();
    await harness.scheduler.start();
    harness.advance(14_000);
    await harness.scheduler.start();
    harness.advance(2000);

    expect(await harness.scheduler.runOnce()).toBe(COMPLETED_MAINTENANCE_RESULT);
    harness.scheduler.stop();
    await harness.scheduler.close();
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
        getDatabase: vi.fn(async () => databaseWithAssistantWork()),
        getSchedulerSnapshot: () => ({
          queued: createQueuedCounts(),
          runningPriority: null,
        }),
        integrity: createHealthyIntegrity(),
        logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        onRuntimeCorruption: vi.fn(),
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
    const getDatabase = vi.fn(async () => databaseWithAssistantWork());
    const runScheduledWork = vi.fn();
    const runMaintenance = vi.fn();
    const scheduler = createDesktopDatabaseMaintenanceScheduler({
      getDatabase,
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts({ foreground: 1 }),
        runningPriority: null,
      }),
      integrity: createHealthyIntegrity(),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      onRuntimeCorruption: vi.fn(),
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
    const db = databaseWithAssistantWork();
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
      warn: vi.fn(),
    };
    const runMaintenance = vi.fn(async () => COMPLETED_MAINTENANCE_RESULT);
    const scheduler = createDesktopDatabaseMaintenanceScheduler({
      getDatabase,
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts(),
        runningPriority: null,
      }),
      integrity: createHealthyIntegrity(),
      logger,
      onRuntimeCorruption: vi.fn(),
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
    const db = databaseWithAssistantWork();
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
      warn: vi.fn(),
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
      integrity: createHealthyIntegrity(),
      logger,
      onRuntimeCorruption: vi.fn(),
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
      getDatabase: vi.fn(async () => databaseWithAssistantWork()),
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts(),
        runningPriority: null,
      }),
      integrity: createHealthyIntegrity(),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      onRuntimeCorruption: vi.fn(),
      quietPeriodMs: 0,
      runMaintenance,
      runScheduledWork,
    });

    await scheduler.start();
    const firstRun = scheduler.runOnce();
    let firstRunSettled = false;
    void firstRun.then(() => {
      firstRunSettled = true;
    });
    await Promise.resolve();

    const secondRun = await scheduler.runOnce();

    expect(secondRun).toMatchObject({
      reason: 'already-running',
      status: 'skipped',
    });
    expect(runScheduledWork).toHaveBeenCalledTimes(1);
    // The pass reads in-flight assistant work inside the lane before it runs.
    await vi.waitFor(() => expect(runMaintenance).toHaveBeenCalledTimes(1));

    const finishMaintenance = resolveMaintenance as
      | ((result: ScheduledDatabaseMaintenanceResult) => void)
      | null;
    if (!finishMaintenance) {
      throw new Error('Expected database maintenance to be pending.');
    }
    scheduler.stop();
    await scheduler.close();
    expect(firstRunSettled).toBe(false);
    finishMaintenance(COMPLETED_MAINTENANCE_RESULT);
    await firstRun;
    expect(firstRunSettled).toBe(true);
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
        getDatabase: vi.fn(async () => databaseWithAssistantWork()),
        getSchedulerSnapshot: () => ({
          queued: createQueuedCounts(),
          runningPriority: null,
        }),
        initialDelayMs: 250,
        integrity: createHealthyIntegrity(),
        intervalMs: 10_000,
        logger: {
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        },
        onRuntimeCorruption: vi.fn(),
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
      const firstFailure = new Error('temporary maintenance failure');
      const error = vi.fn();
      const runMaintenance = vi
        .fn(async () => COMPLETED_MAINTENANCE_RESULT)
        .mockRejectedValueOnce(firstFailure);
      const runScheduledWork = vi.fn(
        async <TResult>(
          _options: DatabaseWorkOptions,
          work: () => Promise<TResult>
        ): Promise<TResult> => await work()
      ) as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'];
      const scheduler = createDesktopDatabaseMaintenanceScheduler({
        getDatabase: vi.fn(async () => databaseWithAssistantWork()),
        getSchedulerSnapshot: () => ({
          queued: createQueuedCounts(),
          runningPriority: null,
        }),
        initialDelayMs: 1000,
        integrity: createHealthyIntegrity(),
        intervalMs: 100,
        logger: {
          debug: vi.fn(),
          error,
          info: vi.fn(),
          warn: vi.fn(),
        },
        onRuntimeCorruption: vi.fn(),
        // Timer mechanics in isolation — see the note on the initial-pass test.
        quietPeriodMs: 0,
        runMaintenance,
        runScheduledWork,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(999);
      expect(runScheduledWork).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(runScheduledWork).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledExactlyOnceWith(
        { error: firstFailure },
        'Scheduled database maintenance failed'
      );

      await vi.advanceTimersByTimeAsync(99);
      expect(runScheduledWork).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(runScheduledWork).toHaveBeenCalledTimes(2);
      expect(runMaintenance).toHaveBeenCalledTimes(2);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Corruption found by a maintenance pass takes the same runtime recovery path
 * as corruption found by `db:query`. Measured case (2026-09-15): a pass failed
 * with XX001, was logged as "Scheduled database maintenance failed", and the
 * app kept serving that database for about nine hours until an embedding
 * backfill `db:query` hit XX001 and finally replaced it.
 */
describe('DesktopDatabaseMaintenanceScheduler corruption recovery', () => {
  interface CorruptionHarness {
    readonly events: string[];
    readonly logger: {
      readonly debug: ReturnType<typeof vi.fn>;
      readonly error: ReturnType<typeof vi.fn>;
      readonly info: ReturnType<typeof vi.fn>;
      readonly warn: ReturnType<typeof vi.fn>;
    };
    readonly onRuntimeCorruption: ReturnType<typeof vi.fn>;
    readonly scheduler: ReturnType<typeof createDesktopDatabaseMaintenanceScheduler>;
  }

  // DbHostManager.toError rebuilds a DB host failure as a plain Error carrying
  // the SQLSTATE on `code`: the exact shape a maintenance pass sees in main.
  function createDbHostError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
  }

  function createHarness(maintenanceError: Error): CorruptionHarness {
    const events: string[] = [];
    const onRuntimeCorruption = vi.fn(async (context: string) => {
      events.push(`recover:${context}`);
    });
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const scheduler = createDesktopDatabaseMaintenanceScheduler({
      getDatabase: vi.fn(async () => databaseWithAssistantWork()),
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts(),
        runningPriority: null,
      }),
      initialDelayMs: 0,
      integrity: createHealthyIntegrity(),
      logger,
      onRuntimeCorruption,
      quietPeriodMs: 0,
      runMaintenance: vi.fn(async () => {
        throw maintenanceError;
      }),
      runScheduledWork: (async <TResult>(
        _options: DatabaseWorkOptions,
        work: () => Promise<TResult>
      ): Promise<TResult> => {
        events.push('lane:enter');
        try {
          return await work();
        } finally {
          events.push('lane:exit');
        }
      }) as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'],
    });
    return { events, logger, onRuntimeCorruption, scheduler };
  }

  it('replaces the database when a pass fails with a corruption-class error', async () => {
    const corruption = createDbHostError(
      'pg_textsearch memtable marking dead chain page out',
      'XX001'
    );
    // The fixture must be corruption by the query path's own rule, not a stub.
    expect(isCorruptionError(corruption)).toBe(true);
    const harness = createHarness(corruption);

    await expect(harness.scheduler.runOnce()).rejects.toMatchObject({
      name: 'DatabaseCorruptionRecoveredError',
    });

    expect(harness.onRuntimeCorruption).toHaveBeenCalledExactlyOnceWith('maintenance');
    expect(harness.logger.warn).toHaveBeenCalledExactlyOnceWith(
      { context: 'maintenance', error: corruption },
      'Corruption detected in maintenance; replacing the database without retrying.'
    );
  });

  it('recovers inside the maintenance work lane, before the lane is released', async () => {
    // db:query recovers inside its scheduler operation so the recovery epoch
    // bump lands while the failing operation still owns the serial lane.
    // Recovering after the lane unwinds would let queued work reach the
    // corrupt database first.
    const harness = createHarness(createDbHostError('invalid page index at block 398', 'XX001'));

    await expect(harness.scheduler.runOnce()).rejects.toThrow();

    expect(harness.events).toEqual(['lane:enter', 'recover:maintenance', 'lane:exit']);
  });

  it('recovers on the timer path main.ts uses, then logs the recovered pass as failed', async () => {
    // main.ts only calls start(), so production recovery runs on the timer
    // path. The pass is still logged at error level: it did not complete, and
    // the logged error names the recovery instead of the raw corruption.
    const corruption = createDbHostError('invalid page index at block 398', 'XX001');
    const harness = createHarness(corruption);

    harness.scheduler.start();
    try {
      await vi.waitFor(() => {
        expect(harness.logger.error).toHaveBeenCalledExactlyOnceWith(
          { error: expect.objectContaining({ name: 'DatabaseCorruptionRecoveredError' }) },
          'Scheduled database maintenance failed'
        );
      });
    } finally {
      harness.scheduler.stop();
    }

    expect(harness.onRuntimeCorruption).toHaveBeenCalledExactlyOnceWith('maintenance');
    expect(harness.logger.warn).toHaveBeenCalledExactlyOnceWith(
      { context: 'maintenance', error: corruption },
      'Corruption detected in maintenance; replacing the database without retrying.'
    );
  });

  it('keeps a non-corruption failure log-only: same error, same log, no recovery', async () => {
    const failure = createDbHostError('canceling statement due to statement timeout', '57014');
    expect(isCorruptionError(failure)).toBe(false);
    const harness = createHarness(failure);

    harness.scheduler.start();
    try {
      await vi.waitFor(() => {
        expect(harness.logger.error).toHaveBeenCalledExactlyOnceWith(
          { error: failure },
          'Scheduled database maintenance failed'
        );
      });
    } finally {
      harness.scheduler.stop();
    }

    expect(harness.onRuntimeCorruption).not.toHaveBeenCalled();
    expect(harness.logger.warn).not.toHaveBeenCalled();
  });
});

/**
 * Live GLM run 22 (2026-09-15): an unpreemptable maintenance statement that
 * starts while assistant work is in flight blocks every run-scoped query behind
 * it. A run waiting on its model issues no database work for many seconds, so
 * sustained quiet alone cannot see it; the durable run and task rows can.
 */
describe('DesktopDatabaseMaintenanceScheduler assistant work admission', () => {
  it.for([
    { backgroundTasks: 0, runs: 1 },
    { backgroundTasks: 1, runs: 0 },
  ])('refuses to start a pass while assistant work is in flight (%o)', async (inFlight) => {
    const runMaintenance = vi.fn(async () => COMPLETED_MAINTENANCE_RESULT);
    const scheduler = createDesktopDatabaseMaintenanceScheduler({
      getDatabase: vi.fn(async () => databaseWithAssistantWork(inFlight)),
      getSchedulerSnapshot: () => ({ queued: createQueuedCounts(), runningPriority: null }),
      integrity: createHealthyIntegrity(),
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      onRuntimeCorruption: vi.fn(),
      quietPeriodMs: 0,
      runMaintenance,
      runScheduledWork: (async <TResult>(
        _options: DatabaseWorkOptions,
        work: () => Promise<TResult>
      ): Promise<TResult> =>
        await work()) as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'],
    });

    const result = await scheduler.runOnce();

    expect(result.status).toBe('skipped');
    expect((result as { reason: string }).reason).toBe('assistant-work-in-flight');
    expect(runMaintenance).not.toHaveBeenCalled();
  });
});

/**
 * BST-1870: while an integrity error is contained, background database work is
 * paused. The pass skips quietly before it touches the lane or the database.
 */
describe('DesktopDatabaseMaintenanceScheduler integrity containment', () => {
  function createContainedHarness() {
    const integrity = createHealthyIntegrity();
    integrity.contain('db:query', { message: 'invalid page in block 3', sqlstate: 'XX001' });
    const getDatabase = vi.fn(async () => databaseWithAssistantWork());
    const runMaintenance = vi.fn(async () => COMPLETED_MAINTENANCE_RESULT);
    const runScheduledWork = vi.fn(
      async <TResult>(_options: DatabaseWorkOptions, work: () => Promise<TResult>) => await work()
    );
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const scheduler = createDesktopDatabaseMaintenanceScheduler({
      getDatabase,
      getSchedulerSnapshot: () => ({ queued: createQueuedCounts(), runningPriority: null }),
      integrity,
      logger,
      onRuntimeCorruption: vi.fn(),
      quietPeriodMs: 0,
      runMaintenance,
      runScheduledWork:
        runScheduledWork as unknown as DesktopDatabaseMaintenanceSchedulerOptions['runScheduledWork'],
    });
    return { getDatabase, integrity, logger, runMaintenance, runScheduledWork, scheduler };
  }

  it('skips with database-integrity-contained and never enters the lane or opens the database', async () => {
    const harness = createContainedHarness();

    const result = await harness.scheduler.runOnce();

    expect(result).toMatchObject({ reason: 'database-integrity-contained', status: 'skipped' });
    expect(harness.runScheduledWork).not.toHaveBeenCalled();
    expect(harness.getDatabase).not.toHaveBeenCalled();
    expect(harness.runMaintenance).not.toHaveBeenCalled();
    expect(harness.logger.info).toHaveBeenCalledExactlyOnceWith(
      { integrityState: 'contained', revision: 1 },
      'Skipped scheduled database maintenance because database integrity containment is active'
    );
  });

  it('runs again once the database has been replaced', async () => {
    const harness = createContainedHarness();
    harness.integrity.markDatabaseReplaced('factory-reset');

    const result = await harness.scheduler.runOnce();

    expect(result).toBe(COMPLETED_MAINTENANCE_RESULT);
    expect(harness.runMaintenance).toHaveBeenCalledTimes(1);
  });
});
