/**
 * Retrieval quality metrics (BST-175)
 *
 * Implements standard IR metrics: precision@k, recall@k, MRR.
 */

import { Minimatch } from 'minimatch';
import type { AggregateMetrics, GoldenTestCase, RetrievalResult, TestCaseResult } from './types';

const minimatchCache = new Map<string, Minimatch>();
const minimatchOpts = { matchBase: true } as const;

function getCachedMatcher(pattern: string): Minimatch {
  let matcher = minimatchCache.get(pattern);
  if (!matcher) {
    matcher = new Minimatch(pattern, minimatchOpts);
    minimatchCache.set(pattern, matcher);
  }
  return matcher;
}

function matchesPattern(filePath: string, pattern: string): boolean {
  return getCachedMatcher(pattern).match(filePath);
}

/**
 * Checks if a file path matches any of the expected patterns.
 * Supports glob patterns via minimatch.
 */
export function matchesExpectedPath(filePath: string, expectedPatterns: string[]): boolean {
  for (const pattern of expectedPatterns) {
    if (filePath === pattern || matchesPattern(filePath, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if content matches any of the expected regex patterns.
 */
export function matchesContentPattern(content: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) {
    return true; // No content patterns means any content is acceptable
  }
  for (const pattern of patterns) {
    if (new RegExp(pattern, 'i').test(content)) {
      return true;
    }
  }
  return false;
}

/**
 * Determines if a retrieved result is relevant to the test case.
 */
export function isRelevant(result: RetrievalResult, testCase: GoldenTestCase): boolean {
  // Check file path match
  if (!matchesExpectedPath(result.filePath, testCase.expectedFilePaths)) {
    return false;
  }
  // Check content pattern match if specified
  if (!matchesContentPattern(result.content, testCase.expectedContentPatterns)) {
    return false;
  }
  // Check minimum similarity if specified
  if (testCase.minSimilarity !== undefined && result.similarity < testCase.minSimilarity) {
    return false;
  }
  return true;
}

/**
 * Computes precision at k: proportion of top-k results that are relevant.
 * precision@k = (relevant in top-k) / k
 */
export function computePrecisionAtK(
  results: RetrievalResult[],
  testCase: GoldenTestCase,
  k: number
): number {
  if (k <= 0) {
    return 0;
  }
  const topK = results.slice(0, k);
  if (topK.length === 0) {
    return 0;
  }
  const relevantCount = topK.filter((r) => isRelevant(r, testCase)).length;
  return relevantCount / k;
}

/**
 * Computes recall at k: proportion of relevant items found in top-k.
 * recall@k = (relevant in top-k) / (total relevant)
 */
export function computeRecallAtK(
  results: RetrievalResult[],
  testCase: GoldenTestCase,
  k: number
): number {
  const totalRelevant = testCase.expectedFilePaths.length;
  if (totalRelevant === 0 || k <= 0) {
    return 0;
  }
  const topK = results.slice(0, k);
  // Count unique relevant file paths found
  const foundPaths = new Set<string>();
  for (const result of topK) {
    if (isRelevant(result, testCase)) {
      // Find which expected path this matches
      for (const pattern of testCase.expectedFilePaths) {
        if (result.filePath === pattern || matchesPattern(result.filePath, pattern)) {
          foundPaths.add(pattern);
          break;
        }
      }
    }
  }
  return foundPaths.size / totalRelevant;
}

/**
 * Computes Mean Reciprocal Rank: 1 / rank of first relevant result.
 * MRR = 1 / (rank of first relevant result), or 0 if none found.
 */
export function computeMrr(results: RetrievalResult[], testCase: GoldenTestCase): number {
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result && isRelevant(result, testCase)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Evaluates a single test case against retrieved results.
 */
export function evaluateTestCase(
  testCase: GoldenTestCase,
  results: RetrievalResult[],
  kValues: number[],
  executionTimeMs: number
): TestCaseResult {
  const precisionAtK: Record<number, number> = {};
  const recallAtK: Record<number, number> = {};

  for (const k of kValues) {
    precisionAtK[k] = computePrecisionAtK(results, testCase, k);
    recallAtK[k] = computeRecallAtK(results, testCase, k);
  }

  const mrr = computeMrr(results, testCase);

  // Count relevant results found
  const relevantResults = results.filter((r) => isRelevant(r, testCase));
  const relevantFound = relevantResults.length;
  const totalExpected = testCase.expectedFilePaths.length;

  // Check if all expected items were found
  const foundPaths = new Set<string>();
  for (const result of relevantResults) {
    for (const pattern of testCase.expectedFilePaths) {
      if (result.filePath === pattern || matchesPattern(result.filePath, pattern)) {
        foundPaths.add(pattern);
      }
    }
  }
  const allFound = foundPaths.size >= totalExpected;

  return {
    allFound,
    executionTimeMs,
    mrr,
    precisionAtK,
    query: testCase.query,
    recallAtK,
    relevantFound,
    retrievedCount: results.length,
    retrievedResults: results,
    testCaseId: testCase.id,
    totalExpected,
  };
}

/**
 * Aggregates metrics across multiple test case results.
 */
export function aggregateMetrics(
  testCaseResults: TestCaseResult[],
  kValues: number[]
): AggregateMetrics {
  const successfulResults = testCaseResults.filter((r) => !r.error);
  const n = successfulResults.length;

  if (n === 0) {
    return {
      avgExecutionTimeMs: 0,
      failedEvaluations: testCaseResults.length,
      meanMrr: 0,
      meanPrecisionAtK: Object.fromEntries(kValues.map((k) => [k, 0])),
      meanRecallAtK: Object.fromEntries(kValues.map((k) => [k, 0])),
      perfectRecallRate: 0,
      successfulEvaluations: 0,
      totalTestCases: testCaseResults.length,
    };
  }

  // Compute mean precision@k
  const meanPrecisionAtK: Record<number, number> = {};
  for (const k of kValues) {
    const sum = successfulResults.reduce((acc, r) => acc + (r.precisionAtK[k] ?? 0), 0);
    meanPrecisionAtK[k] = sum / n;
  }

  // Compute mean recall@k
  const meanRecallAtK: Record<number, number> = {};
  for (const k of kValues) {
    const sum = successfulResults.reduce((acc, r) => acc + (r.recallAtK[k] ?? 0), 0);
    meanRecallAtK[k] = sum / n;
  }

  // Compute mean MRR
  const meanMrr = successfulResults.reduce((acc, r) => acc + r.mrr, 0) / n;

  // Compute perfect recall rate
  const perfectRecallCount = successfulResults.filter((r) => r.allFound).length;
  const perfectRecallRate = perfectRecallCount / n;

  // Compute average execution time
  const avgExecutionTimeMs = successfulResults.reduce((acc, r) => acc + r.executionTimeMs, 0) / n;

  return {
    avgExecutionTimeMs,
    failedEvaluations: testCaseResults.length - n,
    meanMrr,
    meanPrecisionAtK,
    meanRecallAtK,
    perfectRecallRate,
    successfulEvaluations: n,
    totalTestCases: testCaseResults.length,
  };
}
