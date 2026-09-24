import { describe, expect, it } from 'vitest';
import { createConcurrencyLimiter } from '../concurrency-limiter.js';

interface Gate {
  readonly open: () => void;
  readonly opened: Promise<void>;
}

const gate = (): Gate => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { open: () => resolve(), opened: promise };
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe('createConcurrencyLimiter', () => {
  it('never runs more tasks at once than it has permits', async () => {
    const limit = createConcurrencyLimiter(2);
    const gates = [gate(), gate(), gate(), gate()];
    let inFlight = 0;
    let peak = 0;

    const runs = gates.map((taskGate, index) =>
      limit(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await taskGate.opened;
        inFlight -= 1;
        return index;
      })
    );
    await settle();
    expect(inFlight).toBe(2);
    for (const taskGate of gates) {
      taskGate.open();
    }

    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('returns the permit when a task rejects and passes the rejection through', async () => {
    const limit = createConcurrencyLimiter(1);
    const failure = new Error('EACCES: permission denied');

    await expect(limit(() => Promise.reject(failure))).rejects.toBe(failure);
    await expect(limit(async () => 'next')).resolves.toBe('next');
  });

  it('drops a waiting task on abort without starting it and keeps serving others', async () => {
    const limit = createConcurrencyLimiter(1);
    const holder = gate();
    const controller = new AbortController();
    let waiterStarted = false;

    const holding = limit(() => holder.opened.then(() => 'held'));
    const waiting = limit(
      async () => {
        waiterStarted = true;
      },
      { signal: controller.signal }
    );
    await settle();
    controller.abort();

    await expect(waiting).rejects.toBe(controller.signal.reason);
    holder.open();
    await expect(holding).resolves.toBe('held');
    await expect(limit(async () => 'after')).resolves.toBe('after');
    expect(waiterStarted).toBe(false);
  });

  it('aborts the signal handed to a running task when the caller aborts', async () => {
    const limit = createConcurrencyLimiter(1);
    const controller = new AbortController();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<AbortSignal>();

    const running = limit(
      (signal) => {
        markStarted(signal);
        return new Promise<never>(() => undefined);
      },
      { signal: controller.signal }
    );
    const taskSignal = await started;
    controller.abort();

    await expect(running).rejects.toBe(controller.signal.reason);
    expect(taskSignal.aborted).toBe(true);
    await expect(limit(async () => 'freed')).resolves.toBe('freed');
  });

  it('does not guarantee FIFO: a task submitted as a permit frees can start ahead of an earlier waiter', async () => {
    // Pins the property the contract warns about (docs/agents/effect-boundary.md
    // § "Shared helpers"): never replace a FIFO mutex with this limiter.
    const limit = createConcurrencyLimiter(1);
    const holder = gate();
    const admitted: string[] = [];

    const first = limit(() => holder.opened).then(() =>
      limit(async () => {
        admitted.push('late');
      })
    );
    await settle();
    const waiting = limit(async () => {
      admitted.push('waiting');
    });
    await settle();
    holder.open();
    await Promise.all([first, waiting]);

    expect(admitted).toEqual(['late', 'waiting']);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects %s permits', (permits) => {
    expect(() => createConcurrencyLimiter(permits)).toThrow(RangeError);
  });
});
