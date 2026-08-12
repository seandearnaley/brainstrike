import { describe, expect, it, vi } from 'vitest';
import { createDatabaseWorkScheduler } from '../src/database-work-scheduler';

describe('DatabaseWorkScheduler background fairness', () => {
  it('restarts the starvation clock at each contended background admission', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createDatabaseWorkScheduler({
        backgroundStarvationMs: 100,
        foregroundQuietMs: 50,
      });
      const events: string[] = [];
      let releaseFirstBackground: (() => void) | null = null;
      let releaseSecondBackground: (() => void) | null = null;
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
          events.push('background-2-start');
          await new Promise<void>((resolve) => {
            releaseSecondBackground = resolve;
          });
          events.push('background-2-end');
        },
        { priority: 'background' }
      );
      const thirdBackground = scheduler.run(
        async () => {
          events.push('background-3');
        },
        { priority: 'background' }
      );

      await vi.advanceTimersByTimeAsync(100);
      if (!releaseFirstBackground) {
        throw new Error('Expected first background task to start.');
      }
      releaseFirstBackground();
      await firstBackground;
      await vi.advanceTimersByTimeAsync(100);
      if (!releaseSecondBackground) {
        throw new Error('Expected second background task to start.');
      }
      releaseSecondBackground();
      await secondBackground;
      await thirdBackground;
      await foreground;

      expect(events).toEqual([
        'background-1-start',
        'background-1-end',
        'background-2-start',
        'background-2-end',
        'background-3',
        'foreground',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
