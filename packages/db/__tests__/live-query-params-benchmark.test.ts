import { describe, expect, it } from 'vitest';
import {
  LIVE_QUERY_PARAM_BENCHMARK_SCENARIOS,
  runLiveQueryParamBenchmark,
} from '../src/live-query-params-benchmark.js';

describe('live-query parameter benchmark', () => {
  it('measures the required primitive, array, and object parameter shapes', () => {
    const results = runLiveQueryParamBenchmark({
      iterations: 2,
      now: (() => {
        let tick = 0;
        return () => {
          tick += 1;
          return tick;
        };
      })(),
      samples: 3,
      scenarios: LIVE_QUERY_PARAM_BENCHMARK_SCENARIOS,
      warmupIterations: 1,
    });

    expect(results.map((result) => result.name)).toEqual(['primitive', 'array', 'complex-object']);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentJsonMedianMs: expect.any(Number),
          currentToLegacyRatio: expect.any(Number),
          iterations: 2,
          legacyDeepEqualMedianMs: expect.any(Number),
          samples: 3,
        }),
      ])
    );
  });

  it('rejects invalid iteration counts instead of producing misleading evidence', () => {
    expect(() =>
      runLiveQueryParamBenchmark({
        iterations: 0,
        samples: 1,
        scenarios: LIVE_QUERY_PARAM_BENCHMARK_SCENARIOS,
        warmupIterations: 1,
      })
    ).toThrow('Live-query benchmark iterations must be a positive integer');
  });
});
