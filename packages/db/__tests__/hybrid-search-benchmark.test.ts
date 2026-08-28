import { describe, expect, it, vi } from 'vitest';
import { runHybridSearchBenchmark } from '../src/search/hybrid-search-benchmark.js';

interface DeterministicTask {
  readonly advance: (durationMs: number) => Promise<void>;
  readonly now: () => number;
}

function createDeterministicTask(): DeterministicTask {
  let currentTime = 0;
  return {
    advance: async (durationMs: number) => {
      currentTime += durationMs;
    },
    now: () => currentTime,
  };
}

describe('runHybridSearchBenchmark', () => {
  it('measures paired vector-only and hybrid samples after warmup', async () => {
    const clock = createDeterministicTask();
    const runHybrid = vi.fn(async () => clock.advance(75));
    const runVectorOnly = vi.fn(async () => clock.advance(20));

    const report = await runHybridSearchBenchmark({
      iterations: 4,
      now: clock.now,
      runHybrid,
      runVectorOnly,
      thresholds: {
        maxAdditionalP95Ms: 100,
        maxHybridP95Ms: 500,
      },
      warmupIterations: 2,
    });

    expect(runHybrid).toHaveBeenCalledTimes(6);
    expect(runVectorOnly).toHaveBeenCalledTimes(6);
    expect(report).toEqual({
      additionalLatency: { p50Ms: 55, p95Ms: 55, samplesMs: [55, 55, 55, 55] },
      failures: [],
      hybridLatency: { p50Ms: 75, p95Ms: 75, samplesMs: [75, 75, 75, 75] },
      iterations: 4,
      passed: true,
      thresholds: {
        maxAdditionalP95Ms: 100,
        maxHybridP95Ms: 500,
      },
      vectorOnlyLatency: { p50Ms: 20, p95Ms: 20, samplesMs: [20, 20, 20, 20] },
      warmupIterations: 2,
    });
  });

  it('reports each breached performance target without hiding samples', async () => {
    const clock = createDeterministicTask();

    const report = await runHybridSearchBenchmark({
      iterations: 2,
      now: clock.now,
      runHybrid: async () => clock.advance(620),
      runVectorOnly: async () => clock.advance(300),
      thresholds: {
        maxAdditionalP95Ms: 100,
        maxHybridP95Ms: 500,
      },
      warmupIterations: 0,
    });

    expect(report.passed).toBe(false);
    expect(report.failures).toEqual([
      'hybrid p95 620.000ms exceeds 500.000ms',
      'additional p95 320.000ms exceeds 100.000ms',
    ]);
    expect(report.hybridLatency.samplesMs).toEqual([620, 620]);
    expect(report.vectorOnlyLatency.samplesMs).toEqual([300, 300]);
  });

  it.each([
    { iterations: 0, warmupIterations: 0 },
    { iterations: 1.5, warmupIterations: 0 },
    { iterations: 1, warmupIterations: -1 },
    { iterations: 1, warmupIterations: 0.5 },
  ])('fails fast for invalid run counts: %o', async ({ iterations, warmupIterations }) => {
    await expect(
      runHybridSearchBenchmark({
        iterations,
        runHybrid: async () => {},
        runVectorOnly: async () => {},
        thresholds: {
          maxAdditionalP95Ms: 100,
          maxHybridP95Ms: 500,
        },
        warmupIterations,
      })
    ).rejects.toThrow();
  });

  it.each([
    { maxAdditionalP95Ms: 0, maxHybridP95Ms: 500 },
    { maxAdditionalP95Ms: 100, maxHybridP95Ms: Number.NaN },
    { maxAdditionalP95Ms: Number.POSITIVE_INFINITY, maxHybridP95Ms: 500 },
  ])('fails fast for invalid thresholds: %o', async (thresholds) => {
    await expect(
      runHybridSearchBenchmark({
        iterations: 1,
        runHybrid: async () => {},
        runVectorOnly: async () => {},
        thresholds,
        warmupIterations: 0,
      })
    ).rejects.toThrow();
  });
});
