/**
 * Gates the corruption-safe built-in `ts_rank` lexical baseline. The one
 * IDF-sensitive miss remains explicit so a future durable ranker can improve
 * it without quietly lowering the rest of the golden set.
 */

import { describe, expect, it } from 'vitest';
import { runLexicalEvaluation } from '../src/evaluation/lexical-eval-runner.js';

const EVAL_TIMEOUT_MS = 120_000;

describe('lexical retrieval evaluation (built-in FTS arm)', () => {
  it(
    'meets the measured corruption-safe precision and MRR floors',
    async () => {
      const report = await runLexicalEvaluation();

      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.summary.totalQueries).toBeGreaterThanOrEqual(5);
      expect(report.summary.failedQueries).toBe(1);
      expect(report.summary.meanPrecisionAt1).toBe(0.8);
      expect(report.summary.meanReciprocalRank).toBe(0.85);
    },
    EVAL_TIMEOUT_MS
  );

  it(
    'keeps the known IDF-sensitive ts_rank limitation explicit',
    async () => {
      const report = await runLexicalEvaluation();
      const idfQuery = report.queries.find((query) => query.id === 'lex-q1-idf-rare-term');

      expect(idfQuery).toBeDefined();
      expect(idfQuery?.topChunkIds[0]).toBe('lex-chunk-11');
      expect(idfQuery?.topChunkIds.indexOf('lex-chunk-04')).toBe(3);
    },
    EVAL_TIMEOUT_MS
  );
});
