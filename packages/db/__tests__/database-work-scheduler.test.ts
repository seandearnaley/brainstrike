import { describe, expect, it, vi } from 'vitest';
import {
  createDatabaseWorkScheduler,
  createPriorityDbHandle,
  createScheduledDbHandle,
  type DatabaseWorkPriority,
} from '../src/database-work-scheduler';

describe('DatabaseWorkScheduler', () => {
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
    expect(seenPriorities).toEqual(['background']);
  });

  it('schedules direct live query creation and refresh on the handle default lane', async () => {
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
    expect(seenPriorities).toEqual(['foreground', 'foreground']);
  });
});
