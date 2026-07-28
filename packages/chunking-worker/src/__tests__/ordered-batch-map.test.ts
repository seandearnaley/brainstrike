import { describe, expect, it, vi } from 'vitest';
import { mapInOrderedBatches } from '../ordered-batch-map';

describe('mapInOrderedBatches', () => {
  it('bounds concurrent work and preserves input order', async () => {
    const completions: number[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let peakActive = 0;

    const resultPromise = mapInOrderedBatches([0, 1, 2, 3, 4], 2, async (value) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise<void>((resolve) => {
        releases[value] = resolve;
      });
      completions.push(value);
      active -= 1;
      return `value-${value}`;
    });

    expect(peakActive).toBe(2);
    releases[1]?.();
    releases[0]?.();
    await vi.waitFor(() => {
      expect(releases).toHaveLength(4);
    });
    releases[3]?.();
    releases[2]?.();
    await vi.waitFor(() => {
      expect(releases).toHaveLength(5);
    });
    releases[4]?.();

    expect(await resultPromise).toEqual(['value-0', 'value-1', 'value-2', 'value-3', 'value-4']);
    expect(completions).toEqual([1, 0, 3, 2, 4]);
  });

  it.each([0, -1, 1.5])('rejects invalid batch size %s', async (batchSize) => {
    await expect(mapInOrderedBatches([1], batchSize, async (value) => value)).rejects.toThrow(
      'Batch size must be a positive integer'
    );
  });
});
