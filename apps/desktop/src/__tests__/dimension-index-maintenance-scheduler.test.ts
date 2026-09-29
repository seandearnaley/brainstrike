import {
  type DatabaseWorkPriority,
  type DatabaseWorkRunOptions,
  type RunDimensionIndexMaintenanceResult,
  resolveIndexBuildMaintenanceWorkMemMb,
} from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopDatabaseIntegrity } from '../database-integrity-state';
import {
  createDesktopDimensionIndexMaintenanceScheduler,
  type DesktopDimensionIndexMaintenanceSchedulerOptions,
} from '../dimension-index-maintenance-scheduler';

function createHealthyIntegrity() {
  return createDesktopDatabaseIntegrity({
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  });
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

function idleAcSnapshot() {
  return {
    idleState: 'idle' as const,
    idleTimeMs: 180_000,
    powerSource: 'ac' as const,
    sampledAt: Date.parse('2026-06-18T14:00:00.000Z'),
    thermalState: 'nominal' as const,
  };
}

function idleSchedulerSnapshot() {
  return {
    queued: createQueuedCounts(),
    runningPriority: null,
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

/** These cases never call start(), so no scheduler history is ever observed. */
const ignoreSchedulerSnapshots = () => () => undefined;

/** A database with no assistant run or background task in flight. */
function idleAssistantQuery() {
  // Untyped like the vi.fn() it replaces, so it fits the generic query seam.
  const query = vi.fn();
  query.mockImplementation(async (sql: string) =>
    sql.includes('brainstrike_assistant_thread_runs')
      ? { rows: [{ backgroundTasks: 0, runs: 0 }] }
      : { rows: [] }
  );
  return query;
}

describe('DesktopDimensionIndexMaintenanceScheduler', () => {
  it('skips when DB scheduler is busy', async () => {
    const runScheduledWork = vi.fn();
    const runDimensionMaintenance = vi.fn();
    const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
      getDatabase: vi.fn(async () => ({ query: vi.fn() })),
      getDimensionIndexStrategy: () => 'regular',
      getPowerSnapshot: idleAcSnapshot,
      getSchedulerSnapshot: () => ({
        queued: createQueuedCounts({ foreground: 1 }),
        runningPriority: null,
      }),
      integrity: createHealthyIntegrity(),
      logger: createLogger(),
      runDimensionMaintenance,
      runScheduledWork,
      subscribeToSchedulerSnapshots: ignoreSchedulerSnapshots,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      reason: 'database-scheduler-busy',
      status: 'skipped',
    });
    expect(runScheduledWork).not.toHaveBeenCalled();
    expect(runDimensionMaintenance).not.toHaveBeenCalled();
  });

  it('skips when the machine is not idle on AC', async () => {
    const runScheduledWork = vi.fn();
    const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
      getDatabase: vi.fn(async () => ({ query: vi.fn() })),
      getDimensionIndexStrategy: () => 'regular',
      getPowerSnapshot: () => ({
        ...idleAcSnapshot(),
        idleState: 'active',
        idleTimeMs: 1000,
      }),
      getSchedulerSnapshot: idleSchedulerSnapshot,
      integrity: createHealthyIntegrity(),
      logger: createLogger(),
      runDimensionMaintenance: vi.fn(),
      runScheduledWork,
      subscribeToSchedulerSnapshots: ignoreSchedulerSnapshots,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      reason: 'power-not-idle',
      status: 'skipped',
    });
    expect(runScheduledWork).not.toHaveBeenCalled();
  });

  it('skips when the startup capability probe has not produced a strategy', async () => {
    const runScheduledWork = vi.fn();
    const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
      getDatabase: vi.fn(async () => ({ query: vi.fn() })),
      getDimensionIndexStrategy: () => null,
      getPowerSnapshot: idleAcSnapshot,
      getSchedulerSnapshot: idleSchedulerSnapshot,
      integrity: createHealthyIntegrity(),
      logger: createLogger(),
      runDimensionMaintenance: vi.fn(),
      runScheduledWork,
      subscribeToSchedulerSnapshots: ignoreSchedulerSnapshots,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      reason: 'strategy-unavailable',
      status: 'skipped',
    });
    expect(runScheduledWork).not.toHaveBeenCalled();
  });

  it('runs one maintenance unit through the background DB lane using maintenance exec', async () => {
    let capturedOptions: DatabaseWorkRunOptions | null = null;
    const maintenanceExec = vi.fn(async (_sql: string, _params?: readonly unknown[]) => undefined);
    const runScheduledWork = vi.fn(
      async <TResult>(
        options: DatabaseWorkRunOptions,
        work: () => Promise<TResult>
      ): Promise<TResult> => {
        capturedOptions = options;
        return await work();
      }
    ) as unknown as DesktopDimensionIndexMaintenanceSchedulerOptions['runScheduledWork'];
    const runDimensionMaintenance = vi.fn(async (_db, options) => {
      expect(options.strategy).toBe('regular');
      await options.createIndex({ dimension: 384, strategy: 'regular' });
      return {
        dimension: 384,
        durationMs: 123,
        status: 'completed',
        strategy: 'regular',
      } satisfies RunDimensionIndexMaintenanceResult;
    });

    const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
      getDatabase: vi.fn(async () => ({
        maintenance: { exec: maintenanceExec },
        query: idleAssistantQuery(),
      })),
      getDimensionIndexStrategy: () => 'regular',
      getPowerSnapshot: idleAcSnapshot,
      getSchedulerSnapshot: idleSchedulerSnapshot,
      integrity: createHealthyIntegrity(),
      logger: createLogger(),
      runDimensionMaintenance,
      runScheduledWork,
      subscribeToSchedulerSnapshots: ignoreSchedulerSnapshots,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      dimension: 384,
      status: 'completed',
    });
    expect(capturedOptions).toEqual({
      label: 'dimension-index-maintenance',
      priority: 'background',
    });
    expect(maintenanceExec).toHaveBeenCalledWith(expect.stringContaining('CREATE INDEX'), []);
    for (const call of maintenanceExec.mock.calls) {
      expect(call[0]).not.toContain('CONCURRENTLY');
    }
  });

  it('rejects a claimed concurrent request instead of emitting CONCURRENTLY', async () => {
    const maintenanceExec = vi.fn(async () => undefined);
    const runDimensionMaintenance = vi.fn(async (_db, options) => {
      await options.createIndex({ dimension: 384, strategy: 'concurrent' });
      return {
        dimension: 384,
        durationMs: 123,
        status: 'completed',
        strategy: 'concurrent',
      } satisfies RunDimensionIndexMaintenanceResult;
    });

    const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
      getDatabase: vi.fn(async () => ({
        maintenance: { exec: maintenanceExec },
        query: idleAssistantQuery(),
      })),
      getDimensionIndexStrategy: () => 'regular',
      getPowerSnapshot: idleAcSnapshot,
      getSchedulerSnapshot: idleSchedulerSnapshot,
      integrity: createHealthyIntegrity(),
      logger: createLogger(),
      runDimensionMaintenance,
      runScheduledWork: vi.fn(async (_options, work) => await work()),
      subscribeToSchedulerSnapshots: ignoreSchedulerSnapshots,
    });

    await expect(scheduler.runOnce()).rejects.toThrow(
      'Dimension index maintenance no longer supports the concurrent strategy.'
    );
    expect(maintenanceExec).not.toHaveBeenCalled();
  });

  describe('maintenance_work_mem tuning', () => {
    const EMBEDDED_ROW_COUNT_SQL_FRAGMENT = 'COUNT(*)';

    function createCountingQuery(count: string) {
      return vi.fn(async (sql: string) => {
        if (sql.includes('brainstrike_assistant_thread_runs')) {
          return { rows: [{ backgroundTasks: 0, runs: 0 }] };
        }
        if (sql.includes(EMBEDDED_ROW_COUNT_SQL_FRAGMENT) && sql.includes('file_chunks')) {
          return { rows: [{ count }] };
        }
        return { rows: [] };
      });
    }

    function createSchedulerWithDb(options: {
      maintenanceExec: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
      runDimensionMaintenance: ReturnType<typeof vi.fn>;
    }) {
      return createDesktopDimensionIndexMaintenanceScheduler({
        getDatabase: vi.fn(async () => ({
          maintenance: { exec: options.maintenanceExec },
          query: options.query,
        })) as unknown as DesktopDimensionIndexMaintenanceSchedulerOptions['getDatabase'],
        getDimensionIndexStrategy: () => 'regular' as const,
        getPowerSnapshot: idleAcSnapshot,
        getSchedulerSnapshot: idleSchedulerSnapshot,
        integrity: createHealthyIntegrity(),
        logger: createLogger(),
        runDimensionMaintenance:
          options.runDimensionMaintenance as unknown as DesktopDimensionIndexMaintenanceSchedulerOptions['runDimensionMaintenance'],
        runScheduledWork: vi.fn(
          async (_options, work) => await work()
        ) as unknown as DesktopDimensionIndexMaintenanceSchedulerOptions['runScheduledWork'],
        subscribeToSchedulerSnapshots: ignoreSchedulerSnapshots,
      });
    }

    it('sets sized maintenance_work_mem before CREATE INDEX and resets after, all on the maintenance channel', async () => {
      const maintenanceExec = vi.fn(
        async (_sql: string, _params?: readonly unknown[]) => undefined
      );
      const query = createCountingQuery('100000');
      const runDimensionMaintenance = vi.fn(async (_db, options) => {
        await options.createIndex({ dimension: 1024, strategy: 'regular' });
        return {
          dimension: 1024,
          durationMs: 1,
          status: 'completed',
          strategy: 'regular',
        } satisfies RunDimensionIndexMaintenanceResult;
      });
      const scheduler = createSchedulerWithDb({ maintenanceExec, query, runDimensionMaintenance });

      await expect(scheduler.runOnce()).resolves.toMatchObject({ status: 'completed' });

      const expectedMb = resolveIndexBuildMaintenanceWorkMemMb(100_000, 1024);
      const statements = maintenanceExec.mock.calls.map((call) => String(call[0]));
      const setIndex = statements.findIndex((sql) =>
        sql.includes(`SET maintenance_work_mem = '${expectedMb}MB'`)
      );
      const createIndex = statements.findIndex((sql) => sql.includes('CREATE INDEX'));
      const resetIndex = statements.findIndex((sql) => sql.includes('RESET maintenance_work_mem'));
      expect(setIndex).toBeGreaterThanOrEqual(0);
      expect(createIndex).toBeGreaterThan(setIndex);
      expect(resetIndex).toBeGreaterThan(createIndex);
    });

    it('resets maintenance_work_mem on the maintenance channel even when the build throws', async () => {
      const buildError = new Error('hnsw build exploded');
      const maintenanceExec = vi.fn(async (sql: string) => {
        if (sql.includes('CREATE INDEX')) {
          throw buildError;
        }
        return;
      });
      const query = createCountingQuery('100000');
      const runDimensionMaintenance = vi.fn(async (_db, options) => {
        await expect(options.createIndex({ dimension: 1024, strategy: 'regular' })).rejects.toThrow(
          'hnsw build exploded'
        );
        return {
          dimension: 1024,
          error: buildError.message,
          status: 'failed',
          strategy: 'regular',
        } satisfies RunDimensionIndexMaintenanceResult;
      });
      const scheduler = createSchedulerWithDb({ maintenanceExec, query, runDimensionMaintenance });

      await expect(scheduler.runOnce()).resolves.toMatchObject({ status: 'failed' });

      const statements = maintenanceExec.mock.calls.map((call) => String(call[0]));
      const createIndex = statements.findIndex((sql) => sql.includes('CREATE INDEX'));
      const resetIndex = statements.findIndex((sql) => sql.includes('RESET maintenance_work_mem'));
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(resetIndex).toBeGreaterThan(createIndex);
    });

    it('surfaces a RESET failure after a successful build instead of recording a healthy rebuild', async () => {
      // maintenance_work_mem is session-global on PGlite's single connection:
      // a swallowed RESET failure would leave the raised limit applied to every
      // subsequent query while the scheduler logs a completed rebuild.
      const maintenanceExec = vi.fn(async (sql: string) => {
        if (sql.includes('RESET maintenance_work_mem')) {
          throw new Error('simulated reset failure');
        }
        return;
      });
      const query = createCountingQuery('100000');
      const runDimensionMaintenance = vi.fn(async (_db, options) => {
        await expect(options.createIndex({ dimension: 1024, strategy: 'regular' })).rejects.toThrow(
          /reset maintenance_work_mem/i
        );
        return {
          dimension: 1024,
          error: 'reset failed',
          status: 'failed',
          strategy: 'regular',
        } satisfies RunDimensionIndexMaintenanceResult;
      });
      const scheduler = createSchedulerWithDb({ maintenanceExec, query, runDimensionMaintenance });

      await expect(scheduler.runOnce()).resolves.toMatchObject({ status: 'failed' });
      expect(runDimensionMaintenance).toHaveBeenCalledTimes(1);
    });

    it('propagates the build error (not the reset error) when both the build and the RESET fail', async () => {
      const maintenanceExec = vi.fn(async (sql: string) => {
        if (sql.includes('CREATE INDEX')) {
          throw new Error('hnsw build exploded');
        }
        if (sql.includes('RESET maintenance_work_mem')) {
          throw new Error('simulated reset failure');
        }
        return;
      });
      const query = createCountingQuery('100000');
      const runDimensionMaintenance = vi.fn(async (_db, options) => {
        await expect(options.createIndex({ dimension: 1024, strategy: 'regular' })).rejects.toThrow(
          'hnsw build exploded'
        );
        return {
          dimension: 1024,
          error: 'hnsw build exploded',
          status: 'failed',
          strategy: 'regular',
        } satisfies RunDimensionIndexMaintenanceResult;
      });
      const scheduler = createSchedulerWithDb({ maintenanceExec, query, runDimensionMaintenance });

      await expect(scheduler.runOnce()).resolves.toMatchObject({ status: 'failed' });
      expect(runDimensionMaintenance).toHaveBeenCalledTimes(1);
    });

    it('skips the SET/RESET pair when the estimated build fits the default maintenance_work_mem', async () => {
      const maintenanceExec = vi.fn(
        async (_sql: string, _params?: readonly unknown[]) => undefined
      );
      const query = createCountingQuery('10');
      const runDimensionMaintenance = vi.fn(async (_db, options) => {
        await options.createIndex({ dimension: 384, strategy: 'regular' });
        return {
          dimension: 384,
          durationMs: 1,
          status: 'completed',
          strategy: 'regular',
        } satisfies RunDimensionIndexMaintenanceResult;
      });
      const scheduler = createSchedulerWithDb({ maintenanceExec, query, runDimensionMaintenance });

      await expect(scheduler.runOnce()).resolves.toMatchObject({ status: 'completed' });

      const statements = maintenanceExec.mock.calls.map((call) => String(call[0]));
      expect(statements.some((sql) => sql.includes('maintenance_work_mem'))).toBe(false);
      expect(statements.some((sql) => sql.includes('CREATE INDEX'))).toBe(true);
    });
  });
});

interface SchedulerSnapshotForTest {
  readonly queued: Record<DatabaseWorkPriority, number>;
  readonly runningPriority: DatabaseWorkPriority | null;
}

/**
 * Live GLM run 22 (2026-09-15): the app came up at 18:52:38 and this
 * scheduler's 45 s first tick found the work scheduler idle for one instant
 * while a four-child fan-out streamed from the model. It started an 82 s HNSW
 * build the DB host cannot preempt, every run-scoped query behind it hit the
 * 30 s host timeout, and two children failed. Idle right now is not idle
 * (BST-1333), and a run waiting on its model is not idle either.
 */
describe('DesktopDimensionIndexMaintenanceScheduler admission', () => {
  function createHarness(inFlight = { backgroundTasks: 0, runs: 0 }) {
    let nowMs = 1_000_000;
    let listener: ((snapshot: SchedulerSnapshotForTest) => void) | null = null;
    const query = vi.fn();
    query.mockImplementation(async (sql: string) =>
      sql.includes('brainstrike_assistant_thread_runs') ? { rows: [inFlight] } : { rows: [] }
    );
    const runDimensionMaintenance = vi.fn(
      async () =>
        ({
          dimension: 384,
          durationMs: 1,
          status: 'completed',
          strategy: 'regular',
        }) satisfies RunDimensionIndexMaintenanceResult
    );
    const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
      getDatabase: vi.fn(async () => ({ maintenance: { exec: vi.fn() }, query })),
      getDimensionIndexStrategy: () => 'regular',
      getPowerSnapshot: idleAcSnapshot,
      getSchedulerSnapshot: idleSchedulerSnapshot,
      integrity: createHealthyIntegrity(),
      logger: createLogger(),
      now: () => new Date(nowMs),
      runDimensionMaintenance,
      runScheduledWork: (async <TResult>(
        _options: DatabaseWorkRunOptions,
        work: () => Promise<TResult>
      ): Promise<TResult> =>
        await work()) as unknown as DesktopDimensionIndexMaintenanceSchedulerOptions['runScheduledWork'],
      subscribeToSchedulerSnapshots: (next) => {
        listener = next;
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
      runDimensionMaintenance,
      scheduler,
    };
  }

  it('refuses to start a build while the database scheduler has only just gone idle', async () => {
    const harness = createHarness();
    harness.scheduler.start(); // start seeds "busy": the app is booting
    harness.advance(5000);

    await expect(harness.scheduler.runOnce()).resolves.toMatchObject({
      reason: 'database-scheduler-recently-busy',
      status: 'skipped',
    });
    expect(harness.runDimensionMaintenance).not.toHaveBeenCalled();
    harness.scheduler.stop();
  });

  it('restarts the quiet window when observed database work arrives', async () => {
    const harness = createHarness();
    harness.scheduler.start();
    harness.advance(20_000);
    harness.reportBusy();
    harness.advance(2000);

    await expect(harness.scheduler.runOnce()).resolves.toMatchObject({
      reason: 'database-scheduler-recently-busy',
      status: 'skipped',
    });
    expect(harness.runDimensionMaintenance).not.toHaveBeenCalled();
    harness.scheduler.stop();
  });

  it('keeps the original quiet window when start is called again', async () => {
    const harness = createHarness();
    await harness.scheduler.start();
    harness.advance(14_000);
    await harness.scheduler.start();
    harness.advance(2000);

    await expect(harness.scheduler.runOnce()).resolves.toMatchObject({ status: 'completed' });
    harness.scheduler.stop();
    await harness.scheduler.close();
  });

  it.for([
    { backgroundTasks: 0, runs: 1 },
    { backgroundTasks: 2, runs: 0 },
  ])('refuses to start a build while assistant work is in flight (%o)', async (inFlight) => {
    const harness = createHarness(inFlight);
    harness.scheduler.start();
    harness.advance(20_000);

    await expect(harness.scheduler.runOnce()).resolves.toMatchObject({
      reason: 'assistant-work-in-flight',
      status: 'skipped',
    });
    expect(harness.runDimensionMaintenance).not.toHaveBeenCalled();
    harness.scheduler.stop();
  });

  it('builds once the scheduler has been quiet and no assistant work is in flight', async () => {
    const harness = createHarness();
    harness.scheduler.start();
    harness.advance(20_000);

    await expect(harness.scheduler.runOnce()).resolves.toMatchObject({ status: 'completed' });
    expect(harness.runDimensionMaintenance).toHaveBeenCalledTimes(1);
    harness.scheduler.stop();
  });

  // Infinity is rejected by the same `!Number.isFinite` arm as NaN: a quiet
  // window that never elapses would park the build forever, not run it early.
  it.for([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a %s quiet period instead of coercing it',
    (quietPeriodMs) => {
      expect(() =>
        createDesktopDimensionIndexMaintenanceScheduler({
          getDatabase: vi.fn(async () => ({ query: vi.fn() })),
          getDimensionIndexStrategy: () => 'regular',
          getPowerSnapshot: idleAcSnapshot,
          getSchedulerSnapshot: idleSchedulerSnapshot,
          integrity: createHealthyIntegrity(),
          logger: createLogger(),
          quietPeriodMs,
          runScheduledWork: vi.fn(),
          subscribeToSchedulerSnapshots: ignoreSchedulerSnapshots,
        })
      ).toThrow(/quietPeriodMs must be a non-negative number/);
    }
  );
});

/**
 * BST-1870: while an integrity error is contained, background database work is
 * paused. The pass skips quietly before it reads anything or enters the lane.
 */
describe('DesktopDimensionIndexMaintenanceScheduler integrity containment', () => {
  function createContainedHarness() {
    const integrity = createHealthyIntegrity();
    integrity.contain('db:query', { message: 'invalid page in block 3', sqlstate: 'XX002' });
    const getDatabase = vi.fn(async () => ({ query: idleAssistantQuery() }));
    const getSchedulerSnapshot = vi.fn(idleSchedulerSnapshot);
    const runDimensionMaintenance = vi.fn(async () => ({
      dimension: 384,
      durationMs: 1,
      status: 'completed' as const,
      strategy: 'regular' as const,
    }));
    const runScheduledWork = vi.fn(
      async <TResult>(_options: DatabaseWorkRunOptions, work: () => Promise<TResult>) =>
        await work()
    );
    const logger = createLogger();
    const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
      getDatabase,
      getDimensionIndexStrategy: () => 'regular',
      getPowerSnapshot: idleAcSnapshot,
      getSchedulerSnapshot,
      integrity,
      logger,
      quietPeriodMs: 0,
      runDimensionMaintenance,
      runScheduledWork:
        runScheduledWork as unknown as DesktopDimensionIndexMaintenanceSchedulerOptions['runScheduledWork'],
      subscribeToSchedulerSnapshots: ignoreSchedulerSnapshots,
    });
    return {
      getDatabase,
      getSchedulerSnapshot,
      integrity,
      logger,
      runDimensionMaintenance,
      runScheduledWork,
      scheduler,
    };
  }

  it('skips with database-integrity-contained and never reads the scheduler, enters the lane, or opens the database', async () => {
    const harness = createContainedHarness();

    await expect(harness.scheduler.runOnce()).resolves.toEqual({
      reason: 'database-integrity-contained',
      status: 'skipped',
    });

    expect(harness.getSchedulerSnapshot).not.toHaveBeenCalled();
    expect(harness.runScheduledWork).not.toHaveBeenCalled();
    expect(harness.getDatabase).not.toHaveBeenCalled();
    expect(harness.runDimensionMaintenance).not.toHaveBeenCalled();
    expect(harness.logger.info).toHaveBeenCalledExactlyOnceWith(
      { integrityState: 'contained', revision: 1 },
      'Skipped dimension index maintenance because database integrity containment is active'
    );
  });

  it('runs again once the database has been replaced', async () => {
    const harness = createContainedHarness();
    harness.integrity.markDatabaseReplaced('developer-reset');

    await expect(harness.scheduler.runOnce()).resolves.toMatchObject({ status: 'completed' });
    expect(harness.runDimensionMaintenance).toHaveBeenCalledTimes(1);
  });
});
