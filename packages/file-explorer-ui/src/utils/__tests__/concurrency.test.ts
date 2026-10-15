// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { runWithConcurrency } from '../concurrency';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('runWithConcurrency', () => {
  it('should process all items and return results in order', async () => {
    const items = [1, 2, 3, 4, 5];
    const fn = vi.fn(async (item: number) => item * 2);

    const results = await runWithConcurrency(items, 3, fn);

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('should respect concurrency limit', async () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const concurrentCalls: number[] = [];
    let activeCalls = 0;

    const fn = async (item: string) => {
      activeCalls++;
      concurrentCalls.push(activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeCalls--;
      return item.toUpperCase();
    };

    const results = await runWithConcurrency(items, 2, fn);

    expect(results).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    // Max concurrent calls should never exceed concurrency limit
    expect(Math.max(...concurrentCalls)).toBeLessThanOrEqual(2);
  });

  it('should handle empty array', async () => {
    const fn = vi.fn(async (item: number) => item * 2);

    const results = await runWithConcurrency([], 5, fn);

    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('should handle array smaller than concurrency limit', async () => {
    const items = [1, 2];
    const fn = vi.fn(async (item: number) => item * 2);

    const results = await runWithConcurrency(items, 10, fn);

    expect(results).toEqual([2, 4]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should handle concurrency of 1 (sequential)', async () => {
    const items = [1, 2, 3];
    const callOrder: number[] = [];

    const fn = async (item: number) => {
      callOrder.push(item);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return item * 2;
    };

    const results = await runWithConcurrency(items, 1, fn);

    expect(results).toEqual([2, 4, 6]);
    expect(callOrder).toEqual([1, 2, 3]);
  });

  it('should drain started peers before rejecting and stop assigning new work after an error', async () => {
    const items = [1, 2, 3];
    const held = createDeferred();
    const fn = vi.fn(async (item: number) => {
      if (item === 1) {
        await held.promise;
      }
      if (item === 2) {
        throw new Error('Error on item 2');
      }
      return item * 2;
    });
    let settlement: 'pending' | 'rejected' | 'resolved' = 'pending';
    const result = runWithConcurrency(items, 2, fn);
    void result.then(
      () => {
        settlement = 'resolved';
      },
      () => {
        settlement = 'rejected';
      }
    );

    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(settlement).toBe('pending');
    expect(fn).toHaveBeenCalledTimes(2);

    held.resolve();
    await expect(result).rejects.toThrow('Error on item 2');
    expect(settlement).toBe('rejected');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should give the next item to a free worker without waiting for a held peer', async () => {
    const held = createDeferred();
    const released = createDeferred();
    const fn = vi.fn(async (item: number) => {
      if (item === 1) {
        await held.promise;
      }
      if (item === 2) {
        await released.promise;
      }
      return item;
    });

    const result = runWithConcurrency([1, 2, 3], 2, fn);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    released.resolve();
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(3));

    expect(fn.mock.calls[2]?.[0]).toBe(3);
    held.resolve();

    await expect(result).resolves.toEqual([1, 2, 3]);
  });
});
