import { describe, expect, it } from 'vitest';
import {
  runRetrievalEvaluation,
  serializeRetrievalEvaluationReport,
} from '../src/evaluation/retrieval-eval-runner.js';
import { retrievalGoldenDataset } from '../src/evaluation/retrieval-golden.js';

describe('retrieval eval runner', () => {
  it('emits a passing JSON report for the golden retrieval dataset', async () => {
    const report = await runRetrievalEvaluation();

    expect(report.dataset.name).toBe('retrieval-golden');
    expect(report.summary.totalQueries).toBe(retrievalGoldenDataset.queries.length);
    expect(report.summary.failedQueries).toBe(0);
    expect(report.summary.failureCount).toBe(0);
    expect(report.summary.passedQueries).toBe(retrievalGoldenDataset.queries.length);
    expect(report.summary.meanPrecisionAt1).toBe(1);
    expect(report.passed).toBe(true);

    const parsed = JSON.parse(serializeRetrievalEvaluationReport(report)) as typeof report;
    expect(parsed.summary.meanPrecisionAt1).toBe(1);
    expect(parsed.queries[0]).toEqual(
      expect.objectContaining({
        id: retrievalGoldenDataset.queries[0]?.id,
        passed: true,
      })
    );
    expect(parsed.queries[0]?.topFiles.map((file) => file.filePath)).toEqual([
      '/src/auth.ts',
      '/src/db.ts',
      '/src/button.tsx',
    ]);
  });

  it('marks the run failed when a query misses its expected file', async () => {
    const failingDataset = {
      ...retrievalGoldenDataset,
      queries: retrievalGoldenDataset.queries.map((query, index) =>
        index === 0 ? { ...query, expectedFilePaths: ['/src/missing.ts'] } : query
      ),
    };

    const report = await runRetrievalEvaluation({ dataset: failingDataset });

    expect(report.passed).toBe(false);
    expect(report.summary.failedQueries).toBe(1);
    expect(report.summary.failureCount).toBe(2);
    expect(report.failures).toEqual([
      'query-auth precision@1 0.0000 < 1',
      'mean precision@1 0.6667 < 1',
    ]);
  });

  it('keeps query counts distinct from run-level threshold failures', async () => {
    const failingDataset = {
      ...retrievalGoldenDataset,
      queries: retrievalGoldenDataset.queries.map((query, index) =>
        index === 0 ? { ...query, expectedFilePaths: ['/src/missing.ts'] } : query
      ),
    };

    const report = await runRetrievalEvaluation({
      dataset: failingDataset,
      thresholds: { minMeanPrecisionAt1: 0.8, minQueryPrecisionAt1: 0 },
    });

    expect(report.passed).toBe(false);
    expect(report.summary.failedQueries).toBe(0);
    expect(report.summary.failureCount).toBe(1);
    expect(report.summary.passedQueries).toBe(retrievalGoldenDataset.queries.length);
    expect(report.failures).toEqual(['mean precision@1 0.6667 < 0.8']);
  });
});
