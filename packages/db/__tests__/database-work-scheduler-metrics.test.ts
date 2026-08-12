import { describe, expect, it } from 'vitest';
import { createDatabaseWorkScheduler } from '../src/database-work-scheduler';

describe('DatabaseWorkScheduler metrics', () => {
  it('tracks rolling wait and service metrics by priority', async () => {
    const waits = [3, 9, 20, 40];
    const services = [7, 11, 13, 17];
    let now = 100;
    const scheduler = createDatabaseWorkScheduler({
      elapsedNow: () => now,
      foregroundQuietMs: 0,
      now: () => now,
    });
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
        { label: `embedding batch ${index + 1}`, priority: 'background' }
      );
      now = scheduledAt + waitMs;
      await run;
      now += 1;
    }

    expect(scheduler.getSnapshot().priorityStats.background).toMatchObject({
      completed: 4,
      lastCompletedLabel: 'embedding batch 4',
      lastStartedLabel: 'embedding batch 4',
      longestWaitMs: 40,
      serviceP50Ms: 11,
      serviceP95Ms: 17,
      totalServiceMs: 48,
      totalWaitMs: 72,
      waitP50Ms: 9,
      waitP95Ms: 40,
    });
  });

  it('measures wait and service samples independently of wall-clock corrections', async () => {
    let elapsedNow = 0;
    let wallNow = 1000;
    const scheduler = createDatabaseWorkScheduler({
      elapsedNow: () => elapsedNow,
      foregroundQuietMs: 0,
      now: () => wallNow,
    });
    const foreground = scheduler.run(
      async () => {
        elapsedNow = 30;
        wallNow = -10_000;
      },
      { label: 'clock-corrected query', priority: 'foreground' }
    );

    elapsedNow = 20;
    wallNow = 50_000;
    await foreground;

    expect(scheduler.getSnapshot().priorityStats.foreground).toMatchObject({
      serviceP95Ms: 10,
      totalServiceMs: 10,
      totalWaitMs: 20,
      waitP95Ms: 20,
    });
  });

  it('keeps rolling metric percentiles bounded to the latest sample window', async () => {
    let now = 0;
    const scheduler = createDatabaseWorkScheduler({
      elapsedNow: () => now,
      foregroundQuietMs: 0,
      now: () => now,
    });

    for (let waitMs = 1; waitMs <= 65; waitMs += 1) {
      const scheduledAt = now;
      const run = scheduler.run(
        async () => {
          now += 1;
        },
        { label: `embedding batch ${waitMs}`, priority: 'background' }
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
});
