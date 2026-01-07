/**
 * Retrieval evaluation harness module (BST-175)
 *
 * Provides tools for evaluating retrieval quality with golden datasets.
 */

export { createMockDataset, sampleGoldenDataset } from './fixtures/sample-dataset';
export {
  formatReport,
  formatReportJson,
  type HarnessOptions,
  meetsThresholds,
  type QualityThresholds,
  runEvaluationHarness,
  type SearchFunction,
} from './harness';
export {
  aggregateMetrics,
  computeMrr,
  computePrecisionAtK,
  computeRecallAtK,
  evaluateTestCase,
  isRelevant,
  matchesContentPattern,
  matchesExpectedPath,
} from './metrics';
export {
  type AggregateMetrics,
  DEFAULT_EVALUATION_CONFIG,
  type EvaluationConfig,
  type EvaluationReport,
  type GoldenDataset,
  type GoldenTestCase,
  type RetrievalResult,
  type TestCaseResult,
} from './types';
