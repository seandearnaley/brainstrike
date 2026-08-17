import { describe, expect, it, vi } from 'vitest';
import { createCooperativeYieldController } from '../ordered-batch-map';

describe('createCooperativeYieldController', () => {
  it('yields only at the configured cadence after the time budget is exhausted', async () => {
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(4)
      .mockReturnValueOnce(6)
      .mockReturnValueOnce(8);
    const yieldControl = vi.fn(async () => undefined);
    const maybeYield = createCooperativeYieldController({
      checkEvery: 2,
      now,
      yieldAfterMs: 5,
      yieldControl,
    });

    await maybeYield();
    await maybeYield();
    await maybeYield();
    await maybeYield();
    await maybeYield();
    await maybeYield();

    expect(now).toHaveBeenCalledTimes(4);
    expect(yieldControl).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5])('rejects invalid check cadence %s', (checkEvery) => {
    expect(() =>
      createCooperativeYieldController({
        checkEvery,
        yieldAfterMs: 5,
      })
    ).toThrow('Yield check cadence must be a positive integer');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid time budget %s',
    (yieldAfterMs) => {
      expect(() =>
        createCooperativeYieldController({
          checkEvery: 1,
          yieldAfterMs,
        })
      ).toThrow('Yield time budget must be a finite non-negative number');
    }
  );

  it('uses a macrotask for the default yield', async () => {
    vi.useFakeTimers();
    const maybeYield = createCooperativeYieldController({
      checkEvery: 1,
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1),
      yieldAfterMs: 0,
    });

    const pendingYield = maybeYield();
    let settled = false;
    void pendingYield.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.runAllTimersAsync();
    await pendingYield;
    expect(settled).toBe(true);
    vi.useRealTimers();
  });
});
