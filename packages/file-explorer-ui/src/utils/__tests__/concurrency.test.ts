import { describe, expect, it, vi } from 'vitest';

import { runWithConcurrency } from '../concurrency';

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

  it('should propagate errors from the async function', async () => {
    const items = [1, 2, 3];
    const fn = async (item: number) => {
      if (item === 2) {
        throw new Error('Error on item 2');
      }
      return item * 2;
    };

    await expect(runWithConcurrency(items, 3, fn)).rejects.toThrow('Error on item 2');
  });

  it('should process chunks sequentially', async () => {
    const items = [1, 2, 3, 4, 5, 6];
    const chunkTimestamps: number[][] = [];
    let currentChunk: number[] = [];

    const fn = async (item: number) => {
      const now = Date.now();
      currentChunk.push(now);
      // When we complete a chunk, record it
      if (currentChunk.length === 2) {
        chunkTimestamps.push([...currentChunk]);
        currentChunk = [];
      }
      return item;
    };

    await runWithConcurrency(items, 2, fn);

    // Should have 3 chunks
    expect(chunkTimestamps.length).toBe(3);
  });
});
