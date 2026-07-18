import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATABASE_WORK_INVALIDATED_BY_RECOVERY_MESSAGE,
  getDesktopDatabaseWorkScheduler,
  getDesktopDatabaseWorkSchedulerSnapshot,
  quiesceDesktopDatabaseWorkForRecovery,
  resetDesktopDatabaseWorkSchedulerForTests,
  resolveSqlParamsAndWorkOptions,
  resumeDesktopDatabaseWorkAfterRecoveryReload,
  runDesktopScheduledDatabaseWork,
  runWithDesktopDatabaseResetBarrier,
  waitForDesktopDatabaseWorkSchedulerIdle,
} from '../../platform/desktop-database-work';

describe('desktop database work platform', () => {
  beforeEach(() => {
    resetDesktopDatabaseWorkSchedulerForTests();
  });

  it('keeps submitted work behind an active reset barrier', async () => {
    let releaseReset: (() => void) | null = null;
    const resetStarted = new Promise<void>((resolve) => {
      void runWithDesktopDatabaseResetBarrier(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseReset = release;
        });
      });
    });
    await resetStarted;

    let workStarted = false;
    const pendingWork = runDesktopScheduledDatabaseWork(
      { label: 'blocked-by-reset', priority: 'foreground' },
      async () => {
        workStarted = true;
        return 'ran';
      }
    );
    await Promise.resolve();

    expect(workStarted).toBe(false);
    expect(getDesktopDatabaseWorkSchedulerSnapshot()).toMatchObject({
      queued: { background: 0, foreground: 0, normal: 0 },
      runningPriority: null,
    });

    if (!releaseReset) {
      throw new Error('Reset barrier did not expose a release function.');
    }
    releaseReset();
    await expect(pendingWork).resolves.toBe('ran');
    await waitForDesktopDatabaseWorkSchedulerIdle(1000);
    expect(workStarted).toBe(true);
  });

  it('waits for scheduled work to drain', async () => {
    let releaseWork: (() => void) | null = null;
    const workStarted = new Promise<void>((resolve) => {
      void runDesktopScheduledDatabaseWork(
        { label: 'idle-drain', priority: 'foreground' },
        async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseWork = release;
          });
        }
      );
    });
    await workStarted;

    let idleResolved = false;
    const idlePromise = waitForDesktopDatabaseWorkSchedulerIdle(1000).then(() => {
      idleResolved = true;
    });
    await Promise.resolve();
    expect(idleResolved).toBe(false);

    if (!releaseWork) {
      throw new Error('Scheduled work did not expose a release function.');
    }
    releaseWork();
    await idlePromise;
    expect(idleResolved).toBe(true);
  });

  it('invalidates queued work and rejects new submissions until recovery reload starts', async () => {
    let releaseRunningWork: (() => void) | null = null;
    const runningWorkStarted = new Promise<void>((resolve) => {
      void runDesktopScheduledDatabaseWork(
        { label: 'corrupting-operation', priority: 'foreground' },
        async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseRunningWork = release;
          });
        }
      );
    });
    await runningWorkStarted;

    const staleOperation = vi.fn(async () => 'stale-result');
    const queuedWork = runDesktopScheduledDatabaseWork(
      { label: 'queued-before-recovery', priority: 'foreground' },
      staleOperation
    );
    const queuedWorkAssertion = expect(queuedWork).rejects.toThrow(
      DATABASE_WORK_INVALIDATED_BY_RECOVERY_MESSAGE
    );

    quiesceDesktopDatabaseWorkForRecovery();
    if (!releaseRunningWork) {
      throw new Error('Running work did not expose a release callback.');
    }
    releaseRunningWork();

    await queuedWorkAssertion;
    expect(staleOperation).not.toHaveBeenCalled();
    await expect(
      runDesktopScheduledDatabaseWork(
        { label: 'submitted-during-recovery', priority: 'foreground' },
        async () => 'blocked'
      )
    ).rejects.toThrow(DATABASE_WORK_INVALIDATED_BY_RECOVERY_MESSAGE);

    resumeDesktopDatabaseWorkAfterRecoveryReload();
    await expect(
      runDesktopScheduledDatabaseWork(
        { label: 'fresh-renderer-operation', priority: 'foreground' },
        async () => 'fresh-result'
      )
    ).resolves.toBe('fresh-result');
  });

  it('invalidates queued work submitted through the scheduler handed to backfills', async () => {
    const backfillScheduler = getDesktopDatabaseWorkScheduler();
    let releaseRunningWork: (() => void) | null = null;
    const runningWorkStarted = new Promise<void>((resolve) => {
      void runDesktopScheduledDatabaseWork(
        { label: 'corrupting-operation', priority: 'foreground' },
        async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseRunningWork = release;
          });
        }
      );
    });
    await runningWorkStarted;

    const staleBackfillQuery = vi.fn(async () => 'stale-result');
    const queuedBackfillWork = backfillScheduler.run(staleBackfillQuery, {
      label: 'queued-backfill-query',
      priority: 'background',
    });
    const queuedBackfillAssertion = expect(queuedBackfillWork).rejects.toThrow(
      DATABASE_WORK_INVALIDATED_BY_RECOVERY_MESSAGE
    );

    quiesceDesktopDatabaseWorkForRecovery();
    if (!releaseRunningWork) {
      throw new Error('Running work did not expose a release callback.');
    }
    releaseRunningWork();

    await queuedBackfillAssertion;
    expect(staleBackfillQuery).not.toHaveBeenCalled();
  });

  it('resolves SQL params separately from database work options', () => {
    expect(resolveSqlParamsAndWorkOptions('db:query', [1], { label: 'explicit' })).toEqual({
      params: [1],
      workOptions: { label: 'explicit' },
    });
    expect(
      resolveSqlParamsAndWorkOptions('db:query', { priority: 'background' }, undefined)
    ).toEqual({
      params: undefined,
      workOptions: { priority: 'background' },
    });
    expect(() => resolveSqlParamsAndWorkOptions('db:query', {}, undefined)).toThrow(
      'db:query parameters must be an array when provided.'
    );
    expect(resolveSqlParamsAndWorkOptions('db:query', [1], {})).toEqual({
      params: [1],
      workOptions: {},
    });
  });

  it('rejects overlapping reset barriers', async () => {
    let releaseReset: (() => void) | null = null;
    const resetStarted = new Promise<void>((resolve) => {
      void runWithDesktopDatabaseResetBarrier(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseReset = release;
        });
      });
    });
    await resetStarted;

    await expect(runWithDesktopDatabaseResetBarrier(async () => undefined)).rejects.toThrow(
      'Desktop database reset barrier is already active.'
    );
    if (!releaseReset) {
      throw new Error('Reset barrier did not expose a release function.');
    }
    releaseReset();
  });

  it('rejects scheduled database work submitted from inside the active reset barrier', async () => {
    await expect(
      runWithDesktopDatabaseResetBarrier(async () => {
        await runDesktopScheduledDatabaseWork(
          { label: 'nested-reset-work', priority: 'foreground' },
          async () => 'ran'
        );
      })
    ).rejects.toThrow(
      'Desktop database work cannot be scheduled from inside the active reset barrier.'
    );
  });
});
