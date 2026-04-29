import { describe, expect, it, vi } from 'vitest';
import { createDatabasePressureController } from '../src/database-pressure-controller';
import {
  createDatabaseWorkScheduler,
  createScheduledDbHandle,
} from '../src/database-work-scheduler';

describe('foreground database responsiveness smoke', () => {
  it('lets foreground database work run while background indexing waits for a permit', async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      const scheduler = createDatabaseWorkScheduler({
        foregroundQuietMs: 50,
        now: () => now,
      });
      const rawDb = {
        query: vi.fn(async <T = unknown>(sql: string) => ({
          rows: [{ sql }] as T[],
        })),
      };
      const foregroundDb = createScheduledDbHandle(rawDb, scheduler, 'foreground');
      const controller = createDatabasePressureController({
        now: () => now,
        pollMs: 5,
        scheduler,
      });

      await foregroundDb.query('SELECT initial foreground', [], {
        label: 'collection page',
        priority: 'foreground',
      });

      const permit = controller.waitForBackgroundPermit({ label: 'embedding claim' });
      await Promise.resolve();
      await Promise.resolve();

      expect(controller.getSnapshot()).toMatchObject({
        permitWaiting: true,
        waitingReason: 'foreground-quiet-window',
      });

      await foregroundDb.query('SELECT user paging', [], {
        label: 'collection page next',
        priority: 'foreground',
      });
      expect(rawDb.query).toHaveBeenLastCalledWith('SELECT user paging', []);

      now += 50;
      await vi.advanceTimersByTimeAsync(50);
      expect(controller.getSnapshot().permitWaiting).toBe(true);

      now += 1;
      await vi.advanceTimersByTimeAsync(5);
      await expect(permit).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
