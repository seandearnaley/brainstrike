import { describe, expect, it, vi } from 'vitest';
import { databaseQueryTelemetry } from '../src/database-query-telemetry';
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

  it('stamps snapshots with separate diagnostic and elapsed clocks', () => {
    let elapsedNow = 10;
    let now = 1000;
    const scheduler = createDatabaseWorkScheduler({
      elapsedNow: () => elapsedNow,
      foregroundQuietMs: 0,
      now: () => now,
    });

    expect(scheduler.getSnapshot().elapsedSnapshotAt).toBe(10);
    expect(scheduler.getSnapshot().snapshotAt).toBe(1000);

    elapsedNow = 25;
    now = 1750;

    expect(scheduler.getSnapshot().elapsedSnapshotAt).toBe(25);
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
        { label: 'initial foreground', priority: 'foreground' }
      );

      const background = scheduler.run(
        async () => {
          events.push('background');
        },
        { label: 'background import', priority: 'background' }
      );

      await Promise.resolve();
      expect(events).toEqual(['foreground-1']);
      expect(scheduler.getSnapshot()).toMatchObject({
        backgroundWaiting: true,
        queued: { background: 1, foreground: 0, normal: 0 },
      });

      const foreground = scheduler.run(
        async () => {
          events.push('foreground-2');
        },
        { label: 'collection page', priority: 'foreground' }
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

  it('runs waiting background work once sustained foreground pressure reaches the starvation bound', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createDatabaseWorkScheduler({
        backgroundStarvationMs: 200,
        foregroundQuietMs: 50,
      });
      const events: string[] = [];

      await scheduler.run(
        async () => {
          events.push('foreground-0');
        },
        { priority: 'foreground' }
      );

      const background = scheduler.run(
        async () => {
          events.push('background');
        },
        { label: 'embedding completion', priority: 'background' }
      );

      for (let index = 1; index <= 5; index += 1) {
        await vi.advanceTimersByTimeAsync(40);
        await scheduler.run(
          async () => {
            events.push(`foreground-${index}`);
          },
          { priority: 'foreground' }
        );
      }

      await background;

      expect(events).toEqual([
        'foreground-0',
        'foreground-1',
        'foreground-2',
        'foreground-3',
        'foreground-4',
        'background',
        'foreground-5',
      ]);
      expect(scheduler.getSnapshot().priorityStats.background.longestWaitMs).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the starvation clock when background work queues behind foreground during a running background task', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createDatabaseWorkScheduler({
        backgroundStarvationMs: 100,
        foregroundQuietMs: 50,
      });
      const events: string[] = [];
      let releaseFirstBackground: (() => void) | null = null;
      const firstBackground = scheduler.run(
        async () => {
          events.push('background-1-start');
          await new Promise<void>((resolve) => {
            releaseFirstBackground = resolve;
          });
          events.push('background-1-end');
        },
        { priority: 'background' }
      );
      await vi.advanceTimersByTimeAsync(0);

      const foreground = scheduler.run(
        async () => {
          events.push('foreground');
        },
        { priority: 'foreground' }
      );
      const secondBackground = scheduler.run(
        async () => {
          events.push('background-2');
        },
        { priority: 'background' }
      );

      await vi.advanceTimersByTimeAsync(100);
      if (!releaseFirstBackground) {
        throw new Error('Expected first background task to start.');
      }
      releaseFirstBackground();
      await firstBackground;
      await secondBackground;
      await foreground;

      expect(events).toEqual([
        'background-1-start',
        'background-1-end',
        'background-2',
        'foreground',
      ]);
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
        { label: 'collection count refresh', priority: 'normal' }
      );

      const background = scheduler.run(
        async () => {
          events.push('background');
        },
        { label: 'embedding claim', priority: 'background' }
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
        { label: 'broken query', priority: 'foreground' }
      )
    ).rejects.toBe(expectedError);

    await expect(
      scheduler.run(async () => 'recovered', { label: 'next query', priority: 'foreground' })
    ).resolves.toBe('recovered');
  });

  it('retains cumulative operation stats after instantaneous queues drain', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });

    await scheduler.run(async () => 'foreground', {
      label: 'collection search',
      priority: 'foreground',
    });
    await scheduler.run(async () => 'background', {
      label: 'embedding claim',
      priority: 'background',
    });

    expect(scheduler.getSnapshot()).toMatchObject({
      priorityStats: {
        background: {
          completed: 1,
          lastCompletedLabel: 'embedding claim',
          lastStartedLabel: 'embedding claim',
          queued: 1,
          started: 1,
        },
        foreground: {
          completed: 1,
          lastCompletedLabel: 'collection search',
          lastStartedLabel: 'collection search',
          queued: 1,
          started: 1,
        },
        normal: { completed: 0, queued: 0, started: 0 },
      },
      queued: { background: 0, foreground: 0, normal: 0 },
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
        { label: 'hybrid search', priority: 'foreground' }
      );

      await Promise.resolve();
      const background = scheduler.run(async () => 'background', {
        label: 'embedding claim',
        priority: 'background',
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
      exec: vi.fn(async (_sql: string, _params?: unknown[]) => undefined),
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
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
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
      receiver,
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
      exec: vi.fn(async (_sql: string, _params?: unknown[], _options?: unknown) => undefined),
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[], _options?: unknown) => ({
        rows: [] as T[],
      })),
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
      insertChunksAndEnqueueEmbeddingJobs: vi.fn(
        async (
          _chunks: readonly unknown[],
          _fileRecordId: string,
          _options: unknown,
          _workOptions?: unknown
        ) => undefined
      ),
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
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
      live: {
        incrementalQuery: vi.fn(async () => liveHandle),
        query: vi.fn(async () => liveHandle),
      },
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
    };

    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground') as typeof rawDb;
    const handle = await scheduled.live.query({ query: 'SELECT 1' });
    await handle.refresh();

    expect(rawDb.live.query).toHaveBeenCalledTimes(1);
    expect(liveHandle.refresh).toHaveBeenCalledTimes(1);
    expect(seenPriorities).toEqual(['normal', 'background']);
  });

  it('tracks live query creation, subscriptions, updates, and cleanup', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    let subscribedListener: ((results: unknown) => void) | null = null;
    const liveHandle = {
      initialResults: { rows: [] },
      refresh: vi.fn(async () => undefined),
      subscribe: vi.fn((listener: (results: unknown) => void) => {
        subscribedListener = listener;
      }),
      unsubscribe: vi.fn(async () => undefined),
    };
    const rawDb = {
      live: {
        incrementalQuery: vi.fn(async () => liveHandle),
        query: vi.fn(async () => liveHandle),
      },
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
    };
    const telemetryBefore = databaseQueryTelemetry.snapshot();
    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground') as typeof rawDb;
    const handle = await scheduled.live.query({ query: 'SELECT 1' });
    const listener = vi.fn(function (this: { readonly marker: string }) {
      expect(this.marker).toBe('live-handle');
    });
    handle.subscribe(listener);
    expect(databaseQueryTelemetry.snapshot().activeLiveSubscriptions).toBe(
      telemetryBefore.activeLiveSubscriptions + 1
    );
    expect(subscribedListener).not.toBeNull();
    subscribedListener?.call({ marker: 'live-handle' }, { rows: [] });
    await handle.unsubscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(databaseQueryTelemetry.snapshot()).toMatchObject({
      activeLiveSubscriptions: telemetryBefore.activeLiveSubscriptions,
    });
    expect(databaseQueryTelemetry.snapshot().liveUpdateCount).toBe(
      telemetryBefore.liveUpdateCount + 1
    );
    expect(databaseQueryTelemetry.snapshot().features['live-query'].queryCount).toBe(
      telemetryBefore.features['live-query'].queryCount + 1
    );
  });

  it('requires a fresh PGlite live-query handle after teardown starts', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    let subscribedListener: ((...args: unknown[]) => unknown) | null = null;
    let dead = false;
    const liveHandle = {
      initialResults: { rows: [] },
      refresh: vi.fn(async () => undefined),
      subscribe: vi.fn((listener: (...args: unknown[]) => unknown) => {
        if (dead) {
          throw new Error('Live query is no longer active and cannot be subscribed to');
        }
        subscribedListener = listener;
      }),
      unsubscribe: vi.fn(async () => {
        // Models PGlite's REJECTED teardown faithfully, verified against the
        // 0.5.5 source (BST-1283): `unsubscribe` drops the callback and latches
        // `dead = true` SYNCHRONOUSLY, then awaits the teardown transaction — so
        // a rejection still leaves the listener detached and the handle dead,
        // with no upstream retry. That ordering is unchanged since 0.5.3.
        dead = true;
        subscribedListener = null;
        throw new Error('database is closing');
      }),
    };
    const replacementLiveHandle = {
      initialResults: { rows: [] },
      refresh: vi.fn(async () => undefined),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(async () => undefined),
    };
    const rawDb = {
      live: {
        incrementalQuery: vi.fn(async () => replacementLiveHandle),
        query: vi
          .fn()
          .mockResolvedValueOnce(liveHandle)
          .mockResolvedValueOnce(replacementLiveHandle),
      },
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
    };
    const telemetryBefore = databaseQueryTelemetry.snapshot();
    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground') as typeof rawDb;
    const handle = await scheduled.live.query({ query: 'SELECT 1' });
    const listener = vi.fn();
    handle.subscribe(listener);

    await expect(handle.unsubscribe(listener)).rejects.toThrow('database is closing');

    expect(databaseQueryTelemetry.snapshot().activeLiveSubscriptions).toBe(
      telemetryBefore.activeLiveSubscriptions
    );
    const liveUpdatesAfterFailedCleanup = databaseQueryTelemetry.snapshot().liveUpdateCount;
    subscribedListener?.({ rows: [] });
    expect(databaseQueryTelemetry.snapshot().liveUpdateCount).toBe(liveUpdatesAfterFailedCleanup);

    expect(() => handle.subscribe(listener)).toThrow(
      'Scheduled PGlite live-query handle is no longer active; create a fresh handle'
    );
    await expect(handle.unsubscribe(listener)).resolves.toBeUndefined();
    expect(liveHandle.subscribe).toHaveBeenCalledTimes(1);
    expect(liveHandle.unsubscribe).toHaveBeenCalledTimes(1);
    expect(databaseQueryTelemetry.snapshot().activeLiveSubscriptions).toBe(
      telemetryBefore.activeLiveSubscriptions
    );

    const replacementHandle = await scheduled.live.query({ query: 'SELECT 1' });
    replacementHandle.subscribe(listener);
    expect(databaseQueryTelemetry.snapshot().activeLiveSubscriptions).toBe(
      telemetryBefore.activeLiveSubscriptions + 1
    );
    await replacementHandle.unsubscribe(listener);
    expect(databaseQueryTelemetry.snapshot().activeLiveSubscriptions).toBe(
      telemetryBefore.activeLiveSubscriptions
    );
  });

  it('fails fast when a scheduled PGlite live-query handle receives a second listener', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const liveHandle = {
      initialResults: { rows: [] },
      refresh: vi.fn(async () => undefined),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(async () => undefined),
    };
    const rawDb = {
      live: {
        incrementalQuery: vi.fn(async () => liveHandle),
        query: vi.fn(async () => liveHandle),
      },
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
    };
    const telemetryBefore = databaseQueryTelemetry.snapshot();
    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground') as typeof rawDb;
    const handle = await scheduled.live.query({ query: 'SELECT 1' });
    const firstListener = vi.fn();

    handle.subscribe(firstListener);
    expect(() => handle.subscribe(vi.fn())).toThrow(
      'Scheduled PGlite live-query handles support exactly one listener'
    );
    expect(liveHandle.subscribe).toHaveBeenCalledTimes(1);
    expect(databaseQueryTelemetry.snapshot().activeLiveSubscriptions).toBe(
      telemetryBefore.activeLiveSubscriptions + 1
    );

    await handle.unsubscribe(firstListener);
    await expect(handle.unsubscribe(firstListener)).resolves.toBeUndefined();
    expect(liveHandle.unsubscribe).toHaveBeenCalledTimes(1);
    expect(databaseQueryTelemetry.snapshot().activeLiveSubscriptions).toBe(
      telemetryBefore.activeLiveSubscriptions
    );
  });

  it('counts a live update delivered synchronously during subscription', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const liveHandle = {
      initialResults: { rows: [] },
      refresh: vi.fn(async () => undefined),
      subscribe: vi.fn((listener: () => void) => listener()),
      unsubscribe: vi.fn(async () => undefined),
    };
    const rawDb = {
      live: {
        incrementalQuery: vi.fn(async () => liveHandle),
        query: vi.fn(async () => liveHandle),
      },
      query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
        rows: [] as T[],
      })),
    };
    const telemetryBefore = databaseQueryTelemetry.snapshot();
    const scheduled = createScheduledDbHandle(rawDb, scheduler, 'foreground') as typeof rawDb;
    const handle = await scheduled.live.query({ query: 'SELECT 1' });
    const listener = vi.fn();

    handle.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(databaseQueryTelemetry.snapshot().liveUpdateCount).toBe(
      telemetryBefore.liveUpdateCount + 1
    );
    await handle.unsubscribe(listener);
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
        live: {
          incrementalQuery: vi.fn(async () => liveHandle),
          query: vi.fn(async () => liveHandle),
        },
        query: vi.fn(async <T = unknown>(_sql: string, _params?: unknown[]) => ({
          rows: [] as T[],
        })),
      };

      await scheduler.run(
        async () => {
          events.push('foreground');
        },
        { label: 'user query', priority: 'foreground' }
      );
      const background = scheduler.run(
        async () => {
          events.push('background');
        },
        { label: 'workspace index', priority: 'background' }
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
