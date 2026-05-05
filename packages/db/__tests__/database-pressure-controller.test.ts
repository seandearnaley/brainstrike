import { describe, expect, it, vi } from 'vitest';
import {
  createDatabasePressureController,
  getDatabasePressureWaitingReason,
} from '../src/database-pressure-controller';
import {
  createDatabaseWorkScheduler,
  type DatabaseWorkSchedulerSnapshot,
} from '../src/database-work-scheduler';

describe('DatabasePressureController', () => {
  it('grants a background permit immediately when foreground work is quiet', async () => {
    const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const controller = createDatabasePressureController({ scheduler });

    await expect(
      controller.waitForBackgroundPermit({ label: 'embedding claim' })
    ).resolves.toBeUndefined();

    expect(controller.getSnapshot()).toMatchObject({
      permitWaiting: false,
      permitYieldCount: 0,
      waitingLabel: null,
    });
  });

  it('waits while foreground work is running and resumes after the quiet window', async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      const scheduler = createDatabaseWorkScheduler({
        foregroundQuietMs: 25,
        now: () => now,
      });
      let releaseForeground: (() => void) | null = null;
      const foreground = scheduler.run(
        async () =>
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          }),
        { priority: 'foreground', label: 'hybrid search' }
      );
      await Promise.resolve();

      const controller = createDatabasePressureController({
        scheduler,
        now: () => now,
        pollMs: 5,
      });
      const permit = controller.waitForBackgroundPermit({ label: 'embedding claim' });
      await Promise.resolve();
      await Promise.resolve();

      expect(controller.getSnapshot()).toMatchObject({
        permitWaiting: true,
        permitYieldCount: 1,
        waitingLabel: 'embedding claim',
        waitingReason: 'foreground-running',
      });

      releaseForeground?.();
      await foreground;
      now += 24;
      await vi.advanceTimersByTimeAsync(24);

      expect(controller.getSnapshot().permitWaiting).toBe(true);

      now += 2;
      await vi.advanceTimersByTimeAsync(10);
      await expect(permit).resolves.toBeUndefined();
      expect(controller.getSnapshot()).toMatchObject({
        permitWaiting: false,
        waitingLabel: null,
        waitingReason: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('yields during recent foreground latency pressure and resumes when pressure ages out', async () => {
    let now = 10_001;
    const baseScheduler = createDatabaseWorkScheduler({
      foregroundQuietMs: 0,
      now: () => now,
    });
    const baseSnapshot = baseScheduler.getSnapshot();
    const listeners = new Set<(snapshot: DatabaseWorkSchedulerSnapshot) => void>();
    const snapshot = (): DatabaseWorkSchedulerSnapshot => ({
      ...baseSnapshot,
      lastCompletedAt: 10_000,
      lastForegroundAt: 10_000,
      snapshotAt: now,
      priorityStats: {
        ...baseSnapshot.priorityStats,
        foreground: {
          ...baseSnapshot.priorityStats.foreground,
          completed: 1,
          lastCompletedLabel: 'collection page',
          serviceP95Ms: 120,
        },
      },
    });

    const controller = createDatabasePressureController({
      foregroundPressureWindowMs: 500,
      foregroundServiceP95ThresholdMs: 50,
      now: () => now,
      pollMs: 1000,
      snapshotSource: {
        getSnapshot: snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    });

    const permit = controller.waitForBackgroundPermit({ label: 'embedding completion' });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      permitWaiting: true,
      waitingReason: 'foreground-latency',
    });

    now += 499;
    for (const listener of listeners) {
      listener(snapshot());
    }
    await Promise.resolve();
    expect(controller.getSnapshot().permitWaiting).toBe(true);

    now += 2;
    for (const listener of listeners) {
      listener(snapshot());
    }
    await expect(permit).resolves.toBeUndefined();
  });

  it('yields during recent normal-priority latency pressure and resumes when pressure ages out', async () => {
    let now = 10_001;
    const baseScheduler = createDatabaseWorkScheduler({
      foregroundQuietMs: 0,
      now: () => now,
    });
    const baseSnapshot = baseScheduler.getSnapshot();
    const listeners = new Set<(snapshot: DatabaseWorkSchedulerSnapshot) => void>();
    const snapshot = (): DatabaseWorkSchedulerSnapshot => ({
      ...baseSnapshot,
      lastCompletedAt: 10_000,
      lastNormalAt: 10_000,
      snapshotAt: now,
      priorityStats: {
        ...baseSnapshot.priorityStats,
        normal: {
          ...baseSnapshot.priorityStats.normal,
          completed: 1,
          lastCompletedLabel: 'collection count refresh',
          serviceP95Ms: 120,
        },
      },
    });

    const controller = createDatabasePressureController({
      foregroundPressureWindowMs: 500,
      foregroundServiceP95ThresholdMs: 50,
      now: () => now,
      pollMs: 1000,
      snapshotSource: {
        getSnapshot: snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    });

    const permit = controller.waitForBackgroundPermit({ label: 'embedding completion' });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      permitWaiting: true,
      waitingReason: 'normal-latency',
    });

    now += 501;
    for (const listener of listeners) {
      listener(snapshot());
    }
    await expect(permit).resolves.toBeUndefined();
  });

  it('treats the quiet-window boundary as active foreground pressure', () => {
    const now = 1050;
    const baseScheduler = createDatabaseWorkScheduler({
      foregroundQuietMs: 50,
      now: () => now,
    });
    const baseSnapshot = baseScheduler.getSnapshot();

    expect(
      getDatabasePressureWaitingReason(
        {
          ...baseSnapshot,
          lastForegroundAt: 1000,
          snapshotAt: now,
        },
        now
      )
    ).toBe('foreground-quiet-window');
  });

  it('reports normal-priority quiet-window pressure distinctly', () => {
    const now = 1050;
    const baseScheduler = createDatabaseWorkScheduler({
      foregroundQuietMs: 50,
      now: () => now,
    });
    const baseSnapshot = baseScheduler.getSnapshot();

    expect(
      getDatabasePressureWaitingReason(
        {
          ...baseSnapshot,
          lastNormalAt: 1000,
          snapshotAt: now,
        },
        now
      )
    ).toBe('normal-quiet-window');
  });

  it('does not let background completions extend stale foreground latency pressure', async () => {
    let now = 10_000;
    const baseScheduler = createDatabaseWorkScheduler({
      foregroundQuietMs: 0,
      now: () => now,
    });
    const baseSnapshot = baseScheduler.getSnapshot();
    const listeners = new Set<(snapshot: DatabaseWorkSchedulerSnapshot) => void>();
    const snapshot = (): DatabaseWorkSchedulerSnapshot => ({
      ...baseSnapshot,
      lastCompletedAt: now,
      lastForegroundAt: 9000,
      snapshotAt: now,
      priorityStats: {
        ...baseSnapshot.priorityStats,
        background: {
          ...baseSnapshot.priorityStats.background,
          completed: 128,
          lastCompletedLabel: 'backfill queue capacity',
        },
        foreground: {
          ...baseSnapshot.priorityStats.foreground,
          completed: 1,
          lastCompletedLabel: 'collection page',
          serviceP95Ms: 120,
        },
      },
    });

    const controller = createDatabasePressureController({
      foregroundPressureWindowMs: 500,
      foregroundServiceP95ThresholdMs: 50,
      now: () => now,
      pollMs: 1000,
      snapshotSource: {
        getSnapshot: snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    });

    await expect(
      controller.waitForBackgroundPermit({ label: 'embedding claim' })
    ).resolves.toBeUndefined();
    expect(controller.getSnapshot()).toMatchObject({
      permitWaiting: false,
      permitYieldCount: 0,
    });

    now += 100;
    for (const listener of listeners) {
      listener(snapshot());
    }
    await expect(
      controller.waitForBackgroundPermit({ label: 'embedding completion' })
    ).resolves.toBeUndefined();
  });

  it('rejects a pending permit when aborted', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 25 });
      let releaseForeground: (() => void) | null = null;
      const foreground = scheduler.run(
        async () =>
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          }),
        { priority: 'foreground', label: 'collection page' }
      );
      await Promise.resolve();

      const controller = createDatabasePressureController({ scheduler, pollMs: 5 });
      const abortController = new AbortController();
      const permit = controller.waitForBackgroundPermit({
        label: 'embedding claim',
        signal: abortController.signal,
      });
      await Promise.resolve();
      await Promise.resolve();

      abortController.abort();
      await expect(permit).rejects.toThrow('Background database permit aborted');

      releaseForeground?.();
      await foreground;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects permits when scheduler snapshots cannot be read', async () => {
    const controller = createDatabasePressureController({
      snapshotSource: {
        getSnapshot: async () => {
          throw new Error('scheduler unavailable');
        },
      },
    });

    await expect(controller.waitForBackgroundPermit({ label: 'embedding claim' })).rejects.toThrow(
      'scheduler unavailable'
    );
    expect(controller.getSnapshot()).toMatchObject({
      permitWaiting: false,
      waitingLabel: null,
      waitingReason: null,
    });
  });

  it('ignores queued subscription checks after a permit has already rejected', async () => {
    const baseScheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
    const baseSnapshot = baseScheduler.getSnapshot();
    let reads = 0;
    let listener: (() => void) | null = null;
    const controller = createDatabasePressureController({
      snapshotSource: {
        getSnapshot: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              ...baseSnapshot,
              runningPriority: 'foreground',
            };
          }
          throw new Error('scheduler unavailable');
        },
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = null;
          };
        },
      },
    });

    const permit = controller.waitForBackgroundPermit({ label: 'embedding claim' });
    await Promise.resolve();
    await Promise.resolve();
    const queuedListener = listener;
    listener?.();
    await expect(permit).rejects.toThrow('scheduler unavailable');

    queuedListener?.();
    await Promise.resolve();

    expect(reads).toBe(2);
  });

  it('clears the pending poll timer when a subscription refresh runs first', async () => {
    vi.useFakeTimers();
    try {
      const baseScheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
      const baseSnapshot = baseScheduler.getSnapshot();
      const listeners = new Set<(snapshot: DatabaseWorkSchedulerSnapshot) => void>();
      let reads = 0;
      const snapshot = (): DatabaseWorkSchedulerSnapshot => {
        reads += 1;
        return {
          ...baseSnapshot,
          runningPriority: 'foreground',
        };
      };
      const controller = createDatabasePressureController({
        pollMs: 10,
        snapshotSource: {
          getSnapshot: snapshot,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
      });
      const abortController = new AbortController();
      const permit = controller.waitForBackgroundPermit({
        label: 'embedding claim',
        signal: abortController.signal,
      });
      await Promise.resolve();
      await Promise.resolve();

      for (const listener of listeners) {
        listener(snapshot());
      }
      await Promise.resolve();
      await Promise.resolve();
      const readsAfterSubscription = reads;

      await vi.advanceTimersByTimeAsync(9);
      expect(reads).toBe(readsAfterSubscription);

      await vi.advanceTimersByTimeAsync(1);
      expect(reads).toBe(readsAfterSubscription + 1);

      abortController.abort();
      await expect(permit).rejects.toThrow('Background database permit aborted');
    } finally {
      vi.useRealTimers();
    }
  });
});
