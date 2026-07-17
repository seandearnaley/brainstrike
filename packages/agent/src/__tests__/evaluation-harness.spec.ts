/**
 * Tests for the retrieval evaluation harness (BST-175)
 */

import { describe, expect, it, vi } from 'vitest';
import type { GoldenTestCase, RetrievalResult, TestCaseResult } from '../evaluation';
import {
  aggregateMetrics,
  computeMrr,
  computePrecisionAtK,
  computeRecallAtK,
  createMockDataset,
  formatReport,
  formatReportJson,
  isRelevant,
  matchesContentPattern,
  matchesExpectedPath,
  meetsThresholds,
  runEvaluationHarness,
} from '../evaluation';

describe('matchesExpectedPath', () => {
  it('matches exact path', () => {
    expect(matchesExpectedPath('src/file.ts', ['src/file.ts'])).toBe(true);
  });

  it('matches glob pattern', () => {
    expect(matchesExpectedPath('src/utils/helper.ts', ['**/utils/**/*.ts'])).toBe(true);
  });

  it('does not match unrelated path', () => {
    expect(matchesExpectedPath('src/other.ts', ['**/utils/**/*.ts'])).toBe(false);
  });

  it('matches with matchBase option', () => {
    expect(matchesExpectedPath('deep/nested/file.ts', ['*.ts'])).toBe(true);
  });
});

describe('matchesContentPattern', () => {
  it('returns true when no patterns specified', () => {
    expect(matchesContentPattern('any content', undefined)).toBe(true);
    expect(matchesContentPattern('any content', [])).toBe(true);
  });

  it('matches regex pattern', () => {
    expect(matchesContentPattern('function authenticate() {}', ['authenticate'])).toBe(true);
  });

  it('is case insensitive', () => {
    expect(matchesContentPattern('function Authenticate() {}', ['authenticate'])).toBe(true);
  });

  it('does not match unrelated content', () => {
    expect(matchesContentPattern('function login() {}', ['authenticate'])).toBe(false);
  });
});

describe('isRelevant', () => {
  const testCase: GoldenTestCase = {
    expectedContentPatterns: ['authenticate'],
    expectedFilePaths: ['src/auth/**/*.ts'],
    id: 'test-001',
    minSimilarity: 0.5,
    query: 'test query',
  };

  it('returns true when all criteria match', () => {
    const result: RetrievalResult = {
      content: 'function authenticate() {}',
      filePath: 'src/auth/login.ts',
      rank: 1,
      similarity: 0.8,
    };
    expect(isRelevant(result, testCase)).toBe(true);
  });

  it('returns false when path does not match', () => {
    const result: RetrievalResult = {
      content: 'function authenticate() {}',
      filePath: 'src/utils/helper.ts',
      rank: 1,
      similarity: 0.8,
    };
    expect(isRelevant(result, testCase)).toBe(false);
  });

  it('returns false when content does not match', () => {
    const result: RetrievalResult = {
      content: 'function login() {}',
      filePath: 'src/auth/login.ts',
      rank: 1,
      similarity: 0.8,
    };
    expect(isRelevant(result, testCase)).toBe(false);
  });

  it('returns false when similarity is below threshold', () => {
    const result: RetrievalResult = {
      content: 'function authenticate() {}',
      filePath: 'src/auth/login.ts',
      rank: 1,
      similarity: 0.3,
    };
    expect(isRelevant(result, testCase)).toBe(false);
  });
});

describe('computePrecisionAtK', () => {
  const testCase: GoldenTestCase = {
    expectedFilePaths: ['src/a.ts', 'src/b.ts'],
    id: 'test-001',
    query: 'test',
  };

  it('computes precision correctly', () => {
    const results: RetrievalResult[] = [
      { content: '', filePath: 'src/a.ts', rank: 1, similarity: 0.9 },
      { content: '', filePath: 'src/c.ts', rank: 2, similarity: 0.8 },
      { content: '', filePath: 'src/b.ts', rank: 3, similarity: 0.7 },
    ];
    // P@1 = 1/1 = 1, P@2 = 1/2 = 0.5, P@3 = 2/3 = 0.667
    expect(computePrecisionAtK(results, testCase, 1)).toBe(1);
    expect(computePrecisionAtK(results, testCase, 2)).toBe(0.5);
    expect(computePrecisionAtK(results, testCase, 3)).toBeCloseTo(0.667, 2);
  });

  it('returns 0 for empty results', () => {
    expect(computePrecisionAtK([], testCase, 5)).toBe(0);
  });

  it('returns 0 for k=0', () => {
    const results: RetrievalResult[] = [
      { content: '', filePath: 'src/a.ts', rank: 1, similarity: 0.9 },
    ];
    expect(computePrecisionAtK(results, testCase, 0)).toBe(0);
  });
});

describe('computeRecallAtK', () => {
  const testCase: GoldenTestCase = {
    expectedFilePaths: ['src/a.ts', 'src/b.ts'],
    id: 'test-001',
    query: 'test',
  };

  it('computes recall correctly', () => {
    const results: RetrievalResult[] = [
      { content: '', filePath: 'src/a.ts', rank: 1, similarity: 0.9 },
      { content: '', filePath: 'src/c.ts', rank: 2, similarity: 0.8 },
      { content: '', filePath: 'src/b.ts', rank: 3, similarity: 0.7 },
    ];
    // R@1 = 1/2 = 0.5, R@2 = 1/2 = 0.5, R@3 = 2/2 = 1
    expect(computeRecallAtK(results, testCase, 1)).toBe(0.5);
    expect(computeRecallAtK(results, testCase, 2)).toBe(0.5);
    expect(computeRecallAtK(results, testCase, 3)).toBe(1);
  });

  it('returns 0 for empty expected paths', () => {
    const emptyCase: GoldenTestCase = { expectedFilePaths: [], id: 't', query: 'q' };
    const results: RetrievalResult[] = [
      { content: '', filePath: 'src/a.ts', rank: 1, similarity: 0.9 },
    ];
    expect(computeRecallAtK(results, emptyCase, 1)).toBe(0);
  });
});

describe('computeMrr', () => {
  const testCase: GoldenTestCase = {
    expectedFilePaths: ['src/a.ts'],
    id: 'test-001',
    query: 'test',
  };

  it('returns 1 when first result is relevant', () => {
    const results: RetrievalResult[] = [
      { content: '', filePath: 'src/a.ts', rank: 1, similarity: 0.9 },
    ];
    expect(computeMrr(results, testCase)).toBe(1);
  });

  it('returns 0.5 when second result is relevant', () => {
    const results: RetrievalResult[] = [
      { content: '', filePath: 'src/b.ts', rank: 1, similarity: 0.9 },
      { content: '', filePath: 'src/a.ts', rank: 2, similarity: 0.8 },
    ];
    expect(computeMrr(results, testCase)).toBe(0.5);
  });

  it('returns 0 when no relevant results', () => {
    const results: RetrievalResult[] = [
      { content: '', filePath: 'src/b.ts', rank: 1, similarity: 0.9 },
    ];
    expect(computeMrr(results, testCase)).toBe(0);
  });
});

describe('aggregateMetrics', () => {
  it('computes aggregate metrics correctly', () => {
    const results: TestCaseResult[] = [
      {
        allFound: true,
        executionTimeMs: 100,
        mrr: 1,
        precisionAtK: { 1: 1, 3: 0.67 },
        query: 'q1',
        recallAtK: { 1: 0.5, 3: 1 },
        relevantFound: 2,
        retrievedCount: 3,
        retrievedResults: [],
        testCaseId: 't1',
        totalExpected: 2,
      },
      {
        allFound: false,
        executionTimeMs: 200,
        mrr: 0.5,
        precisionAtK: { 1: 0, 3: 0.33 },
        query: 'q2',
        recallAtK: { 1: 0, 3: 0.5 },
        relevantFound: 1,
        retrievedCount: 3,
        retrievedResults: [],
        testCaseId: 't2',
        totalExpected: 2,
      },
    ];

    const agg = aggregateMetrics(results, [1, 3]);

    expect(agg.totalTestCases).toBe(2);
    expect(agg.successfulEvaluations).toBe(2);
    expect(agg.failedEvaluations).toBe(0);
    expect(agg.meanMrr).toBe(0.75);
    expect(agg.perfectRecallRate).toBe(0.5);
    expect(agg.avgExecutionTimeMs).toBe(150);
    expect(agg.meanPrecisionAtK[1]).toBe(0.5);
    expect(agg.meanRecallAtK[3]).toBe(0.75);
  });

  it('handles empty results', () => {
    const agg = aggregateMetrics([], [1, 3]);
    expect(agg.totalTestCases).toBe(0);
    expect(agg.successfulEvaluations).toBe(0);
  });

  it('excludes failed evaluations from aggregates', () => {
    const results: TestCaseResult[] = [
      {
        allFound: true,
        executionTimeMs: 100,
        mrr: 1,
        precisionAtK: { 1: 1 },
        query: 'q1',
        recallAtK: { 1: 1 },
        relevantFound: 1,
        retrievedCount: 1,
        retrievedResults: [],
        testCaseId: 't1',
        totalExpected: 1,
      },
      {
        allFound: false,
        error: 'Something went wrong',
        executionTimeMs: 50,
        mrr: 0,
        precisionAtK: { 1: 0 },
        query: 'q2',
        recallAtK: { 1: 0 },
        relevantFound: 0,
        retrievedCount: 0,
        retrievedResults: [],
        testCaseId: 't2',
        totalExpected: 1,
      },
    ];

    const agg = aggregateMetrics(results, [1]);
    expect(agg.totalTestCases).toBe(2);
    expect(agg.successfulEvaluations).toBe(1);
    expect(agg.failedEvaluations).toBe(1);
    expect(agg.meanMrr).toBe(1); // Only from successful
  });
});

describe('runEvaluationHarness', () => {
  it('runs evaluation with mock search', async () => {
    const dataset = createMockDataset();
    const mockSearch = vi.fn().mockResolvedValue([
      { content: 'test', filePath: 'src/file-a.ts', rank: 1, similarity: 0.9 },
      { content: 'test', filePath: 'src/file-b.ts', rank: 2, similarity: 0.8 },
    ]);

    const report = await runEvaluationHarness(dataset, {
      config: { kValues: [1, 3] },
      search: mockSearch,
    });

    expect(report.datasetName).toBe('mock-ci-dataset');
    expect(report.testCaseResults.length).toBe(3);
    expect(mockSearch).toHaveBeenCalledTimes(3);
  });

  it('handles search errors gracefully', async () => {
    const dataset = createMockDataset();
    const mockSearch = vi.fn().mockRejectedValue(new Error('Search failed'));

    const report = await runEvaluationHarness(dataset, {
      config: { kValues: [1] },
      search: mockSearch,
    });

    expect(report.aggregateMetrics.failedEvaluations).toBe(3);
    expect(report.testCaseResults[0]?.error).toBe('Search failed');
  });
});

describe('formatReport', () => {
  it('produces human-readable output', async () => {
    const dataset = createMockDataset();
    const mockSearch = vi
      .fn()
      .mockResolvedValue([
        { content: 'test', filePath: 'src/file-a.ts', rank: 1, similarity: 0.9 },
      ]);

    const report = await runEvaluationHarness(dataset, {
      config: { kValues: [1, 3] },
      search: mockSearch,
    });

    const formatted = formatReport(report);
    expect(formatted).toContain('Retrieval Evaluation Report');
    expect(formatted).toContain('mock-ci-dataset');
    expect(formatted).toContain('P@1:');
    expect(formatted).toContain('R@1:');
  });
});

describe('formatReportJson', () => {
  it('produces valid JSON', async () => {
    const dataset = createMockDataset();
    const mockSearch = vi.fn().mockResolvedValue([]);

    const report = await runEvaluationHarness(dataset, {
      config: { kValues: [1] },
      search: mockSearch,
    });

    const json = formatReportJson(report);
    const parsed = JSON.parse(json);
    expect(parsed.dataset.name).toBe('mock-ci-dataset');
    expect(parsed.summary).toBeDefined();
  });
});

describe('meetsThresholds', () => {
  it('passes when all thresholds met', async () => {
    // Create a dataset where we can control exact matching
    const dataset = createMockDataset();
    // Return results that match ALL test cases in the mock dataset:
    // - mock-001: expects ['src/file-a.ts', 'src/file-b.ts']
    // - mock-002: expects ['src/utils/*.ts'] with content pattern 'util'
    // - mock-003: expects ['src/components/**/*.tsx']
    const mockSearch = vi.fn().mockImplementation((query: string) => {
      if (query === 'test query one') {
        return Promise.resolve([
          { content: 'test', filePath: 'src/file-a.ts', rank: 1, similarity: 0.9 },
          { content: 'test', filePath: 'src/file-b.ts', rank: 2, similarity: 0.8 },
        ]);
      }
      if (query === 'test query two') {
        return Promise.resolve([
          { content: 'util function', filePath: 'src/utils/helper.ts', rank: 1, similarity: 0.9 },
        ]);
      }
      if (query === 'test query three') {
        return Promise.resolve([
          { content: 'component', filePath: 'src/components/Button.tsx', rank: 1, similarity: 0.9 },
        ]);
      }
      return Promise.resolve([]);
    });

    const report = await runEvaluationHarness(dataset, {
      config: { kValues: [1, 3] },
      search: mockSearch,
    });

    // All test cases should have MRR = 1 since first result matches
    const result = meetsThresholds(report, {
      maxFailedEvaluations: 0,
      minMeanMrr: 0.9,
    });

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails when thresholds not met', () => {
    const report = {
      aggregateMetrics: {
        avgExecutionTimeMs: 100,
        failedEvaluations: 1,
        meanMrr: 0.3,
        meanPrecisionAtK: { 1: 0.3 },
        meanRecallAtK: { 1: 0.3 },
        perfectRecallRate: 0.2,
        successfulEvaluations: 4,
        totalTestCases: 5,
      },
      datasetName: 'test',
      datasetVersion: '1.0',
      kValues: [1],
      testCaseResults: [],
      timestamp: new Date().toISOString(),
    };

    const result = meetsThresholds(report, {
      maxFailedEvaluations: 0,
      minMeanMrr: 0.5,
      minPerfectRecallRate: 0.5,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.length).toBe(3);
  });
});
