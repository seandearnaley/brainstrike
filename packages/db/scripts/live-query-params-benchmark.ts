export interface LiveQueryParamBenchmarkScenario {
  readonly createParams: () => readonly unknown[];
  readonly name: string;
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
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/*
 * Exact pre-PR #728 comparator from a801ed0c8e63be7065d2ff596bfd2a2e0aea8b7d.
 * Keep this snapshot local to the benchmark so later production changes cannot
 * silently rewrite the historical baseline.
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function areArraysDeepEqual(arrayA: readonly unknown[], arrayB: readonly unknown[]): boolean {
  if (arrayA.length !== arrayB.length) {
    return false;
  }
  for (let index = 0; index < arrayA.length; index += 1) {
    if (!historicalDeepEqual(arrayA[index], arrayB[index])) {
      return false;
    }
  }
  return true;
}

function areUint8ArraysEqual(arrayA: Uint8Array, arrayB: Uint8Array): boolean {
  if (arrayA.length !== arrayB.length) {
    return false;
  }
  for (let index = 0; index < arrayA.length; index += 1) {
    if (arrayA[index] !== arrayB[index]) {
      return false;
    }
  }
  return true;
}

function areObjectsDeepEqual(
  objectA: Record<string, unknown>,
  objectB: Record<string, unknown>
): boolean {
  const keysA = Object.keys(objectA);
  const keysB = Object.keys(objectB);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (!(Object.hasOwn(objectB, key) && historicalDeepEqual(objectA[key], objectB[key]))) {
      return false;
    }
  }
  return true;
}

function historicalDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (!(isObjectLike(a) && isObjectLike(b))) {
    return false;
  }
  if (a.constructor !== b.constructor) {
    return false;
  }

  if (Array.isArray(a)) {
    return Array.isArray(b) && areArraysDeepEqual(a, b);
  }
  if (a instanceof Date) {
    return b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof Uint8Array) {
    return b instanceof Uint8Array && areUint8ArraysEqual(a, b);
  }
  if (a instanceof RegExp) {
    return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }

  return areObjectsDeepEqual(a, b);
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
  if (equalCount !== iterations) {
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
    if (historicalDeepEqual(next, previous)) {
      equalCount += 1;
    } else {
      previous = next;
    }
  }

  const durationMs = now() - startedAt;
  if (equalCount !== iterations) {
    throw new Error(`Live-query deep-equality benchmark scenario "${scenario.name}" is not stable`);
  }
  return durationMs;
}

function warmBothStrategies(
  scenario: LiveQueryParamBenchmarkScenario,
  iterations: number,
  now: () => number
): void {
  measureCurrentJsonStrategy(scenario, iterations, now);
  measureLegacyDeepEqualStrategy(scenario, iterations, now);
  measureLegacyDeepEqualStrategy(scenario, iterations, now);
  measureCurrentJsonStrategy(scenario, iterations, now);
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
      warmBothStrategies(scenario, warmupIterations, now);
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
    if (!(currentJsonMedianMs > 0 && legacyDeepEqualMedianMs > 0)) {
      throw new Error(
        `Live-query benchmark scenario "${scenario.name}" produced a zero-duration median; increase iterations`
      );
    }
    return {
      currentJsonMedianMs,
      currentToLegacyRatio: currentJsonMedianMs / legacyDeepEqualMedianMs,
      iterations,
      legacyDeepEqualMedianMs,
      name: scenario.name,
      samples,
    };
  });
}
