import { describe, expect, it } from 'vitest';
import { runPGliteHybridSearchBenchmark } from '../src/search/pglite-hybrid-search-benchmark.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('runPGliteHybridSearchBenchmark', () => {
  it('measures the real repository/service path and proves both indexes are selected', async () => {
    const report = await runPGliteHybridSearchBenchmark(
      {
        dimensions: 8,
        iterations: 2,
        limit: 5,
        rows: 80,
        thresholds: {
          maxAdditionalP95Ms: 10_000,
          maxHybridP95Ms: 10_000,
        },
        topics: 4,
        warmupIterations: 1,
      },
      { createDatabase: createMigratedTestDb }
    );

    expect(report.corpus).toEqual({ dimensions: 8, rows: 80, topics: 4 });
    expect(report.hybridLatency.samplesMs).toHaveLength(2);
    expect(report.vectorOnlyLatency.samplesMs).toHaveLength(2);
    expect(report.observations.minimumHybridResultCount).toBeGreaterThan(0);
    expect(report.observations.minimumVectorOnlyResultCount).toBeGreaterThan(0);
    expect(report.indexUsage.usesGin).toBe(true);
    expect(report.indexUsage.usesHnsw).toBe(true);
    expect(report.passed).toBe(true);
  });
});
