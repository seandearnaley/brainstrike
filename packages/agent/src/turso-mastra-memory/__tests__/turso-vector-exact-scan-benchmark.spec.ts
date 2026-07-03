import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  TursoMastraQueryResult,
  TursoMastraQueryValues,
  TursoMastraSqlClient,
} from '../types';
import {
  formatTursoVectorExactScanBenchmarkMarkdown,
  runTursoVectorExactScanBenchmark,
  type TursoVectorExactScanBenchmarkReport,
} from '../vector-exact-scan-benchmark';
import { parseTursoVectorExactScanBenchmarkArgs } from '../vector-exact-scan-benchmark-cli';
import { createTursoTestClient, type TursoTestClient } from './turso-test-client';

describe('Turso Mastra vector exact-scan benchmark', () => {
  let runtime: TursoTestClient;

  beforeEach(async () => {
    runtime = await createTursoTestClient('brainstrike-turso-vector-bench-');
  });

  afterEach(async () => {
    await runtime.close();
  });

  it('reports exact-scan recall and bounded timing evidence without raw vectors', async () => {
    const report = await runTursoVectorExactScanBenchmark({
      database: runtime.client,
      dimensions: 32,
      indexName: 'memory_observations_profile',
      queryCount: 4,
      rowCount: 256,
      topK: 5,
      warmupCount: 1,
    });

    expect(report).toMatchObject<TursoVectorExactScanBenchmarkReport>({
      input: {
        dimensions: 32,
        metric: 'cosine',
        queryCount: 4,
        rowCount: 256,
        topK: 5,
        warmupCount: 1,
      },
      queryShape: {
        metadataFilter: 'json_extract',
        path: 'exact-scan',
        usesVectorDistance: true,
        usesVectorTopK: false,
      },
      recall: {
        exactTopKMatches: 4,
        recallAtK: 1,
        totalQueries: 4,
      },
      runtime: {
        database: '@tursodatabase/database',
        journalMode: 'mvcc',
      },
    });
    expect(report.timingsMs.seed).toBeGreaterThanOrEqual(0);
    expect(report.timingsMs.query.p50).toBeGreaterThanOrEqual(0);
    expect(report.timingsMs.query.p95).toBeGreaterThanOrEqual(report.timingsMs.query.p50);
    expect(report.queryPlans.some((line) => line.includes('mastra_vectors'))).toBe(true);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('queryVector');
    expect(serialized).not.toContain('embedding');
    expect(serialized).not.toMatch(/\[[0-9., -]{20,}\]/);
  });

  it('explains the same metadata-filtered exact-scan shape as measured queries', async () => {
    const explainCalls: Array<{ sql: string; values: TursoMastraQueryValues | undefined }> = [];
    const instrumentedClient: TursoMastraSqlClient = {
      exec: (sql, values) => runtime.client.exec(sql, values),
      query: async <TRecord extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        values?: TursoMastraQueryValues
      ): Promise<TursoMastraQueryResult<TRecord>> => {
        if (/^\s*EXPLAIN QUERY PLAN/i.test(sql)) {
          explainCalls.push({ sql, values });
        }
        return runtime.client.query<TRecord>(sql, values);
      },
      transaction: (fn) => runtime.client.transaction((tx) => fn(tx)),
    };

    await runTursoVectorExactScanBenchmark({
      database: instrumentedClient,
      dimensions: 16,
      indexName: 'memory_observations_explain',
      queryCount: 2,
      rowCount: 128,
      topK: 4,
    });

    expect(explainCalls).toHaveLength(1);
    const [explainCall] = explainCalls;
    expect(explainCall?.sql).toContain('vector_distance_cos');
    expect(explainCall?.values).toContain('$.resource_id');
    expect(explainCall?.values).toContain('$.observed_at');
  });

  it('rejects topK values that exceed the measured query filtered candidate set', async () => {
    await expect(
      runTursoVectorExactScanBenchmark({
        database: runtime.client,
        dimensions: 4,
        indexName: 'memory_observations_candidate_floor',
        queryCount: 1,
        rowCount: 512,
        topK: 120,
      })
    ).rejects.toThrow(/topK 120 exceeds the filtered candidate count/i);
  });

  it('formats a durable markdown report with reproducer and decision boundary', async () => {
    const report = await runTursoVectorExactScanBenchmark({
      database: runtime.client,
      dimensions: 16,
      indexName: 'memory_observations_report',
      queryCount: 2,
      rowCount: 128,
      topK: 4,
    });

    const markdown = formatTursoVectorExactScanBenchmarkMarkdown(report, {
      command:
        'pnpm --filter @brainstrike/agent run bench:turso-vector-memory -- --rows 128 --dimensions 16',
      sourceCommit: 'test-commit',
    });

    expect(markdown).toContain('# Turso Mastra Vector Exact-Scan Baseline');
    expect(markdown).toContain('path | exact-scan');
    expect(markdown).toContain('usesVectorTopK | false');
    expect(markdown).toContain('test-commit');
    expect(markdown).toContain('bench:turso-vector-memory');
    expect(markdown).toContain('https://docs.turso.tech/guides/vector-search');
    expect(markdown).toContain('https://docs.turso.tech/features/ai-and-embeddings');
    expect(markdown).toContain('Native Turso vector indexes remain a separate decision');
    expect(markdown).not.toMatch(/"embedding"\s*:/);
    expect(markdown).not.toMatch(/\[[0-9., -]{20,}\]/);
  });

  it('parses benchmark CLI arguments without guessing missing required values', () => {
    expect(
      parseTursoVectorExactScanBenchmarkArgs([
        '--rows',
        '1000',
        '--dimensions',
        '384',
        '--queries',
        '8',
        '--warmup',
        '2',
        '--top-k',
        '6',
        '--out',
        'docs/turso-migration/vector-baseline.md',
      ])
    ).toEqual({
      dimensions: 384,
      out: 'docs/turso-migration/vector-baseline.md',
      queries: 8,
      rows: 1000,
      topK: 6,
      warmup: 2,
    });

    expect(() =>
      parseTursoVectorExactScanBenchmarkArgs(['--rows', '1000', '--queries', '8'])
    ).toThrow(/--dimensions is required/i);

    expect(
      parseTursoVectorExactScanBenchmarkArgs([
        '--',
        '--rows',
        '1000',
        '--dimensions',
        '384',
        '--queries',
        '8',
        '--top-k',
        '6',
        '--out',
        'report.md',
      ])
    ).toMatchObject({ dimensions: 384, out: 'report.md', rows: 1000 });
  });
});
