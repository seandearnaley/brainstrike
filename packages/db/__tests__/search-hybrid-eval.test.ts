/**
 * Gates the hybrid (vector + BM25, RRF-fused) arm against the hand-authored
 * golden set: the fused ranking must place every target first (precision@1 = 1,
 * MRR = 1) while — by design — NEITHER pure arm alone does. The runner itself
 * fails when either single arm reaches precision@1 = 1, so this test also
 * guards the dataset's arm-separating property.
 */

import { describe, expect, it } from 'vitest';
import { runHybridEvaluation } from '../src/evaluation/hybrid-eval-runner.js';

const EVAL_TIMEOUT_MS = 120_000;

describe('hybrid retrieval evaluation (RRF fusion)', () => {
  it(
    'passes the golden set at fused precision@1 = 1 and MRR = 1',
    async () => {
      const report = await runHybridEvaluation();

      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.summary.totalQueries).toBeGreaterThanOrEqual(3);
      expect(report.arms.hybrid.meanPrecisionAt1).toBe(1);
      expect(report.arms.hybrid.meanReciprocalRank).toBe(1);
    },
    EVAL_TIMEOUT_MS
  );

  it(
    'neither pure arm ranks every target first (fusion closes the gap)',
    async () => {
      const report = await runHybridEvaluation();

      expect(report.arms.vectorOnly.meanPrecisionAt1).toBeLessThan(1);
      expect(report.arms.lexicalOnly.meanPrecisionAt1).toBeLessThan(1);

      for (const query of report.queries) {
        // Each single-arm leader is present but beaten by the fused target.
        expect(query.hybridTopChunkIds[0]).toBe(query.expectedChunkId);
        expect(query.vectorOnlyTopChunkIds[0]).not.toBe(query.expectedChunkId);
        expect(query.lexicalOnlyTopChunkIds[0]).not.toBe(query.expectedChunkId);
      }
    },
    EVAL_TIMEOUT_MS
  );
});
