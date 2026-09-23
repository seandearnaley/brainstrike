import { describe, expect, it } from 'vitest';
import { DelegatedWorkQueue } from '../delegated-work-budget';

/** Settles whatever is already runnable, then reports which acquisitions resolved. */
async function granted(acquisitions: readonly Promise<() => void>[]): Promise<boolean[]> {
  const state = acquisitions.map(() => false);
  acquisitions.forEach((acquisition, index) => {
    void acquisition.then(() => {
      state[index] = true;
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return state;
}

describe('DelegatedWorkQueue', () => {
  it.each([1, 3])(
    "runs at most the request's maxConcurrentWork (%i) operations, first come first served",
    async (limit) => {
      const queue = new DelegatedWorkQueue(limit);
      const acquisitions = Array.from({ length: limit + 1 }, () => queue.acquire());
      expect(await granted(acquisitions)).toEqual([
        ...Array.from({ length: limit }, () => true),
        false,
      ]);
      const release = await acquisitions[0];
      release?.();
      expect(await granted(acquisitions)).toEqual(acquisitions.map(() => true));
    }
  );

  it.each([0, -1, 1.5, Number.NaN])('refuses a limit (%s) that would never run work', (limit) => {
    expect(() => new DelegatedWorkQueue(limit)).toThrow(
      `Delegated work concurrency must be a positive integer; received ${limit}.`
    );
  });
});
