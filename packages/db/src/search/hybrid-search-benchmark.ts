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

export async function runHybridSearchBenchmark(
  _options: HybridSearchBenchmarkOptions
): Promise<HybridSearchBenchmarkReport> {
  throw new Error('Hybrid search benchmark runner is not implemented.');
}
