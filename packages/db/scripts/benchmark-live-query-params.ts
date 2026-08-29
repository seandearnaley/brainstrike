import {
  LIVE_QUERY_PARAM_BENCHMARK_SCENARIOS,
  runLiveQueryParamBenchmark,
} from './live-query-params-benchmark.js';

const results = runLiveQueryParamBenchmark({
  iterations: 100_000,
  samples: 10,
  scenarios: LIVE_QUERY_PARAM_BENCHMARK_SCENARIOS,
  warmupIterations: 10_000,
});

process.stdout.write(
  `${JSON.stringify(
    {
      environment: {
        architecture: process.arch,
        node: process.version,
        platform: process.platform,
      },
      ratioMeaning: 'currentToLegacyRatio < 1 means the current JSON-key strategy is faster',
      results,
    },
    null,
    2
  )}\n`
);
