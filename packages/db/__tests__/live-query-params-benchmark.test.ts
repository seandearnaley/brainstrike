import { describe, expect, it } from 'vitest';
import {
  LIVE_QUERY_PARAM_BENCHMARK_SCENARIOS,
  type LiveQueryParamBenchmarkScenario,
  runLiveQueryParamBenchmark,
} from '../scripts/live-query-params-benchmark.js';

function createDurationClock(durations: readonly number[]): () => number {
  let call = 0;
  let elapsed = 0;
  return () => {
    if (call % 2 === 0) {
      call += 1;
      return elapsed;
    }
    const duration = durations[Math.floor(call / 2)];
    if (duration === undefined) {
      throw new Error('Benchmark test clock exhausted its duration queue.');
    }
    elapsed += duration;
    call += 1;
    return elapsed;
  };
}

const ONE_SCENARIO: readonly LiveQueryParamBenchmarkScenario[] = [
  { createParams: () => [42], name: 'custom' },
];

describe('live-query parameter benchmark', () => {
  it('measures every required shape and pins alternating-order medians and ratios', () => {
    const results = runLiveQueryParamBenchmark({
      iterations: 2,
      now: createDurationClock([10, 20, 40, 30, 50, 60, 2, 8, 10, 4, 6, 12, 9, 3, 5, 7, 11, 13]),
      samples: 3,
      scenarios: LIVE_QUERY_PARAM_BENCHMARK_SCENARIOS,
      warmupIterations: 0,
    });

    expect(results).toEqual([
      {
        currentJsonMedianMs: 30,
        currentToLegacyRatio: 0.75,
        iterations: 2,
        legacyDeepEqualMedianMs: 40,
        name: 'primitive',
        samples: 3,
      },
      {
        currentJsonMedianMs: 4,
        currentToLegacyRatio: 0.4,
        iterations: 2,
        legacyDeepEqualMedianMs: 10,
        name: 'array',
        samples: 3,
      },
      {
        currentJsonMedianMs: 9,
        currentToLegacyRatio: 1.8,
        iterations: 2,
        legacyDeepEqualMedianMs: 5,
        name: 'complex-object',
        samples: 3,
      },
    ]);
  });

  it('averages the middle measurements for an even sample count', () => {
    const [result] = runLiveQueryParamBenchmark({
      iterations: 1,
      now: createDurationClock([10, 40, 20, 30]),
      samples: 2,
      scenarios: ONE_SCENARIO,
      warmupIterations: 0,
    });

    expect(result?.currentJsonMedianMs).toBe(20);
    expect(result?.legacyDeepEqualMedianMs).toBe(30);
    expect(result?.currentToLegacyRatio).toBeCloseTo(2 / 3);
  });

  it.each([
    ['iterations', { iterations: 0, samples: 1, warmupIterations: 0 }, 'positive integer'],
    ['samples', { iterations: 1, samples: 0, warmupIterations: 0 }, 'positive integer'],
    [
      'warmup iterations',
      { iterations: 1, samples: 1, warmupIterations: -1 },
      'non-negative integer',
    ],
  ] as const)('rejects invalid %s', (_label, options, expected) => {
    expect(() =>
      runLiveQueryParamBenchmark({
        ...options,
        scenarios: ONE_SCENARIO,
      })
    ).toThrow(expected);
  });

  it('rejects an empty scenario matrix', () => {
    expect(() =>
      runLiveQueryParamBenchmark({
        iterations: 1,
        samples: 1,
        scenarios: [],
        warmupIterations: 0,
      })
    ).toThrow('Live-query benchmark requires at least one scenario');
  });

  it('rejects unstable equal-value scenarios', () => {
    let value = 0;
    expect(() =>
      runLiveQueryParamBenchmark({
        iterations: 2,
        now: createDurationClock([1, 1]),
        samples: 1,
        scenarios: [{ createParams: () => [value++], name: 'unstable' }],
        warmupIterations: 0,
      })
    ).toThrow('Live-query JSON benchmark scenario "unstable" is not stable');
  });

  it('measures stable scenarios with no bind parameters', () => {
    expect(
      runLiveQueryParamBenchmark({
        iterations: 2,
        now: createDurationClock([2, 1]),
        samples: 1,
        scenarios: [{ createParams: () => [], name: 'no-params' }],
        warmupIterations: 0,
      })
    ).toEqual([
      {
        currentJsonMedianMs: 2,
        currentToLegacyRatio: 2,
        iterations: 2,
        legacyDeepEqualMedianMs: 1,
        name: 'no-params',
        samples: 1,
      },
    ]);
  });

  it('rejects zero-duration medians instead of manufacturing a ratio', () => {
    expect(() =>
      runLiveQueryParamBenchmark({
        iterations: 1,
        now: () => 0,
        samples: 1,
        scenarios: ONE_SCENARIO,
        warmupIterations: 0,
      })
    ).toThrow(
      'Live-query benchmark scenario "custom" produced a zero-duration median; increase iterations'
    );
  });
});
