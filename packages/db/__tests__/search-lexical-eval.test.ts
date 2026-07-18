/**
 * Gates the BM25-ordered lexical arm against the hand-authored golden set:
 * precision@1 = 1 and MRR = 1 across all queries, including the
 * IDF-discriminating case where a term-stuffed document competes with the
 * rare-term target (the ordering property ts_rank lacked).
 */

import { describe, expect, it } from 'vitest';
import { runLexicalEvaluation } from '../src/evaluation/lexical-eval-runner.js';

const EVAL_TIMEOUT_MS = 120_000;

describe('lexical retrieval evaluation (BM25 arm)', () => {
  it(
    'passes the golden set at precision@1 = 1 and MRR = 1',
    async () => {
      const report = await runLexicalEvaluation();

      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.summary.totalQueries).toBeGreaterThanOrEqual(5);
      expect(report.summary.meanPrecisionAt1).toBe(1);
      expect(report.summary.meanReciprocalRank).toBe(1);
    },
    EVAL_TIMEOUT_MS
  );

  it(
    'the IDF-discriminating query ranks the rare-term chunk above the term-stuffed chunk',
    async () => {
      const report = await runLexicalEvaluation();
      const idfQuery = report.queries.find((query) => query.id === 'lex-q1-idf-rare-term');

      expect(idfQuery).toBeDefined();
      expect(idfQuery?.topChunkIds[0]).toBe('lex-chunk-04');
      const stuffedIndex = idfQuery?.topChunkIds.indexOf('lex-chunk-11') ?? -1;
      if (stuffedIndex !== -1) {
        expect(stuffedIndex).toBeGreaterThan(0);
      }
    },
    EVAL_TIMEOUT_MS
  );
});
