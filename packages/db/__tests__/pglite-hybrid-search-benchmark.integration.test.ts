import { describe, expect, it } from 'vitest';
import { runPGliteHybridSearchBenchmark } from '../src/search/pglite-hybrid-search-benchmark.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('runPGliteHybridSearchBenchmark', () => {
  it('replays the measured repository SQL and records the actual tiny-corpus plans', async () => {
    const report = await runPGliteHybridSearchBenchmark(
      {
        dimensions: 8,
        iterations: 4,
        limit: 5,
        rows: 80,
        thresholds: {
          maxAdditionalP95Ms: 10_000,
          maxHybridP95Ms: 10_000,
        },
        topics: 4,
        warmupIterations: 1,
      },
      { createDatabase: createMigratedTestDb, forceIndexPlans: true }
    );

    expect(report.corpus).toEqual({ dimensions: 8, rows: 80, topics: 4 });
    expect(report.hybridLatency.samplesMs).toHaveLength(4);
    expect(report.vectorOnlyLatency.samplesMs).toHaveLength(4);
    expect(report.observations.minimumHybridResultCount).toBeGreaterThan(0);
    expect(report.observations.minimumVectorOnlyResultCount).toBeGreaterThan(0);
    expect(report.indexUsage.usesGin).toBe(false);
    expect(report.indexUsage.usesHnsw).toBe(true);
    expect(report.indexUsage.plannerMode).toBe('forced');
    expect(report.observations.vectorSourceLimit).toBe(50);
    expect(report.passed).toBe(true);
  });
});
