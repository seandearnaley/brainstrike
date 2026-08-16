import { describe, expect, it, vi } from 'vitest';
import { createDatabaseWorkScheduler } from '../src/database-work-scheduler';
import {
  createLiveQueryDrainRegistry,
  createResetBarrierDatabaseWork,
  waitForDatabaseWorkSchedulerIdle,
} from '../src/db-reset-drain';

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('waitForDatabaseWorkSchedulerIdle', () => {
  it('resolves immediately when the scheduler is already idle', async () => {
    const scheduler = createDatabaseWorkScheduler();
    await expect(waitForDatabaseWorkSchedulerIdle(scheduler, 1000)).resolves.toBeUndefined();
  });

  it('resolves only after in-flight work settles', async () => {
    const scheduler = createDatabaseWorkScheduler();
    const gate = createDeferred();
    const work = scheduler.run(async () => await gate.promise, {
      label: 'pending',
      priority: 'foreground',
    });

    let idle = false;
    const idlePromise = waitForDatabaseWorkSchedulerIdle(scheduler, 1000).then(() => {
      idle = true;
    });
    await flushMicrotasks();
    expect(idle).toBe(false);

    gate.resolve();
    await work;
    await idlePromise;
    expect(idle).toBe(true);
  });

  it('rejects loudly when work never drains within the timeout', async () => {
    const scheduler = createDatabaseWorkScheduler();
    const gate = createDeferred();
    const work = scheduler.run(async () => await gate.promise, {
      label: 'stuck',
      priority: 'foreground',
    });

    await expect(waitForDatabaseWorkSchedulerIdle(scheduler, 25)).rejects.toThrow(
      /did not become idle within 25ms/
    );

    gate.resolve();
    await work;
  });
});

describe('createResetBarrierDatabaseWork', () => {
  it('delegates run/getSnapshot/subscribe when no barrier is active', async () => {
    const { scheduler } = createResetBarrierDatabaseWork(createDatabaseWorkScheduler());
    await expect(
      scheduler.run(async () => 'ok', { label: 'plain', priority: 'foreground' })
    ).resolves.toBe('ok');
    expect(scheduler.getSnapshot().runningPriority).toBeNull();
  });

  it('holds new submissions behind an active reset barrier', async () => {
    const { runWithResetBarrier, scheduler } = createResetBarrierDatabaseWork(
      createDatabaseWorkScheduler()
    );
    const barrierGate = createDeferred();
    const order: string[] = [];

    const barrierRun = runWithResetBarrier(async () => {
      order.push('barrier-start');
      await barrierGate.promise;
      order.push('barrier-end');
    });
    await flushMicrotasks();

    const submission = scheduler
      .run(
        async () => {
          order.push('work');
        },
        { label: 'blocked', priority: 'foreground' }
      )
      .then(() => order.push('work-settled'));
    await flushMicrotasks();
    expect(order).toEqual(['barrier-start']);

    barrierGate.resolve();
    await barrierRun;
    await submission;
    expect(order).toEqual(['barrier-start', 'barrier-end', 'work', 'work-settled']);
  });

  it('rejects a second concurrent barrier and re-arms after release', async () => {
    const { runWithResetBarrier } = createResetBarrierDatabaseWork(createDatabaseWorkScheduler());
    const gate = createDeferred();
    const first = runWithResetBarrier(async () => await gate.promise);

    await expect(runWithResetBarrier(async () => undefined)).rejects.toThrow(
      'Database reset barrier is already active.'
    );

    gate.resolve();
    await first;
    await expect(runWithResetBarrier(async () => 'again')).resolves.toBe('again');
  });

  it('releases the barrier when the operation throws', async () => {
    const { runWithResetBarrier, scheduler } = createResetBarrierDatabaseWork(
      createDatabaseWorkScheduler()
    );
    await expect(
      runWithResetBarrier(async () => {
        throw new Error('reset failed');
      })
    ).rejects.toThrow('reset failed');
    // The barrier must not survive a failed reset: submissions run normally.
    await expect(
      scheduler.run(async () => 'after', { label: 'after', priority: 'foreground' })
    ).resolves.toBe('after');
  });
});

describe('createLiveQueryDrainRegistry', () => {
  it('unsubscribes every registered handle exactly once', async () => {
    const registry = createLiveQueryDrainRegistry();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    registry.register(first);
    registry.register(second);
    expect(registry.size()).toBe(2);

    await registry.unsubscribeAll();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);

    // A second drain finds nothing left to unsubscribe.
    await registry.unsubscribeAll();
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a registration unsubscribed by both its owner and the drain', async () => {
    const registry = createLiveQueryDrainRegistry();
    const unsubscribe = vi.fn(async () => undefined);
    const registration = registry.register(unsubscribe);

    const owned = registration.unsubscribe();
    const drained = registration.unsubscribe();
    expect(drained).toBe(owned);
    await Promise.all([owned, registry.unsubscribeAll()]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('awaits in-flight owner-initiated unsubscribes during a drain', async () => {
    const registry = createLiveQueryDrainRegistry();
    const gate = createDeferred();
    let settled = false;
    const registration = registry.register(async () => {
      await gate.promise;
      settled = true;
    });

    void registration.unsubscribe();
    let drained = false;
    const drain = registry.unsubscribeAll().then(() => {
      drained = true;
    });
    await flushMicrotasks();
    expect(drained).toBe(false);

    gate.resolve();
    await drain;
    expect(settled).toBe(true);
    expect(drained).toBe(true);
  });

  it('surfaces unsubscribe failures without aborting the drain', async () => {
    const registry = createLiveQueryDrainRegistry();
    const failing = vi.fn(async () => {
      throw new Error('unsubscribe exploded');
    });
    const healthy = vi.fn(async () => undefined);
    registry.register(failing);
    registry.register(healthy);

    await expect(registry.unsubscribeAll()).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
