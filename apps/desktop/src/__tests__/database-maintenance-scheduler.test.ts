import type {
  DatabaseWorkOptions,
  DatabaseWorkPriority,
  ScheduledDatabaseMaintenanceResult,
} from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopDatabaseMaintenanceScheduler } from '../database-maintenance-scheduler';

const COMPLETED_MAINTENANCE_RESULT: ScheduledDatabaseMaintenanceResult = {
  activeJobs: 0,
  completedAt: '2026-05-01T12:00:00.100Z',
  durationMs: 100,
  prunedTerminalJobs: 2,
  startedAt: '2026-05-01T12:00:00.000Z',
  status: 'completed',
  vacuumedTables: ['job_queue'],
};

function createQueuedCounts(
  overrides: Partial<Record<DatabaseWorkPriority, number>> = {}
): Record<DatabaseWorkPriority, number> {
  return {
    background: overrides.background ?? 0,
    foreground: overrides.foreground ?? 0,
    normal: overrides.normal ?? 0,
  };
}

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
    );
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
        prunedTerminalJobs: 2,
        vacuumedTables: ['job_queue'],
      }),
      'Scheduled database maintenance completed'
    );
  });

  it('prevents overlapping maintenance passes', async () => {
    let resolveMaintenance: ((result: ScheduledDatabaseMaintenanceResult) => void) | null = null;
    const runScheduledWork = vi.fn(
      async <TResult>(
        _options: DatabaseWorkOptions,
        work: () => Promise<TResult>
      ): Promise<TResult> => await work()
    );
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

    resolveMaintenance?.(COMPLETED_MAINTENANCE_RESULT);
    await firstRun;
  });
});
