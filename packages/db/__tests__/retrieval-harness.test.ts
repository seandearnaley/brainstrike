import { describe, expect, it } from 'vitest';
import { runRetrievalEvaluation } from '../src/evaluation/retrieval-eval-runner.js';
import { retrievalGoldenDataset } from '../src/evaluation/retrieval-golden.js';

describe('retrieval regression harness', () => {
  it('reports precision@1 for golden queries', async () => {
    const report = await runRetrievalEvaluation();

    for (const result of report.queries) {
      console.info('[retrieval-harness] query metrics', {
        id: result.id,
        query: result.query,
        precisionAt1: result.precisionAt1,
        topFiles: result.topFiles.map((entry) => entry.filePath),
        expected: result.expectedFilePaths,
      });

      expect(result.precisionAt1, `precision@1 for ${result.id}`).toBe(1);
    }

    console.info('[retrieval-harness] summary', {
      precisionAt1: Number(report.summary.meanPrecisionAt1.toFixed(3)),
      totalQueries: report.summary.totalQueries,
    });

    expect(report.dataset.name).toBe(retrievalGoldenDataset.name);
    expect(report.summary.totalQueries).toBe(retrievalGoldenDataset.queries.length);
    expect(report.summary.meanPrecisionAt1).toBe(1);
    expect(report.passed).toBe(true);
  });
});
