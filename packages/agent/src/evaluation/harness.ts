/**
 * Retrieval evaluation harness (BST-175)
 *
 * Runs deterministic evaluation of retrieval quality against golden datasets.
 */

import { aggregateMetrics, evaluateTestCase } from './metrics';
import {
  type AggregateMetrics,
  DEFAULT_EVALUATION_CONFIG,
  type EvaluationConfig,
  type EvaluationReport,
  type GoldenDataset,
  type RetrievalResult,
  type TestCaseResult,
} from './types';

/**
 * Search function signature for the harness.
 * Implementations should return ranked results for the given query.
 */
export type SearchFunction = (
  query: string,
  options: { limit: number; threshold: number }
) => Promise<RetrievalResult[]>;

/**
 * Options for running the evaluation harness.
 */
export interface HarnessOptions {
  /** The search function to evaluate */
  search: SearchFunction;
  /** Evaluation configuration */
  config?: Partial<EvaluationConfig>;
  /** Optional logger for verbose output */
  logger?: {
    info: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

/**
 * Runs evaluation for a single test case.
 */
async function runTestCase(
  testCase: GoldenDataset['testCases'][number],
  search: SearchFunction,
  config: EvaluationConfig,
  logger?: HarnessOptions['logger']
): Promise<TestCaseResult> {
  const startTime = performance.now();

  try {
    if (config.verbose) {
      logger?.info('Running test case', { id: testCase.id, query: testCase.query });
    }

    // Determine max k for search limit
    const maxK = Math.max(...config.kValues);
    const results = await search(testCase.query, {
      limit: maxK,
      threshold: testCase.minSimilarity ?? 0.3,
    });

    const executionTimeMs = performance.now() - startTime;
    const result = evaluateTestCase(testCase, results, config.kValues, executionTimeMs);

    if (config.verbose) {
      logger?.info('Test case completed', {
        id: testCase.id,
        mrr: result.mrr.toFixed(3),
        relevantFound: result.relevantFound,
        totalExpected: result.totalExpected,
      });
    }

    return result;
  } catch (error) {
    const executionTimeMs = performance.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger?.error('Test case failed', { id: testCase.id, error: errorMessage });

    return {
      testCaseId: testCase.id,
      query: testCase.query,
      precisionAtK: Object.fromEntries(config.kValues.map((k) => [k, 0])),
      recallAtK: Object.fromEntries(config.kValues.map((k) => [k, 0])),
      mrr: 0,
      retrievedCount: 0,
      relevantFound: 0,
      totalExpected: testCase.expectedFilePaths.length,
      allFound: false,
      executionTimeMs,
      retrievedResults: [],
      error: errorMessage,
    };
  }
}

/**
 * Runs the evaluation harness against a golden dataset.
 *
 * @example
 * ```typescript
 * const report = await runEvaluationHarness(goldenDataset, {
 *   search: async (query, opts) => {
 *     // Your search implementation
 *     return results;
 *   },
 *   config: { kValues: [1, 3, 5, 10], verbose: true },
 * });
 * console.log(formatReport(report));
 * ```
 */
export async function runEvaluationHarness(
  dataset: GoldenDataset,
  options: HarnessOptions
): Promise<EvaluationReport> {
  const config: EvaluationConfig = {
    ...DEFAULT_EVALUATION_CONFIG,
    ...options.config,
  };

  const { logger } = options;
  const startTime = Date.now();

  logger?.info('Starting evaluation', {
    dataset: dataset.name,
    version: dataset.version,
    testCases: dataset.testCases.length,
    kValues: config.kValues,
  });

  // Run all test cases with configurable concurrency
  const testCaseResults: TestCaseResult[] = [];
  const concurrency = Math.max(config.concurrency ?? 1, 1);

  if (concurrency <= 1) {
    for (const testCase of dataset.testCases) {
      const result = await runTestCase(testCase, options.search, config, logger);
      testCaseResults.push(result);
    }
  } else {
    for (let i = 0; i < dataset.testCases.length; i += concurrency) {
      const batch = dataset.testCases.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((testCase) => runTestCase(testCase, options.search, config, logger))
      );
      testCaseResults.push(...batchResults);
    }
  }

  // Aggregate metrics
  const aggregatedMetrics = aggregateMetrics(testCaseResults, config.kValues);

  const report: EvaluationReport = {
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    timestamp: new Date().toISOString(),
    aggregateMetrics: aggregatedMetrics,
    testCaseResults,
    kValues: config.kValues,
  };

  logger?.info('Evaluation completed', {
    totalMs: Date.now() - startTime,
    meanMrr: aggregatedMetrics.meanMrr.toFixed(3),
    successRate: `${aggregatedMetrics.successfulEvaluations}/${aggregatedMetrics.totalTestCases}`,
    perfectRecallRate: `${(aggregatedMetrics.perfectRecallRate * 100).toFixed(1)}%`,
  });

  return report;
}

/**
 * Formats an evaluation report as a human-readable string.
 */
export function formatReport(report: EvaluationReport): string {
  const lines: string[] = [];

  lines.push('═'.repeat(60));
  lines.push('  Retrieval Evaluation Report');
  lines.push('═'.repeat(60));
  lines.push(`Dataset: ${report.datasetName} (v${report.datasetVersion})`);
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push('');

  lines.push('─'.repeat(60));
  lines.push('  Aggregate Metrics');
  lines.push('─'.repeat(60));

  const { aggregateMetrics: m } = report;

  lines.push(
    `Test Cases: ${m.totalTestCases} (${m.successfulEvaluations} passed, ${m.failedEvaluations} failed)`
  );
  lines.push(`Perfect Recall Rate: ${(m.perfectRecallRate * 100).toFixed(1)}%`);
  lines.push(`Mean MRR: ${m.meanMrr.toFixed(4)}`);
  lines.push(`Avg Execution Time: ${m.avgExecutionTimeMs.toFixed(1)}ms`);
  lines.push('');

  lines.push('Precision@k:');
  for (const k of report.kValues) {
    lines.push(`  P@${k}: ${(m.meanPrecisionAtK[k] ?? 0).toFixed(4)}`);
  }
  lines.push('');

  lines.push('Recall@k:');
  for (const k of report.kValues) {
    lines.push(`  R@${k}: ${(m.meanRecallAtK[k] ?? 0).toFixed(4)}`);
  }
  lines.push('');

  // Individual test cases summary
  lines.push('─'.repeat(60));
  lines.push('  Test Case Summary');
  lines.push('─'.repeat(60));

  for (const tc of report.testCaseResults) {
    const status = tc.error ? '✗' : tc.allFound ? '✓' : '○';
    const mrr = tc.mrr.toFixed(3);
    const recall = `${tc.relevantFound}/${tc.totalExpected}`;
    lines.push(`${status} [${tc.testCaseId}] MRR=${mrr} Found=${recall}`);
    if (tc.error) {
      lines.push(`    Error: ${tc.error}`);
    }
  }

  lines.push('═'.repeat(60));

  return lines.join('\n');
}

/**
 * Formats report as JSON for CI consumption.
 */
export function formatReportJson(report: EvaluationReport): string {
  return JSON.stringify(
    {
      dataset: {
        name: report.datasetName,
        version: report.datasetVersion,
      },
      timestamp: report.timestamp,
      summary: {
        totalTestCases: report.aggregateMetrics.totalTestCases,
        passed: report.aggregateMetrics.successfulEvaluations,
        failed: report.aggregateMetrics.failedEvaluations,
        perfectRecallRate: report.aggregateMetrics.perfectRecallRate,
        meanMrr: report.aggregateMetrics.meanMrr,
        avgExecutionTimeMs: report.aggregateMetrics.avgExecutionTimeMs,
      },
      precisionAtK: report.aggregateMetrics.meanPrecisionAtK,
      recallAtK: report.aggregateMetrics.meanRecallAtK,
      kValues: report.kValues,
    },
    null,
    2
  );
}

/**
 * Checks if evaluation meets minimum thresholds.
 * Useful for CI pass/fail decisions.
 */
export interface QualityThresholds {
  minMeanMrr?: number;
  minPrecisionAtK?: Record<number, number>;
  minRecallAtK?: Record<number, number>;
  minPerfectRecallRate?: number;
  maxFailedEvaluations?: number;
}

function checkMrrThreshold(
  metrics: AggregateMetrics,
  minMeanMrr: number | undefined
): string | null {
  if (minMeanMrr === undefined) {
    return null;
  }
  if (metrics.meanMrr >= minMeanMrr) {
    return null;
  }
  return `Mean MRR ${metrics.meanMrr.toFixed(4)} < ${minMeanMrr}`;
}

function checkPerfectRecallThreshold(
  metrics: AggregateMetrics,
  minRate: number | undefined
): string | null {
  if (minRate === undefined) {
    return null;
  }
  if (metrics.perfectRecallRate >= minRate) {
    return null;
  }
  return `Perfect Recall Rate ${(metrics.perfectRecallRate * 100).toFixed(1)}% < ${(minRate * 100).toFixed(1)}%`;
}

function checkFailedEvaluationsThreshold(
  metrics: AggregateMetrics,
  maxFailed: number | undefined
): string | null {
  if (maxFailed === undefined) {
    return null;
  }
  if (metrics.failedEvaluations <= maxFailed) {
    return null;
  }
  return `Failed evaluations ${metrics.failedEvaluations} > ${maxFailed}`;
}

function checkAtKThresholds(
  actualValues: Record<number, number>,
  minValues: Record<number, number> | undefined,
  prefix: string
): string[] {
  if (!minValues) {
    return [];
  }
  const failures: string[] = [];
  for (const [k, minVal] of Object.entries(minValues)) {
    const actual = actualValues[Number(k)] ?? 0;
    if (actual < minVal) {
      failures.push(`${prefix}@${k} ${actual.toFixed(4)} < ${minVal}`);
    }
  }
  return failures;
}

export function meetsThresholds(
  report: EvaluationReport,
  thresholds: QualityThresholds
): { passed: boolean; failures: string[] } {
  const m = report.aggregateMetrics;
  const failures: string[] = [];

  const mrrFailure = checkMrrThreshold(m, thresholds.minMeanMrr);
  if (mrrFailure) {
    failures.push(mrrFailure);
  }

  const recallRateFailure = checkPerfectRecallThreshold(m, thresholds.minPerfectRecallRate);
  if (recallRateFailure) {
    failures.push(recallRateFailure);
  }

  const failedFailure = checkFailedEvaluationsThreshold(m, thresholds.maxFailedEvaluations);
  if (failedFailure) {
    failures.push(failedFailure);
  }

  failures.push(...checkAtKThresholds(m.meanPrecisionAtK, thresholds.minPrecisionAtK, 'P'));
  failures.push(...checkAtKThresholds(m.meanRecallAtK, thresholds.minRecallAtK, 'R'));

  return { passed: failures.length === 0, failures };
}
