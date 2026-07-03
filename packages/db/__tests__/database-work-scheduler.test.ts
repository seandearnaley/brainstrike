import { describe, expect, it, vi } from 'vitest';
import {
  createDatabaseWorkScheduler,
  createPriorityDbHandle,
  createScheduledDbHandle,
  type DatabaseWorkPriority,
} from '../src/database-work-scheduler';

describe('DatabaseWorkScheduler', () => {
  it('throws when run is called without an explicit priority', () => {
    const scheduler = createDatabaseWorkScheduler();
    const untypedRun = scheduler.run.bind(scheduler) as (
      work: () => Promise<unknown>,
      options?: unknown
    ) => Promise<unknown>;
    const work = vi.fn(async () => 'value');

    expect(() => untypedRun(work)).toThrow(
      'DatabaseWorkScheduler.run requires an explicit priority'
    );
    expect(() => untypedRun(work, { label: 'no priority' })).toThrow(
      'DatabaseWorkScheduler.run requires an explicit priority'
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('stamps snapshots with the scheduler clock', () => {
    let now = 1000;
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0, now: () => now });

    expect(scheduler.getSnapshot().snapshotAt).toBe(1000);

    now = 1750;

    expect(scheduler.getSnapshot().snapshotAt).toBe(1750);
  });

  it('runs foreground work before queued background work during the quiet window', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 50 });
      const events: string[] = [];

      await scheduler.run(
        async () => {
          events.push('foreground-1');
        },
        { priority: 'foreground', label: 'initial foreground' }
      );

      const background = scheduler.run(
        async () => {
          events.push('background');
        },
        { priority: 'background', label: 'background import' }
      );

      await Promise.resolve();
      expect(events).toEqual(['foreground-1']);
      expect(scheduler.getSnapshot()).toMatchObject({
        queued: { background: 1, foreground: 0, normal: 0 },
        backgroundWaiting: true,
      });

      const foreground = scheduler.run(
        async () => {
          events.push('foreground-2');
        },
        { priority: 'foreground', label: 'collection page' }
      );

      await foreground;
      expect(events).toEqual(['foreground-1', 'foreground-2']);

      await vi.advanceTimersByTimeAsync(49);
      expect(events).toEqual(['foreground-1', 'foreground-2']);

      await vi.advanceTimersByTimeAsync(1);
      await background;
      expect(events).toEqual(['foreground-1', 'foreground-2', 'background']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat normal-priority work as scheduler foreground quiet-window pressure', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 50 });
      const events: string[] = [];

      await scheduler.run(
        async () => {
          events.push('normal');
        },
        { priority: 'normal', label: 'collection count refresh' }
      );

      const background = scheduler.run(
        async () => {
          events.push('background');
        },
        { priority: 'background', label: 'embedding claim' }
      );

      await background;
      expect(events).toEqual(['normal', 'background']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves FIFO order within the same priority', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const events: string[] = [];

    await Promise.all([
      scheduler.run(
        async () => {
          events.push('normal-1');
        },
        { priority: 'normal' }
      ),
      scheduler.run(
        async () => {
          events.push('normal-2');
        },
        { priority: 'normal' }
      ),
      scheduler.run(
        async () => {
          events.push('normal-3');
        },
        { priority: 'normal' }
      ),
    ]);

    expect(events).toEqual(['normal-1', 'normal-2', 'normal-3']);
  });

  it('coalesces synchronous zero-delay drain scheduling into one microtask', async () => {
    const queueMicrotaskSpy = vi.spyOn(globalThis, 'queueMicrotask');
    try {
      const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
      const work = vi.fn(async () => undefined);

      const first = scheduler.run(work, { priority: 'foreground' });
      const second = scheduler.run(work, { priority: 'foreground' });
      const third = scheduler.run(work, { priority: 'foreground' });

      expect(queueMicrotaskSpy).toHaveBeenCalledTimes(1);
      await Promise.all([first, second, third]);
      expect(work).toHaveBeenCalledTimes(3);
    } finally {
      queueMicrotaskSpy.mockRestore();
    }
  });

  it('propagates operation errors without blocking later work', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const expectedError = new Error('query failed');

    await expect(
      scheduler.run(
        async () => {
          throw expectedError;
        },
        { priority: 'foreground', label: 'broken query' }
      )
    ).rejects.toBe(expectedError);

    await expect(
      scheduler.run(async () => 'recovered', { priority: 'foreground', label: 'next query' })
    ).resolves.toBe('recovered');
  });

  it('retains cumulative operation stats after instantaneous queues drain', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });

    await scheduler.run(async () => 'foreground', {
      priority: 'foreground',
      label: 'collection search',
    });
    await scheduler.run(async () => 'background', {
      priority: 'background',
      label: 'embedding claim',
    });

    expect(scheduler.getSnapshot()).toMatchObject({
      queued: { background: 0, foreground: 0, normal: 0 },
      priorityStats: {
        foreground: {
          completed: 1,
          lastCompletedLabel: 'collection search',
          lastStartedLabel: 'collection search',
          queued: 1,
          started: 1,
        },
        normal: { completed: 0, queued: 0, started: 0 },
        background: {
          completed: 1,
          lastCompletedLabel: 'embedding claim',
          lastStartedLabel: 'embedding claim',
          queued: 1,
          started: 1,
        },
      },
    });
  });

  it('retains recent completed operation labels after later work overwrites the last label', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });

    await scheduler.run(async () => 'background', {
      priority: 'background',
      label: 'turso.embedding-worker.queue.claimMany',
    });
    await scheduler.run(async () => 'foreground', {
      priority: 'foreground',
      label: 'turso.queue-profile.foreground-probe',
    });
    await scheduler.run(async () => 'diagnostics', {
      priority: 'foreground',
      label: 'db.diagnostics',
    });

    expect(scheduler.getSnapshot()).toMatchObject({
      priorityStats: {
        background: {
          lastCompletedLabel: 'turso.embedding-worker.queue.claimMany',
        },
        foreground: {
          lastCompletedLabel: 'db.diagnostics',
        },
      },
      recentCompletedOperations: [
        {
          label: 'turso.embedding-worker.queue.claimMany',
          priority: 'background',
        },
        {
          label: 'turso.queue-profile.foreground-probe',
          priority: 'foreground',
        },
        {
          label: 'db.diagnostics',
          priority: 'foreground',
        },
      ],
    });
  });

  it('tracks rolling wait and service metrics by priority', async () => {
    const waits = [3, 9, 20, 40];
    const services = [7, 11, 13, 17];
    let now = 100;
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0, now: () => now });
    const gate = Promise.resolve();

    for (const [index, waitMs] of waits.entries()) {
      const serviceMs = services[index];
      if (serviceMs === undefined) {
        throw new Error(`Missing service duration for wait ${waitMs}.`);
      }
      const scheduledAt = now;
      const run = scheduler.run(
        async () => {
          await gate;
          now += serviceMs;
        },
        { priority: 'background', label: `embedding batch ${index + 1}` }
      );
      now = scheduledAt + waitMs;
      await run;
      now += 1;
    }

    expect(scheduler.getSnapshot().priorityStats.background).toMatchObject({
      completed: 4,
      longestWaitMs: 40,
      serviceP50Ms: 11,
      serviceP95Ms: 17,
      totalServiceMs: 48,
      totalWaitMs: 72,
      waitP50Ms: 9,
      waitP95Ms: 40,
      lastCompletedLabel: 'embedding batch 4',
      lastStartedLabel: 'embedding batch 4',
    });
  });

  it('keeps rolling metric percentiles bounded to the latest sample window', async () => {
    let now = 0;
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0, now: () => now });

    for (let waitMs = 1; waitMs <= 65; waitMs += 1) {
      const scheduledAt = now;
      const run = scheduler.run(
        async () => {
          now += 1;
        },
        { priority: 'background', label: `embedding batch ${waitMs}` }
      );
      now = scheduledAt + waitMs;
      await run;
      now += 1;
    }

    expect(scheduler.getSnapshot().priorityStats.background).toMatchObject({
      completed: 65,
      serviceP50Ms: 1,
      serviceP95Ms: 1,
      waitP50Ms: 33,
      waitP95Ms: 62,
    });
  });

  it('marks background work as waiting while foreground work is running', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 50 });
      let releaseForeground: (() => void) | null = null;
      const foreground = scheduler.run(
        async () =>
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          }),
        { priority: 'foreground', label: 'hybrid search' }
      );

      await Promise.resolve();
      const background = scheduler.run(async () => 'background', {
        priority: 'background',
        label: 'embedding claim',
      });
      await Promise.resolve();

      expect(scheduler.getSnapshot()).toMatchObject({
        backgroundWaiting: true,
        backgroundYieldCount: 1,
        queued: { background: 1, foreground: 0, normal: 0 },
        runningPriority: 'foreground',
      });

      releaseForeground?.();
      await foreground;
      await vi.advanceTimersByTimeAsync(50);
      await background;
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps database handles with scheduled default and explicit priority lanes', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const seenPriorities: DatabaseWorkPriority[] = [];
    scheduler.subscribe((snapshot) => {
      if (snapshot.runningPriority) {
        seenPriorities.push(snapshot.runningPriority);
      }
    });

    const rawDb = {
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
      exec: vi.fn(async (_sql: string, _params?: unknown[]) => undefined),
    };

    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground');
    const background = createPriorityDbHandle(scheduled, 'background');

    await scheduled.query('SELECT foreground');
    await background.query('SELECT background');
    await background.exec?.('UPDATE background');

    expect(rawDb.query).toHaveBeenCalledTimes(2);
    expect(rawDb.exec).toHaveBeenCalledTimes(1);
    expect(seenPriorities).toEqual(['foreground', 'background', 'background']);
  });

  it('schedules syncToFs with the raw database receiver', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const receiver = Symbol('receiver');
    const rawDb = {
      receiver,
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
      syncToFs: vi.fn(async function (this: { readonly receiver: symbol }) {
        expect(this.receiver).toBe(receiver);
      }),
    };

    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground');
    await scheduled.syncToFs?.();

    expect(rawDb.syncToFs).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot().priorityStats.foreground).toMatchObject({
      completed: 1,
      lastCompletedLabel: 'syncToFs',
    });
  });

  it('passes database work options as the third query argument when no params are provided', async () => {
    const rawDb = {
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[], _options?: unknown) => ({
        rows: [] as T[],
      })),
      exec: vi.fn(async (_sql: string, _params?: unknown[], _options?: unknown) => undefined),
    };

    const background = createPriorityDbHandle(rawDb, 'background');

    await background.query('SELECT background');
    await background.exec?.('UPDATE background');

    expect(rawDb.query).toHaveBeenCalledWith('SELECT background', undefined, {
      label: 'query: SELECT background',
      priority: 'background',
    });
    expect(rawDb.exec).toHaveBeenCalledWith('UPDATE background', undefined, {
      label: 'exec: UPDATE background',
      priority: 'background',
    });
  });

  it('applies priority work options to atomic chunk/job enqueue calls', async () => {
    const rawDb = {
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
      insertChunksAndEnqueueEmbeddingJobs: vi.fn(
        async (
          _chunks: readonly unknown[],
          _fileRecordId: string,
          _options: unknown,
          _workOptions?: unknown
        ) => undefined
      ),
    };

    const background = createPriorityDbHandle(rawDb, 'background') as typeof rawDb;

    await background.insertChunksAndEnqueueEmbeddingJobs([], 'file-1', {
      model: 'local::Xenova/all-MiniLM-L6-v2',
      targetDimension: 384,
    });

    expect(rawDb.insertChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith(
      [],
      'file-1',
      {
        model: 'local::Xenova/all-MiniLM-L6-v2',
        targetDimension: 384,
      },
      { priority: 'background' }
    );
  });

  it('forwards native PGlite query options while consuming database work options', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const nativeQueryOptions = { rowMode: 'array' };
    const rawDb = {
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[], _options?: unknown) => ({
        rows: [] as T[],
      })),
    };

    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground');
    await scheduled.query('SELECT native', [], nativeQueryOptions);
    await scheduled.query('SELECT qos', [], { label: 'collection page', priority: 'normal' });

    expect(rawDb.query).toHaveBeenNthCalledWith(1, 'SELECT native', [], nativeQueryOptions);
    expect(rawDb.query).toHaveBeenNthCalledWith(2, 'SELECT qos', []);
  });

  it('does not consume native query options that only resemble scheduler options', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const rawDb = {
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[], _options?: unknown) => ({
        rows: [] as T[],
      })),
    };
    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground');
    const nativeOptions = { label: 'native query label', rowMode: 'array' };

    await scheduled.query('SELECT native', [], nativeOptions);

    expect(rawDb.query).toHaveBeenCalledWith('SELECT native', [], nativeOptions);
  });

  it('does not consume label-only native query options as scheduler options', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const rawDb = {
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[], _options?: unknown) => ({
        rows: [] as T[],
      })),
    };
    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground');
    const nativeOptions = { label: 'native query label' };

    await scheduled.query('SELECT native', [], nativeOptions);

    expect(rawDb.query).toHaveBeenCalledWith('SELECT native', [], nativeOptions);
  });

  it('does not re-enter the scheduler for queries inside a scheduled transaction', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const seenPriorities: DatabaseWorkPriority[] = [];
    scheduler.subscribe((snapshot) => {
      if (snapshot.runningPriority) {
        seenPriorities.push(snapshot.runningPriority);
      }
    });

    const txDb = {
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [{ ok: true }] as T[],
      })),
    };
    const rawDb = {
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
      transaction: vi.fn(async <T>(fn: (tx: typeof txDb) => Promise<T>) => await fn(txDb)),
    };

    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'background');

    await expect(
      scheduled.transaction?.(async (tx) => {
        const result = await tx.query<{ ok: boolean }>('SELECT inside transaction');
        return result.rows[0]?.ok;
      })
    ).resolves.toBe(true);

    expect(txDb.query).toHaveBeenCalledTimes(1);
    expect(txDb.query).toHaveBeenCalledWith('SELECT inside transaction');
    expect(seenPriorities).toEqual(['background']);
  });

  it('preserves the raw database receiver when scheduling transactions', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const txDb = {
      query: vi.fn(async <T = unknown>(_sql: string) => ({
        rows: [{ ok: true }] as T[],
      })),
    };
    const rawDb = {
      marker: 'raw-db',
      query: vi.fn(async <T = unknown>(_sql: string) => ({ rows: [] as T[] })),
      async transaction<T>(
        this: { marker: string },
        fn: (tx: typeof txDb) => Promise<T>
      ): Promise<T> {
        expect(this.marker).toBe('raw-db');
        return await fn(txDb);
      },
    };

    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground');

    await expect(
      scheduled.transaction?.(async (tx) => await tx.query('SELECT 1'))
    ).resolves.toEqual({
      rows: [{ ok: true }],
    });
  });

  it('preserves the raw database receiver when applying priority transactions', async () => {
    const txDb = {
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[], _options?: unknown) => ({
        rows: [{ ok: true }] as T[],
      })),
    };
    const rawDb = {
      marker: 'priority-db',
      query: vi.fn(async <T = unknown>(_sql: string) => ({ rows: [] as T[] })),
      async transaction<T>(
        this: { marker: string },
        fn: (tx: typeof txDb) => Promise<T>
      ): Promise<T> {
        expect(this.marker).toBe('priority-db');
        return await fn(txDb);
      },
    };

    const background = createPriorityDbHandle(rawDb, 'background');

    await expect(
      background.transaction?.(async (tx) => await tx.query('SELECT 1'))
    ).resolves.toEqual({
      rows: [{ ok: true }],
    });
    expect(txDb.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('schedules foreground-handle live query creation on normal and refresh on background', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const seenPriorities: DatabaseWorkPriority[] = [];
    scheduler.subscribe((snapshot) => {
      if (snapshot.runningPriority) {
        seenPriorities.push(snapshot.runningPriority);
      }
    });

    const liveHandle = {
      initialResults: { rows: [] },
      refresh: vi.fn(async () => undefined),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(async () => undefined),
    };
    const rawDb = {
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
      live: {
        query: vi.fn(async () => liveHandle),
        incrementalQuery: vi.fn(async () => liveHandle),
      },
    };

    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground') as typeof rawDb;
    const handle = await scheduled.live.query({ query: 'SELECT 1' });
    await handle.refresh();

    expect(rawDb.live.query).toHaveBeenCalledTimes(1);
    expect(liveHandle.refresh).toHaveBeenCalledTimes(1);
    expect(seenPriorities).toEqual(['normal', 'background']);
  });

  it('does not let foreground-handle live query refreshes extend the background quiet window', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 50 });
      const events: string[] = [];
      const liveHandle = {
        initialResults: { rows: [] },
        refresh: vi.fn(async () => {
          events.push('live-refresh');
        }),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(async () => undefined),
      };
      const rawDb = {
        query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
          rows: [] as T[],
        })),
        live: {
          query: vi.fn(async () => liveHandle),
          incrementalQuery: vi.fn(async () => liveHandle),
        },
      };

      await scheduler.run(
        async () => {
          events.push('foreground');
        },
        { priority: 'foreground', label: 'user query' }
      );
      const background = scheduler.run(
        async () => {
          events.push('background');
        },
        { priority: 'background', label: 'workspace index' }
      );
      const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground') as typeof rawDb;
      const handle = await scheduled.live.query({ query: 'SELECT 1' });
      const refresh = handle.refresh();

      await vi.advanceTimersByTimeAsync(50);
      await Promise.all([background, refresh]);

      expect(events).toEqual(['foreground', 'background', 'live-refresh']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds worker leader-change methods to the raw database target', () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const unsubscribe = vi.fn();
    const listener = vi.fn();
    class RawWorkerDb {
      readonly query = vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      }));

      readonly #marker = 'raw-worker';

      onLeaderChange(callback: () => void) {
        if (this.#marker !== 'raw-worker') {
          throw new Error('leader-change method must use raw receiver');
        }
        callback();
        return unsubscribe;
      }
    }

    const rawDb = new RawWorkerDb();
    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground') as typeof rawDb;
    const result = scheduled.onLeaderChange(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(result).toBe(unsubscribe);
  });

  it('returns stable wrapper identities for raw receiver methods', () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    class RawWorkerDb {
      readonly query = vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      }));

      readonly #marker = 'raw-worker';

      onLeaderChange(callback: () => void) {
        if (this.#marker !== 'raw-worker') {
          throw new Error('leader-change method must use raw receiver');
        }
        callback();
        return () => undefined;
      }
    }

    const scheduled = createScheduledDbHandle(
      new RawWorkerDb(),
      scheduler,
      'foreground'
    ) as RawWorkerDb;

    expect(scheduled.onLeaderChange).toBe(scheduled.onLeaderChange);
  });
});
