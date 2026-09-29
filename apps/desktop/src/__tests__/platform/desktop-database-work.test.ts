import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DatabaseIntegrityError,
  getDesktopDatabaseIntegrity,
  resetDesktopDatabaseIntegrityForTests,
} from '../../database-integrity-state';
import {
  getDesktopDatabaseWorkScheduler,
  getDesktopDatabaseWorkSchedulerSnapshot,
  resetDesktopDatabaseWorkSchedulerForTests,
  resolveSqlParamsAndWorkOptions,
  runDesktopScheduledDatabaseWork,
  runWithDesktopDatabaseResetBarrier,
  waitForDesktopDatabaseWorkSchedulerIdle,
} from '../../platform/desktop-database-work';

describe('desktop database work platform', () => {
  beforeEach(() => {
    resetDesktopDatabaseWorkSchedulerForTests();
    resetDesktopDatabaseIntegrityForTests();
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
    const finishReset = releaseReset as (() => void) | null;
    if (!finishReset) {
      throw new Error('Reset barrier did not expose a release function.');
    }
    finishReset();
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
    const finishWork = releaseWork as (() => void) | null;
    if (!finishWork) {
      throw new Error('Scheduled work did not expose a release function.');
    }
    finishWork();
    await idlePromise;
    expect(idleResolved).toBe(true);
  });

  describe('database integrity containment gate', () => {
    const SIGNAL = { message: 'invalid page in block 3', sqlstate: 'XX001' } as const;

    function startBlockingForegroundWork(): {
      readonly release: () => void;
      readonly started: Promise<void>;
    } {
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        void runDesktopScheduledDatabaseWork(
          { label: 'blocking-foreground', priority: 'foreground' },
          async () => {
            resolve();
            await new Promise<void>((done) => {
              release = done;
            });
          }
        );
      });
      return { release: () => release(), started };
    }

    it('rejects a new background submission with background-paused and never runs its closure', async () => {
      const contained = getDesktopDatabaseIntegrity().contain('db:query', SIGNAL);
      const operation = vi.fn(async () => 'ran');

      const rejection = await runDesktopScheduledDatabaseWork(
        { label: 'background-while-contained', priority: 'background' },
        operation
      ).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(DatabaseIntegrityError);
      expect((rejection as DatabaseIntegrityError).detail).toEqual({
        reason: 'background-paused',
        state: contained.state,
      });
      expect(operation).not.toHaveBeenCalled();
      expect(getDesktopDatabaseWorkSchedulerSnapshot().queued.background).toBe(0);
    });

    it('rejects a background task that was queued before containment when it would start', async () => {
      const blocker = startBlockingForegroundWork();
      await blocker.started;
      const operation = vi.fn(async () => 'ran');
      const queued = runDesktopScheduledDatabaseWork(
        { label: 'queued-background', priority: 'background' },
        operation
      );
      const queuedRejection = expect(queued).rejects.toThrow(DatabaseIntegrityError);
      await Promise.resolve();

      getDesktopDatabaseIntegrity().contain('db:query', SIGNAL);
      blocker.release();

      await queuedRejection;
      expect(operation).not.toHaveBeenCalled();
    });

    it('lets the task that is already running finish', async () => {
      let release: () => void = () => undefined;
      let markStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const running = runDesktopScheduledDatabaseWork(
        { label: 'running-background', priority: 'background' },
        async () => {
          markStarted();
          await new Promise<void>((done) => {
            release = done;
          });
          return 'finished';
        }
      );
      await started;

      getDesktopDatabaseIntegrity().contain('db:query', SIGNAL);
      release();

      await expect(running).resolves.toBe('finished');
    });

    it('keeps running foreground and normal work while contained', async () => {
      getDesktopDatabaseIntegrity().contain('db:query', SIGNAL);

      await expect(
        runDesktopScheduledDatabaseWork(
          { label: 'foreground-while-contained', priority: 'foreground' },
          async () => 'foreground'
        )
      ).resolves.toBe('foreground');
      await expect(
        runDesktopScheduledDatabaseWork(
          { label: 'normal-while-contained', priority: 'normal' },
          async () => 'normal'
        )
      ).resolves.toBe('normal');
    });

    it('gates the scheduler handed to backfills the same way', async () => {
      getDesktopDatabaseIntegrity().contain('db:query', SIGNAL);
      const operation = vi.fn(async () => 'ran');

      await expect(
        getDesktopDatabaseWorkScheduler().run(operation, {
          label: 'backfill-query',
          priority: 'background',
        })
      ).rejects.toThrow(DatabaseIntegrityError);
      expect(operation).not.toHaveBeenCalled();
      await expect(
        getDesktopDatabaseWorkScheduler().run(async () => 'foreground', {
          label: 'foreground-query',
          priority: 'foreground',
        })
      ).resolves.toBe('foreground');
    });

    it('admits background work again after the database is replaced', async () => {
      const integrity = getDesktopDatabaseIntegrity();
      integrity.contain('db:query', SIGNAL);
      integrity.markDatabaseReplaced('factory-reset');

      await expect(
        runDesktopScheduledDatabaseWork(
          { label: 'background-after-replacement', priority: 'background' },
          async () => 'ran'
        )
      ).resolves.toBe('ran');
    });
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
    const finishReset = releaseReset as (() => void) | null;
    if (!finishReset) {
      throw new Error('Reset barrier did not expose a release function.');
    }
    finishReset();
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
