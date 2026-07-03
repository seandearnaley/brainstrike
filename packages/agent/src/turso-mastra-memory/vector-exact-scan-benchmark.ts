import { performance } from 'node:perf_hooks';
import type { QueryResult } from '@mastra/core/vector';
import type { TursoMastraSqlClient } from './types';
import { TursoVectorStore } from './vector-store';

const DEFAULT_METRIC = 'cosine';
const DEFAULT_BATCH_SIZE = 250;
const RESOURCE_BUCKET_COUNT = 4;
const OBSERVED_AT_KEY = 'observed_at';
const RESOURCE_ID_KEY = 'resource_id';
const THREAD_ID_KEY = 'thread_id';

export interface TursoVectorExactScanBenchmarkOptions {
  readonly batchSize?: number;
  readonly database: TursoMastraSqlClient;
  readonly dimensions: number;
  readonly indexName: string;
  readonly queryCount: number;
  readonly rowCount: number;
  readonly topK: number;
  readonly warmupCount?: number;
}

export interface TursoVectorExactScanBenchmarkReport {
  readonly input: {
    readonly dimensions: number;
    readonly metric: typeof DEFAULT_METRIC;
    readonly queryCount: number;
    readonly rowCount: number;
    readonly topK: number;
    readonly warmupCount: number;
  };
  readonly queryPlans: readonly string[];
  readonly queryShape: {
    readonly metadataFilter: 'json_extract';
    readonly path: 'exact-scan';
    readonly usesVectorDistance: true;
    readonly usesVectorTopK: false;
  };
  readonly recall: {
    readonly exactTopKMatches: number;
    readonly recallAtK: number;
    readonly totalQueries: number;
  };
  readonly runtime: {
    readonly database: '@tursodatabase/database';
    readonly journalMode: 'mvcc';
  };
  readonly timingsMs: {
    readonly query: TimingDistribution;
    readonly seed: number;
  };
}

export interface TursoVectorExactScanMarkdownOptions {
  readonly command: string;
  readonly sourceCommit: string;
}

interface BenchmarkRow {
  readonly id: string;
  readonly metadata: BenchmarkMetadata;
  readonly vector: Float32Array;
}

interface BenchmarkMetadata {
  readonly observedAt: string;
  readonly resourceId: string;
  readonly threadId: string;
}

interface QueryCase {
  readonly expectedIds: readonly string[];
  readonly filter: Record<typeof OBSERVED_AT_KEY, { readonly $gte: string }> &
    Record<typeof RESOURCE_ID_KEY, string>;
  readonly vector: Float32Array;
}

interface TimingDistribution {
  readonly max: number;
  readonly mean: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
}

export async function runTursoVectorExactScanBenchmark(
  options: TursoVectorExactScanBenchmarkOptions
): Promise<TursoVectorExactScanBenchmarkReport> {
  const normalized = normalizeOptions(options);
  const store = new TursoVectorStore({ database: normalized.database });

  const journalMode = await readJournalMode(normalized.database);
  if (journalMode !== 'mvcc') {
    throw new Error(`Turso vector benchmark requires journal_mode mvcc, received ${journalMode}`);
  }

  await store.createIndex({
    dimension: normalized.dimensions,
    indexName: normalized.indexName,
    metric: DEFAULT_METRIC,
  });

  const seedStart = performance.now();
  const rows = await seedBenchmarkRows(store, normalized);
  const seedMs = performance.now() - seedStart;

  const queryCases = createQueryCases(rows, normalized.queryCount + normalized.warmupCount, {
    dimensions: normalized.dimensions,
    topK: normalized.topK,
  });

  for (const queryCase of queryCases.slice(0, normalized.warmupCount)) {
    await runQuery(store, normalized.indexName, normalized.topK, queryCase);
  }

  const measuredCases = queryCases.slice(normalized.warmupCount);
  const queryDurations: number[] = [];
  let exactTopKMatches = 0;
  let recallSum = 0;
  for (const queryCase of measuredCases) {
    const start = performance.now();
    const results = await runQuery(store, normalized.indexName, normalized.topK, queryCase);
    queryDurations.push(performance.now() - start);

    const actualIds = results.map((result) => result.id);
    if (idsMatch(actualIds, queryCase.expectedIds)) {
      exactTopKMatches += 1;
    }
    recallSum += recallAtK(actualIds, queryCase.expectedIds);
  }

  return {
    input: {
      dimensions: normalized.dimensions,
      metric: DEFAULT_METRIC,
      queryCount: normalized.queryCount,
      rowCount: normalized.rowCount,
      topK: normalized.topK,
      warmupCount: normalized.warmupCount,
    },
    queryPlans: await explainExactScanQueryPlan(
      store,
      normalized.indexName,
      normalized.topK,
      measuredCases[0]
    ),
    queryShape: {
      metadataFilter: 'json_extract',
      path: 'exact-scan',
      usesVectorDistance: true,
      usesVectorTopK: false,
    },
    recall: {
      exactTopKMatches,
      recallAtK: roundMetric(recallSum / measuredCases.length),
      totalQueries: measuredCases.length,
    },
    runtime: {
      database: '@tursodatabase/database',
      journalMode,
    },
    timingsMs: {
      query: summarizeTimings(queryDurations),
      seed: roundMs(seedMs),
    },
  };
}

export function formatTursoVectorExactScanBenchmarkMarkdown(
  report: TursoVectorExactScanBenchmarkReport,
  options: TursoVectorExactScanMarkdownOptions
): string {
  const lines = [
    '# Turso Mastra Vector Exact-Scan Baseline',
    '',
    `**Date**: ${new Date().toISOString().slice(0, 10)}`,
    `**Source commit**: \`${options.sourceCommit}\``,
    `**Reproducer**: \`${options.command}\``,
    '',
    '## Verdict',
    '',
    `The current Turso Mastra vector-memory path is characterized as an exact scan over \`mastra_vectors\` for ${report.input.rowCount} rows at ${report.input.dimensions} dimensions. The benchmark matched a deterministic JavaScript cosine-distance scorer for ${report.recall.exactTopKMatches}/${report.recall.totalQueries} queries, with recall@K ${report.recall.recallAtK.toFixed(3)}.`,
    '',
    'Native Turso vector indexes remain a separate decision because the current store preserves exact ordering semantics, supports dot-product metrics, and applies Mastra metadata filters through the shared table before `LIMIT`.',
    '',
    '## Input',
    '',
    '| field | value |',
    '| --- | ---: |',
    `| rows | ${report.input.rowCount} |`,
    `| dimensions | ${report.input.dimensions} |`,
    `| topK | ${report.input.topK} |`,
    `| measured queries | ${report.input.queryCount} |`,
    `| warmup queries | ${report.input.warmupCount} |`,
    `| metric | ${report.input.metric} |`,
    '',
    '## Query Shape',
    '',
    '| field | value |',
    '| --- | --- |',
    `| path | ${report.queryShape.path} |`,
    `| metadataFilter | ${report.queryShape.metadataFilter} |`,
    `| usesVectorDistance | ${String(report.queryShape.usesVectorDistance)} |`,
    `| usesVectorTopK | ${String(report.queryShape.usesVectorTopK)} |`,
    '',
    '## Turso Docs Context',
    '',
    '- [Turso Vector Search](https://docs.turso.tech/guides/vector-search) documents native vector values and distance functions for SQL similarity search.',
    '- [Turso AI & Embeddings](https://docs.turso.tech/features/ai-and-embeddings) documents `libsql_vector_idx` / `vector_top_k` as an explicit indexed vector-search path, which this benchmark does not use.',
    '- [Turso TypeScript Quickstart](https://docs.turso.tech/sdk/ts/quickstart) names `@tursodatabase/database` as the recommended local/embedded package for Node and Electron.',
    '',
    '## Timings',
    '',
    '| metric | ms |',
    '| --- | ---: |',
    `| seed | ${report.timingsMs.seed.toFixed(3)} |`,
    `| query min | ${report.timingsMs.query.min.toFixed(3)} |`,
    `| query p50 | ${report.timingsMs.query.p50.toFixed(3)} |`,
    `| query p95 | ${report.timingsMs.query.p95.toFixed(3)} |`,
    `| query max | ${report.timingsMs.query.max.toFixed(3)} |`,
    `| query mean | ${report.timingsMs.query.mean.toFixed(3)} |`,
    '',
    '## Query Plan',
    '',
    ...report.queryPlans.map((line) => `- \`${line}\``),
    '',
    '## Runtime',
    '',
    `- Database: \`${report.runtime.database}\``,
    `- Journal mode: \`${report.runtime.journalMode}\``,
    '',
    '## Follow-Up Trigger',
    '',
    'If expected profile sizes push exact-scan p95 beyond the team latency budget, evaluate a separate schema/index PR for `libsql_vector_idx` / `vector_top_k` with explicit recall-quality acceptance tests.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function normalizeOptions(options: TursoVectorExactScanBenchmarkOptions): Required<
  Omit<TursoVectorExactScanBenchmarkOptions, 'batchSize'>
> & {
  readonly batchSize: number;
} {
  assertPositiveInteger(options.dimensions, 'dimensions');
  assertPositiveInteger(options.queryCount, 'queryCount');
  assertPositiveInteger(options.rowCount, 'rowCount');
  assertPositiveInteger(options.topK, 'topK');
  const warmupCount = options.warmupCount ?? 0;
  if (!Number.isInteger(warmupCount) || warmupCount < 0) {
    throw new Error('warmupCount must be a non-negative integer');
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  assertPositiveInteger(batchSize, 'batchSize');
  if (!options.indexName.trim()) {
    throw new Error('indexName is required');
  }
  const smallestResourceBucket = Math.floor(options.rowCount / RESOURCE_BUCKET_COUNT);
  if (options.topK > Math.max(1, smallestResourceBucket)) {
    throw new Error(
      `topK ${options.topK} exceeds the deterministic filtered candidate floor ${smallestResourceBucket}`
    );
  }
  return {
    batchSize,
    database: options.database,
    dimensions: options.dimensions,
    indexName: options.indexName,
    queryCount: options.queryCount,
    rowCount: options.rowCount,
    topK: options.topK,
    warmupCount,
  };
}

async function seedBenchmarkRows(
  store: TursoVectorStore,
  options: ReturnType<typeof normalizeOptions>
): Promise<BenchmarkRow[]> {
  const rows: BenchmarkRow[] = [];
  for (let start = 0; start < options.rowCount; start += options.batchSize) {
    const end = Math.min(start + options.batchSize, options.rowCount);
    const batch = Array.from({ length: end - start }, (_, offset) =>
      createBenchmarkRow(start + offset, options.dimensions)
    );
    await store.upsert({
      ids: batch.map((row) => row.id),
      indexName: options.indexName,
      metadata: batch.map((row) => ({
        [OBSERVED_AT_KEY]: row.metadata.observedAt,
        [RESOURCE_ID_KEY]: row.metadata.resourceId,
        [THREAD_ID_KEY]: row.metadata.threadId,
      })),
      vectors: batch.map((row) => Array.from(row.vector)),
    });
    rows.push(...batch);
  }
  return rows;
}

function createBenchmarkRow(index: number, dimensions: number): BenchmarkRow {
  return {
    id: `message-${String(index).padStart(8, '0')}`,
    metadata: {
      observedAt: observedAtForIndex(index),
      resourceId: resourceIdForIndex(index),
      threadId: `thread-${String(index % 16).padStart(2, '0')}`,
    },
    vector: createUnitVector(index, dimensions),
  };
}

function createQueryCases(
  rows: readonly BenchmarkRow[],
  count: number,
  options: { readonly dimensions: number; readonly topK: number }
): QueryCase[] {
  return Array.from({ length: count }, (_, index) => {
    const targetIndex = Math.floor(((index + 1) * rows.length) / (count + 1));
    const target = rows[targetIndex] ?? rows[0];
    if (!target) {
      throw new Error('Cannot create benchmark query cases without rows');
    }
    const lowerObservedAt = observedAtForIndex(Math.max(0, targetIndex - 96));
    const filter = {
      [OBSERVED_AT_KEY]: {
        $gte: lowerObservedAt,
      },
      [RESOURCE_ID_KEY]: target.metadata.resourceId,
    };
    const candidateCount = countFilteredCandidates(rows, filter);
    if (candidateCount < options.topK) {
      throw new Error(
        `topK ${options.topK} exceeds the filtered candidate count ${candidateCount} for benchmark query ${index + 1}`
      );
    }
    return {
      expectedIds: scoreExpectedTopK(rows, target.vector, filter, options.topK),
      filter,
      vector: createUnitVector(targetIndex, options.dimensions),
    };
  });
}

function countFilteredCandidates(
  rows: readonly BenchmarkRow[],
  filter: QueryCase['filter']
): number {
  return rows.filter((row) => rowMatchesFilter(row, filter)).length;
}

async function runQuery(
  store: TursoVectorStore,
  indexName: string,
  topK: number,
  queryCase: QueryCase
): Promise<QueryResult[]> {
  return store.query({
    filter: queryCase.filter,
    indexName,
    queryVector: Array.from(queryCase.vector),
    topK,
  });
}

function scoreExpectedTopK(
  rows: readonly BenchmarkRow[],
  queryVector: Float32Array,
  filter: QueryCase['filter'],
  topK: number
): string[] {
  return rows
    .filter((row) => rowMatchesFilter(row, filter))
    .map((row) => ({
      distance: cosineDistance(row.vector, queryVector),
      id: row.id,
    }))
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
    .slice(0, topK)
    .map((entry) => entry.id);
}

function rowMatchesFilter(row: BenchmarkRow, filter: QueryCase['filter']): boolean {
  return (
    row.metadata.resourceId === filter[RESOURCE_ID_KEY] &&
    row.metadata.observedAt >= filter[OBSERVED_AT_KEY].$gte
  );
}

function createUnitVector(rowIndex: number, dimensions: number): Float32Array {
  const values = new Float32Array(dimensions);
  let magnitude = 0;
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    const value =
      Math.sin((rowIndex + 1) * (dimension + 3) * 0.017) +
      Math.cos((rowIndex + 7) * (dimension + 11) * 0.013) +
      ((rowIndex % 31) - 15) * 0.001;
    const component = Math.fround(value);
    values[dimension] = component;
    magnitude += component * component;
  }
  const scale = Math.sqrt(magnitude);
  if (scale === 0) {
    throw new Error('Generated benchmark vector has zero magnitude');
  }
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    values[dimension] = Math.fround((values[dimension] ?? 0) / scale);
  }
  return values;
}

function cosineDistance(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return 1 - dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

async function readJournalMode(database: TursoMastraSqlClient): Promise<'mvcc'> {
  const result = await database.query<Record<string, unknown>>('PRAGMA journal_mode');
  const row = result.rows[0];
  const journalMode = row ? Object.values(row)[0] : undefined;
  if (journalMode !== 'mvcc') {
    throw new Error(`Expected Turso journal_mode mvcc, received ${String(journalMode)}`);
  }
  return journalMode;
}

async function explainExactScanQueryPlan(
  store: TursoVectorStore,
  indexName: string,
  topK: number,
  queryCase: QueryCase | undefined
): Promise<string[]> {
  if (!queryCase) {
    throw new Error('Cannot explain a Turso vector exact-scan benchmark without measured queries');
  }
  return store.explainQueryPlan({
    filter: queryCase.filter,
    indexName,
    queryVector: Array.from(queryCase.vector),
    topK,
  });
}

function observedAtForIndex(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

function resourceIdForIndex(index: number): string {
  return `workspace-${index % RESOURCE_BUCKET_COUNT}`;
}

function summarizeTimings(values: readonly number[]): TimingDistribution {
  if (values.length === 0) {
    throw new Error('Cannot summarize empty timing set');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    max: roundMs(sorted.at(-1) ?? 0),
    mean: roundMs(sum / sorted.length),
    min: roundMs(sorted[0] ?? 0),
    p50: roundMs(percentile(sorted, 0.5)),
    p95: roundMs(percentile(sorted, 0.95)),
  };
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1)
  );
  return sortedValues[index] ?? 0;
}

function idsMatch(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function recallAtK(actual: readonly string[], expected: readonly string[]): number {
  const actualSet = new Set(actual);
  return expected.filter((id) => actualSet.has(id)).length / expected.length;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
