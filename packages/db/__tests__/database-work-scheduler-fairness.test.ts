import { describe, expect, it, vi } from 'vitest';
import { createDatabaseWorkScheduler } from '../src/database-work-scheduler';

describe('DatabaseWorkScheduler background fairness', () => {
  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects an invalid background starvation bound (%s)',
    (backgroundStarvationMs) => {
      expect(() => createDatabaseWorkScheduler({ backgroundStarvationMs })).toThrow(
        'DatabaseWorkScheduler backgroundStarvationMs must be a positive finite number.'
      );
    }
  );

  it.each([-1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects an invalid foreground quiet window (%s)',
    (foregroundQuietMs) => {
      expect(() => createDatabaseWorkScheduler({ foregroundQuietMs })).toThrow(
        'DatabaseWorkScheduler foregroundQuietMs must be a non-negative finite number.'
      );
    }
  );

  it('keeps the starvation bound when the diagnostic wall clock moves backward', async () => {
    vi.useFakeTimers();
    try {
      let elapsedNow = 0;
      let wallNow = 1000;
      const scheduler = createDatabaseWorkScheduler({
        backgroundStarvationMs: 100,
        elapsedNow: () => elapsedNow,
        foregroundQuietMs: 50,
        now: () => wallNow,
      });
      const events: string[] = [];
      let releaseForeground: (() => void) | null = null;
      const foreground = scheduler.run(
        async () => {
          events.push('foreground');
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          });
        },
        { priority: 'foreground' }
      );
      await vi.advanceTimersByTimeAsync(0);

      const background = scheduler.run(
        async () => {
          events.push('background');
        },
        { priority: 'background' }
      );
      elapsedNow = 100;
      wallNow = 0;
      if (!releaseForeground) {
        throw new Error('Expected foreground work to start.');
      }
      releaseForeground();
      await foreground;
      await vi.advanceTimersByTimeAsync(0);

      expect(events).toEqual(['foreground', 'background']);
      await background;
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns to foreground-first ordering after each forced background admission', async () => {
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
        'foreground',
        'background-3',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives foreground the next turn when it arrives during a forced background task', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createDatabaseWorkScheduler({
        backgroundStarvationMs: 100,
        foregroundQuietMs: 50,
      });
      const events: string[] = [];
      let releaseInitialForeground: (() => void) | null = null;
      let releaseFirstBackground: (() => void) | null = null;
      const initialForeground = scheduler.run(
        async () => {
          events.push('foreground-1-start');
          await new Promise<void>((resolve) => {
            releaseInitialForeground = resolve;
          });
          events.push('foreground-1-end');
        },
        { priority: 'foreground' }
      );
      await vi.advanceTimersByTimeAsync(0);

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
      const secondBackground = scheduler.run(
        async () => {
          events.push('background-2');
        },
        { priority: 'background' }
      );

      await vi.advanceTimersByTimeAsync(100);
      if (!releaseInitialForeground) {
        throw new Error('Expected the initial foreground task to start.');
      }
      releaseInitialForeground();
      await initialForeground;
      await vi.advanceTimersByTimeAsync(0);
      if (!releaseFirstBackground) {
        throw new Error('Expected the first background task to be force-admitted.');
      }

      const lateForeground = scheduler.run(
        async () => {
          events.push('foreground-2');
        },
        { priority: 'foreground' }
      );
      await vi.advanceTimersByTimeAsync(100);
      releaseFirstBackground();

      await Promise.all([firstBackground, secondBackground, lateForeground]);
      expect(events).toEqual([
        'foreground-1-start',
        'foreground-1-end',
        'background-1-start',
        'background-1-end',
        'foreground-2',
        'background-2',
      ]);
      expect(scheduler.getSnapshot()).toMatchObject({
        forcedBackgroundAdmissionCount: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the forced-admission interlock when the scheduler drains to idle', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createDatabaseWorkScheduler({
        backgroundStarvationMs: 100,
        foregroundQuietMs: 50,
      });
      const events: string[] = [];
      let releaseInitialForeground: (() => void) | null = null;
      const initialForeground = scheduler.run(
        async () => {
          events.push('foreground-1-start');
          await new Promise<void>((resolve) => {
            releaseInitialForeground = resolve;
          });
          events.push('foreground-1-end');
        },
        { priority: 'foreground' }
      );
      await vi.advanceTimersByTimeAsync(0);

      const forcedBackground = scheduler.run(
        async () => {
          events.push('background-1');
        },
        { priority: 'background' }
      );
      await vi.advanceTimersByTimeAsync(100);
      if (!releaseInitialForeground) {
        throw new Error('Expected the initial foreground task to start.');
      }
      releaseInitialForeground();
      await Promise.all([initialForeground, forcedBackground]);
      await vi.advanceTimersByTimeAsync(0);

      let releaseRunningBackground: (() => void) | null = null;
      const runningBackground = scheduler.run(
        async () => {
          events.push('background-2-start');
          await new Promise<void>((resolve) => {
            releaseRunningBackground = resolve;
          });
          events.push('background-2-end');
        },
        { priority: 'background' }
      );
      await vi.advanceTimersByTimeAsync(0);

      const waitingBackground = scheduler.run(
        async () => {
          events.push('background-3');
        },
        { priority: 'background' }
      );
      const nextForeground = scheduler.run(
        async () => {
          events.push('foreground-2');
        },
        { priority: 'foreground' }
      );
      await vi.advanceTimersByTimeAsync(100);
      if (!releaseRunningBackground) {
        throw new Error('Expected the second background task to start.');
      }
      releaseRunningBackground();

      await Promise.all([runningBackground, waitingBackground, nextForeground]);
      expect(events).toEqual([
        'foreground-1-start',
        'foreground-1-end',
        'background-1',
        'background-2-start',
        'background-2-end',
        'background-3',
        'foreground-2',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
