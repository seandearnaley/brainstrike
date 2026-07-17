import type {
  DatabaseWorkPriority,
  DatabaseWorkRunOptions,
  RunDimensionIndexMaintenanceResult,
} from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopDimensionIndexMaintenanceScheduler } from '../dimension-index-maintenance-scheduler';

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
      logger: createLogger(),
      runDimensionMaintenance,
      runScheduledWork,
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
      logger: createLogger(),
      runDimensionMaintenance: vi.fn(),
      runScheduledWork,
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
      logger: createLogger(),
      runDimensionMaintenance: vi.fn(),
      runScheduledWork,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      reason: 'strategy-unavailable',
      status: 'skipped',
    });
    expect(runScheduledWork).not.toHaveBeenCalled();
  });

  it('runs one maintenance unit through the background DB lane using maintenance exec', async () => {
    let capturedOptions: DatabaseWorkRunOptions | null = null;
    const maintenanceExec = vi.fn(async () => undefined);
    const runScheduledWork = vi.fn(
      async <TResult>(
        options: DatabaseWorkRunOptions,
        work: () => Promise<TResult>
      ): Promise<TResult> => {
        capturedOptions = options;
        return await work();
      }
    );
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
      getDatabase: vi.fn(async () => ({ maintenance: { exec: maintenanceExec }, query: vi.fn() })),
      getDimensionIndexStrategy: () => 'regular',
      getPowerSnapshot: idleAcSnapshot,
      getSchedulerSnapshot: idleSchedulerSnapshot,
      logger: createLogger(),
      runDimensionMaintenance,
      runScheduledWork,
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
      getDatabase: vi.fn(async () => ({ maintenance: { exec: maintenanceExec }, query: vi.fn() })),
      getDimensionIndexStrategy: () => 'regular',
      getPowerSnapshot: idleAcSnapshot,
      getSchedulerSnapshot: idleSchedulerSnapshot,
      logger: createLogger(),
      runDimensionMaintenance,
      runScheduledWork: vi.fn(async (_options, work) => await work()),
    });

    await expect(scheduler.runOnce()).rejects.toThrow(
      'Dimension index maintenance no longer supports the concurrent strategy.'
    );
    expect(maintenanceExec).not.toHaveBeenCalled();
  });
});
