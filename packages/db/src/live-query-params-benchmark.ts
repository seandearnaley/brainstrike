import { deepEqual } from './use-live-query.js';

export interface LiveQueryParamBenchmarkScenario {
  readonly createParams: () => readonly unknown[];
  readonly name: 'array' | 'complex-object' | 'primitive';
}

export interface LiveQueryParamBenchmarkResult {
  /** Median time for the current JSON-key comparison across all samples. */
  readonly currentJsonMedianMs: number;
  /** Current JSON-key median divided by the pre-#728 deep-equality median. */
  readonly currentToLegacyRatio: number;
  readonly iterations: number;
  /** Median time for the pre-#728 recursive deep-equality comparison. */
  readonly legacyDeepEqualMedianMs: number;
  readonly name: LiveQueryParamBenchmarkScenario['name'];
  readonly samples: number;
}

export interface RunLiveQueryParamBenchmarkOptions {
  readonly iterations: number;
  readonly now?: () => number;
  readonly samples: number;
  readonly scenarios: readonly LiveQueryParamBenchmarkScenario[];
  readonly warmupIterations: number;
}

export const LIVE_QUERY_PARAM_BENCHMARK_SCENARIOS: readonly LiveQueryParamBenchmarkScenario[] = [
  {
    createParams: () => [42],
    name: 'primitive',
  },
  {
    createParams: () => [[1, 2, 3, 4, 5, 6, 7, 8]],
    name: 'array',
  },
  {
    createParams: () => [
      {
        filters: {
          extensions: ['ts', 'tsx', 'md'],
          includeHidden: false,
          roots: ['workspace-a', 'workspace-b'],
        },
        page: 3,
        sort: { direction: 'desc', field: 'updatedAt' },
      },
    ],
    name: 'complex-object',
  },
] as const;

function assertPositiveInteger(value: number, label: string): void {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!(Number.isInteger(value) && value >= 0)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measureCurrentJsonStrategy(
  scenario: LiveQueryParamBenchmarkScenario,
  iterations: number,
  now: () => number
): number {
  let previous = scenario.createParams();
  let previousKey = JSON.stringify(previous);
  let equalCount = 0;
  const startedAt = now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = scenario.createParams();
    const nextKey = JSON.stringify(next);
    if (nextKey === previousKey) {
      equalCount += 1;
    } else {
      previous = next;
      previousKey = nextKey;
    }
  }

  const durationMs = now() - startedAt;
  if (equalCount !== iterations || previous.length === 0) {
    throw new Error(`Live-query JSON benchmark scenario "${scenario.name}" is not stable`);
  }
  return durationMs;
}

function measureLegacyDeepEqualStrategy(
  scenario: LiveQueryParamBenchmarkScenario,
  iterations: number,
  now: () => number
): number {
  let previous = scenario.createParams();
  let equalCount = 0;
  const startedAt = now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = scenario.createParams();
    if (deepEqual(next, previous)) {
      equalCount += 1;
    } else {
      previous = next;
    }
  }

  const durationMs = now() - startedAt;
  if (equalCount !== iterations || previous.length === 0) {
    throw new Error(`Live-query deep-equality benchmark scenario "${scenario.name}" is not stable`);
  }
  return durationMs;
}

export function runLiveQueryParamBenchmark({
  iterations,
  now = performance.now.bind(performance),
  samples,
  scenarios,
  warmupIterations,
}: RunLiveQueryParamBenchmarkOptions): LiveQueryParamBenchmarkResult[] {
  assertPositiveInteger(iterations, 'Live-query benchmark iterations');
  assertPositiveInteger(samples, 'Live-query benchmark samples');
  assertNonNegativeInteger(warmupIterations, 'Live-query benchmark warmup iterations');
  if (scenarios.length === 0) {
    throw new Error('Live-query benchmark requires at least one scenario');
  }

  return scenarios.map((scenario) => {
    if (warmupIterations > 0) {
      measureCurrentJsonStrategy(scenario, warmupIterations, now);
      measureLegacyDeepEqualStrategy(scenario, warmupIterations, now);
    }
    const currentSamples: number[] = [];
    const legacySamples: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      if (sample % 2 === 0) {
        currentSamples.push(measureCurrentJsonStrategy(scenario, iterations, now));
        legacySamples.push(measureLegacyDeepEqualStrategy(scenario, iterations, now));
      } else {
        legacySamples.push(measureLegacyDeepEqualStrategy(scenario, iterations, now));
        currentSamples.push(measureCurrentJsonStrategy(scenario, iterations, now));
      }
    }
    const currentJsonMedianMs = median(currentSamples);
    const legacyDeepEqualMedianMs = median(legacySamples);
    return {
      currentJsonMedianMs,
      currentToLegacyRatio: currentJsonMedianMs / Math.max(legacyDeepEqualMedianMs, Number.EPSILON),
      iterations,
      legacyDeepEqualMedianMs,
      name: scenario.name,
      samples,
    };
  });
}
