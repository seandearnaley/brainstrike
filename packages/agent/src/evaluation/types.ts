/**
 * Types for retrieval evaluation harness (BST-175)
 *
 * Defines the golden dataset format and evaluation metrics types.
 */

/**
 * A single test case in the golden dataset.
 * Maps a query to expected relevant file/chunk patterns.
 */
export type GoldenTestCase = {
  /** Unique identifier for the test case */
  id: string;
  /** The search query */
  query: string;
  /** Expected relevant file paths (glob patterns supported) */
  expectedFilePaths: string[];
  /** Optional: Expected chunk content patterns (regex) */
  expectedContentPatterns?: string[];
  /** Optional: Minimum expected similarity score */
  minSimilarity?: number;
  /** Optional: Tags for categorizing test cases */
  tags?: string[];
};

/**
 * Golden dataset containing multiple test cases.
 */
export type GoldenDataset = {
  /** Dataset name/identifier */
  name: string;
  /** Version for tracking changes */
  version: string;
  /** Description of the dataset */
  description?: string;
  /** The test cases */
  testCases: GoldenTestCase[];
};

/**
 * Result of a single retrieval for evaluation.
 */
export type RetrievalResult = {
  /** File path of the retrieved chunk */
  filePath: string;
  /** Chunk content */
  content: string;
  /** Similarity score (0-1) */
  similarity: number;
  /** Rank position (1-based) */
  rank: number;
};

/**
 * Evaluation result for a single test case.
 */
export type TestCaseResult = {
  /** Test case ID */
  testCaseId: string;
  /** The query that was tested */
  query: string;
  /** Precision at various k values */
  precisionAtK: Record<number, number>;
  /** Recall at various k values */
  recallAtK: Record<number, number>;
  /** Mean Reciprocal Rank */
  mrr: number;
  /** Number of retrieved results */
  retrievedCount: number;
  /** Number of relevant results found */
  relevantFound: number;
  /** Total expected relevant items */
  totalExpected: number;
  /** Whether all expected items were found */
  allFound: boolean;
  /** Execution time in ms */
  executionTimeMs: number;
  /** Retrieved results for inspection */
  retrievedResults: RetrievalResult[];
  /** Any errors that occurred */
  error?: string;
};

/**
 * Aggregated metrics across all test cases.
 */
export type AggregateMetrics = {
  /** Mean precision at various k values */
  meanPrecisionAtK: Record<number, number>;
  /** Mean recall at various k values */
  meanRecallAtK: Record<number, number>;
  /** Mean Reciprocal Rank across all queries */
  meanMrr: number;
  /** Percentage of test cases where all expected items were found */
  perfectRecallRate: number;
  /** Total test cases evaluated */
  totalTestCases: number;
  /** Number of successful evaluations */
  successfulEvaluations: number;
  /** Number of failed evaluations */
  failedEvaluations: number;
  /** Average execution time */
  avgExecutionTimeMs: number;
};

/**
 * Full evaluation report.
 */
export type EvaluationReport = {
  /** Dataset that was evaluated */
  datasetName: string;
  /** Dataset version */
  datasetVersion: string;
  /** Timestamp of evaluation */
  timestamp: string;
  /** Aggregate metrics */
  aggregateMetrics: AggregateMetrics;
  /** Individual test case results */
  testCaseResults: TestCaseResult[];
  /** K values that were evaluated */
  kValues: number[];
};

/**
 * Configuration for the evaluation harness.
 */
export type EvaluationConfig = {
  /** K values to compute precision/recall at */
  kValues: number[];
  /** Whether to run in verbose mode */
  verbose?: boolean;
  /** Maximum concurrent evaluations */
  concurrency?: number;
  /** Timeout per test case in ms */
  timeoutMs?: number;
};

/**
 * Default evaluation configuration.
 */
export const DEFAULT_EVALUATION_CONFIG: EvaluationConfig = {
  kValues: [1, 3, 5, 10],
  verbose: false,
  concurrency: 1,
  timeoutMs: 30_000,
};
