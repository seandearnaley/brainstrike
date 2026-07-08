/**
 * Types for retrieval evaluation harness (BST-175)
 *
 * Defines the golden dataset format and evaluation metrics types.
 */

/**
 * A single test case in the golden dataset.
 * Maps a query to expected relevant file/chunk patterns.
 */
export interface GoldenTestCase {
  /** Optional: Expected chunk content patterns (regex) */
  expectedContentPatterns?: string[];
  /** Expected relevant file paths (glob patterns supported) */
  expectedFilePaths: string[];
  /** Unique identifier for the test case */
  id: string;
  /** Optional: Minimum expected similarity score */
  minSimilarity?: number;
  /** The search query */
  query: string;
  /** Optional: Tags for categorizing test cases */
  tags?: string[];
}

/**
 * Golden dataset containing multiple test cases.
 */
export interface GoldenDataset {
  /** Description of the dataset */
  description?: string;
  /** Dataset name/identifier */
  name: string;
  /** The test cases */
  testCases: GoldenTestCase[];
  /** Version for tracking changes */
  version: string;
}

/**
 * Result of a single retrieval for evaluation.
 */
export interface RetrievalResult {
  /** Chunk content */
  content: string;
  /** File path of the retrieved chunk */
  filePath: string;
  /** Rank position (1-based) */
  rank: number;
  /** Similarity score (0-1) */
  similarity: number;
}

/**
 * Evaluation result for a single test case.
 */
export interface TestCaseResult {
  /** Whether all expected items were found */
  allFound: boolean;
  /** Any errors that occurred */
  error?: string;
  /** Execution time in ms */
  executionTimeMs: number;
  /** Mean Reciprocal Rank */
  mrr: number;
  /** Precision at various k values */
  precisionAtK: Record<number, number>;
  /** The query that was tested */
  query: string;
  /** Recall at various k values */
  recallAtK: Record<number, number>;
  /** Number of relevant results found */
  relevantFound: number;
  /** Number of retrieved results */
  retrievedCount: number;
  /** Retrieved results for inspection */
  retrievedResults: RetrievalResult[];
  /** Test case ID */
  testCaseId: string;
  /** Total expected relevant items */
  totalExpected: number;
}

/**
 * Aggregated metrics across all test cases.
 */
export interface AggregateMetrics {
  /** Average execution time */
  avgExecutionTimeMs: number;
  /** Number of failed evaluations */
  failedEvaluations: number;
  /** Mean Reciprocal Rank across all queries */
  meanMrr: number;
  /** Mean precision at various k values */
  meanPrecisionAtK: Record<number, number>;
  /** Mean recall at various k values */
  meanRecallAtK: Record<number, number>;
  /** Percentage of test cases where all expected items were found */
  perfectRecallRate: number;
  /** Number of successful evaluations */
  successfulEvaluations: number;
  /** Total test cases evaluated */
  totalTestCases: number;
}

/**
 * Full evaluation report.
 */
export interface EvaluationReport {
  /** Aggregate metrics */
  aggregateMetrics: AggregateMetrics;
  /** Dataset that was evaluated */
  datasetName: string;
  /** Dataset version */
  datasetVersion: string;
  /** K values that were evaluated */
  kValues: number[];
  /** Individual test case results */
  testCaseResults: TestCaseResult[];
  /** Timestamp of evaluation */
  timestamp: string;
}

/**
 * Configuration for the evaluation harness.
 */
export interface EvaluationConfig {
  /** Maximum concurrent evaluations */
  concurrency?: number;
  /** K values to compute precision/recall at */
  kValues: number[];
  /** Timeout per test case in ms */
  timeoutMs?: number;
  /** Whether to run in verbose mode */
  verbose?: boolean;
}

/**
 * Default evaluation configuration.
 */
export const DEFAULT_EVALUATION_CONFIG: EvaluationConfig = {
  concurrency: 1,
  kValues: [1, 3, 5, 10],
  timeoutMs: 30_000,
  verbose: false,
};
