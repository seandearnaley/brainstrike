export interface HybridSearchBenchmarkThresholds {
  readonly maxAdditionalP95Ms: number;
  readonly maxHybridP95Ms: number;
}

export interface HybridSearchBenchmarkOptions {
  readonly iterations: number;
  readonly now?: () => number;
  readonly runHybrid: () => Promise<void>;
  readonly runVectorOnly: () => Promise<void>;
  readonly thresholds: HybridSearchBenchmarkThresholds;
  readonly warmupIterations: number;
}

export interface HybridSearchBenchmarkLatencySummary {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly samplesMs: readonly number[];
}

export interface HybridSearchBenchmarkReport {
  readonly additionalLatency: HybridSearchBenchmarkLatencySummary;
  readonly failures: readonly string[];
  readonly hybridLatency: HybridSearchBenchmarkLatencySummary;
  readonly iterations: number;
  readonly passed: boolean;
  readonly thresholds: HybridSearchBenchmarkThresholds;
  readonly vectorOnlyLatency: HybridSearchBenchmarkLatencySummary;
  readonly warmupIterations: number;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!(Number.isInteger(value) && value >= 0)) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function assertPositiveFinite(value: number, label: string): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new Error(`${label} must be finite and greater than zero.`);
  }
}

function readClock(now: () => number): number {
  const value = now();
  if (!(Number.isFinite(value) && value >= 0)) {
    throw new Error('Hybrid search benchmark clock must be finite and non-negative.');
  }
  return value;
}

async function measure(run: () => Promise<void>, now: () => number): Promise<number> {
  const start = readClock(now);
  await run();
  const end = readClock(now);
  if (end < start) {
    throw new Error('Hybrid search benchmark clock moved backwards.');
  }
  return end - start;
}

function percentile(sortedSamples: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(sortedSamples.length * ratio) - 1);
  return sortedSamples[index] ?? 0;
}

function summarize(samplesMs: readonly number[]): HybridSearchBenchmarkLatencySummary {
  const sortedSamples = samplesMs.toSorted((left, right) => left - right);
  return {
    p50Ms: percentile(sortedSamples, 0.5),
    p95Ms: percentile(sortedSamples, 0.95),
    samplesMs: [...samplesMs],
  };
}

function runSequentialIterations(
  count: number,
  runIteration: (index: number) => Promise<void>,
  index = 0
): Promise<void> {
  if (index >= count) {
    return Promise.resolve();
  }
  return runIteration(index).then(() => runSequentialIterations(count, runIteration, index + 1));
}

function runSequentialPair(first: () => Promise<void>, second: () => Promise<void>): Promise<void> {
  return first().then(second);
}

function measureAndRecord(
  run: () => Promise<void>,
  now: () => number,
  samples: number[]
): Promise<void> {
  return measure(run, now).then((sample) => {
    samples.push(sample);
  });
}

export async function runHybridSearchBenchmark(
  options: HybridSearchBenchmarkOptions
): Promise<HybridSearchBenchmarkReport> {
  assertPositiveInteger(options.iterations, 'Hybrid search benchmark iterations');
  assertNonNegativeInteger(options.warmupIterations, 'Hybrid search benchmark warmupIterations');
  assertPositiveFinite(
    options.thresholds.maxAdditionalP95Ms,
    'Hybrid search benchmark maxAdditionalP95Ms'
  );
  assertPositiveFinite(options.thresholds.maxHybridP95Ms, 'Hybrid search benchmark maxHybridP95Ms');

  const now = options.now ?? performance.now.bind(performance);
  await runSequentialIterations(options.warmupIterations, (index) =>
    index % 2 === 0
      ? runSequentialPair(options.runVectorOnly, options.runHybrid)
      : runSequentialPair(options.runHybrid, options.runVectorOnly)
  );

  const vectorOnlySamples: number[] = [];
  const hybridSamples: number[] = [];
  await runSequentialIterations(options.iterations, (index) =>
    index % 2 === 0
      ? runSequentialPair(
          () => measureAndRecord(options.runVectorOnly, now, vectorOnlySamples),
          () => measureAndRecord(options.runHybrid, now, hybridSamples)
        )
      : runSequentialPair(
          () => measureAndRecord(options.runHybrid, now, hybridSamples),
          () => measureAndRecord(options.runVectorOnly, now, vectorOnlySamples)
        )
  );

  const additionalSamples = hybridSamples.map(
    (hybridSample, index) => hybridSample - (vectorOnlySamples[index] ?? 0)
  );
  const hybridLatency = summarize(hybridSamples);
  const vectorOnlyLatency = summarize(vectorOnlySamples);
  const additionalLatency = summarize(additionalSamples);
  const failures: string[] = [];
  if (hybridLatency.p95Ms > options.thresholds.maxHybridP95Ms) {
    failures.push(
      `hybrid p95 ${hybridLatency.p95Ms.toFixed(3)}ms exceeds ${options.thresholds.maxHybridP95Ms.toFixed(3)}ms`
    );
  }
  if (additionalLatency.p95Ms > options.thresholds.maxAdditionalP95Ms) {
    failures.push(
      `additional p95 ${additionalLatency.p95Ms.toFixed(3)}ms exceeds ${options.thresholds.maxAdditionalP95Ms.toFixed(3)}ms`
    );
  }

  return {
    additionalLatency,
    failures,
    hybridLatency,
    iterations: options.iterations,
    passed: failures.length === 0,
    thresholds: { ...options.thresholds },
    vectorOnlyLatency,
    warmupIterations: options.warmupIterations,
  };
}
