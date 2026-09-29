import { describe, expect, it } from 'vitest';
import {
  PROCESS_COUNTER_RING_CAPACITY,
  ProcessCounterRing,
} from '../../diagnostics/process-counter-ring';

const sample = (index: number) => ({
  at: new Date(index * 30_000).toISOString(),
  backgroundTasks: { pending: 0, running: index, suspended: 0 },
  heapUsedKb: index,
  rssKb: index,
  wasm: { compile: 0, failures: 0, instance: 0, instantiate: index, memory: 0 },
  wasmRecentFailures: [],
});

describe('ProcessCounterRing', () => {
  it('keeps the newest samples up to capacity and clears on demand', () => {
    const ring = new ProcessCounterRing(3);
    for (let index = 0; index < 5; index += 1) {
      ring.push(sample(index));
    }
    expect(ring.list().map((entry) => entry.heapUsedKb)).toEqual([2, 3, 4]);
    ring.clear();
    expect(ring.list()).toEqual([]);
    expect(PROCESS_COUNTER_RING_CAPACITY).toBe(240);
  });

  it('returns a copy so callers cannot mutate the ring', () => {
    const ring = new ProcessCounterRing(2);
    ring.push(sample(0));
    const listed = ring.list();
    listed.length = 0;
    expect(ring.list()).toHaveLength(1);
  });

  it('rejects a non-positive or non-integer capacity', () => {
    expect(() => new ProcessCounterRing(0)).toThrow('capacity');
    expect(() => new ProcessCounterRing(-1)).toThrow('capacity');
    expect(() => new ProcessCounterRing(1.5)).toThrow('capacity');
    expect(() => new ProcessCounterRing(Number.NaN)).toThrow('capacity');
  });
});
