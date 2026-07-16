import {
  type DatabaseWorkPriority,
  type DatabaseWorkRunOptions,
  type RunDimensionIndexMaintenanceResult,
  resolveIndexBuildMaintenanceWorkMemMb,
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
      getDimensionIndexStrategy: () => ({
        reason: 'concurrent-index-build-unmeasured',
        strategy: 'regular',
      }),
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
      getDimensionIndexStrategy: () => ({
        reason: 'concurrent-index-build-unmeasured',
        strategy: 'regular',
      }),
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
      getDimensionIndexStrategy: () => ({
        reason: 'concurrent-index-build-unmeasured',
        strategy: 'regular',
      }),
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
    expect(maintenanceExec).not.toHaveBeenCalledWith(
      expect.stringContaining('CREATE INDEX CONCURRENTLY'),
      []
    );
  });

  it('passes concurrent strategy only when capability selection chose concurrent', async () => {
    const maintenanceExec = vi.fn(async () => undefined);
    const runDimensionMaintenance = vi.fn(async (_db, options) => {
      await options.createIndex({ dimension: 384, strategy: options.strategy });
      return {
        dimension: 384,
        durationMs: 123,
        status: 'completed',
        strategy: options.strategy,
      } satisfies RunDimensionIndexMaintenanceResult;
    });

    const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
      getDatabase: vi.fn(async () => ({ maintenance: { exec: maintenanceExec }, query: vi.fn() })),
      getDimensionIndexStrategy: () => ({
        reason: 'concurrent-index-build-supported-and-responsive',
        strategy: 'concurrent',
      }),
      getPowerSnapshot: idleAcSnapshot,
      getSchedulerSnapshot: idleSchedulerSnapshot,
      logger: createLogger(),
      runDimensionMaintenance,
      runScheduledWork: vi.fn(async (_options, work) => await work()),
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      dimension: 384,
      status: 'completed',
      strategy: 'concurrent',
    });
    expect(maintenanceExec).toHaveBeenCalledWith(
      expect.stringContaining('CREATE INDEX CONCURRENTLY'),
      []
    );
  });

  describe('maintenance_work_mem tuning', () => {
    const EMBEDDED_ROW_COUNT_SQL_FRAGMENT = 'COUNT(*)';

    function createCountingQuery(count: string) {
      return vi.fn(async (sql: string) => {
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
        })),
        getDimensionIndexStrategy: () => ({
          reason: 'concurrent-index-build-unmeasured' as const,
          strategy: 'regular' as const,
        }),
        getPowerSnapshot: idleAcSnapshot,
        getSchedulerSnapshot: idleSchedulerSnapshot,
        logger: createLogger(),
        runDimensionMaintenance: options.runDimensionMaintenance,
        runScheduledWork: vi.fn(async (_options, work) => await work()),
      });
    }

    it('sets sized maintenance_work_mem before CREATE INDEX and resets after, all on the maintenance channel', async () => {
      const maintenanceExec = vi.fn(async () => undefined);
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

    it('skips the SET/RESET pair when the estimated build fits the default maintenance_work_mem', async () => {
      const maintenanceExec = vi.fn(async () => undefined);
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
