import { describe, expect, it, vi } from 'vitest';
import { createDatabasePressureController } from '../src/database-pressure-controller';
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
    let now = 10_000;
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
});
