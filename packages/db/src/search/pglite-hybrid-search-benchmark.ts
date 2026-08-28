import { countTokensHeuristic } from '@brainstrike/tokenization';
import type { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrations/bootstrap.js';
import {
  createDimensionIndex,
  dropDimensionIndex,
  hnswParams,
} from '../migrations/dimension-index-helpers.js';
import type { FileChunkInsert } from '../models/file-chunk.js';
import { EmbeddingSetsRepository } from '../repositories/embedding-sets-repository.js';
import {
  type FileChunkDatabase,
  type FileChunkQueryTx,
  FileChunkRepository,
} from '../repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../repositories/file-record-repository.js';
import { wasmLoader } from '../wasm-loader.js';
import type {
  HybridSearchBenchmarkReport,
  HybridSearchBenchmarkThresholds,
} from './hybrid-search-benchmark.js';
import { runHybridSearchBenchmark } from './hybrid-search-benchmark.js';
import { HybridSearchService } from './hybrid-search-service.js';

export interface PGliteHybridSearchBenchmarkOptions {
  readonly dimensions: number;
  readonly iterations: number;
  readonly limit: number;
  readonly rows: number;
  readonly thresholds: HybridSearchBenchmarkThresholds;
  readonly topics: number;
  readonly warmupIterations: number;
}

export interface PGliteHybridSearchBenchmarkDependencies {
  /** Returns an isolated, fully migrated database. The benchmark closes it. */
  readonly createDatabase?: () => Promise<PGlite>;
  /** Tiny-corpus tests may force index applicability; retained baselines must not. */
  readonly forceIndexPlans?: boolean;
}

export interface PGliteHybridSearchBenchmarkReport extends HybridSearchBenchmarkReport {
  readonly corpus: {
    readonly dimensions: number;
    readonly rows: number;
    readonly topics: number;
  };
  readonly indexUsage: {
    readonly ginPlan: readonly string[];
    readonly hnswPlan: readonly string[];
    readonly plannerMode: 'natural' | 'forced';
    readonly usesGin: boolean;
    readonly usesHnsw: boolean;
  };
  readonly observations: {
    readonly minimumHybridResultCount: number;
    readonly minimumVectorOnlyResultCount: number;
    readonly vectorSourceLimit: number;
  };
}

interface BenchmarkQuery {
  readonly embedding: number[];
  readonly text: string;
}

interface CapturedStatement {
  readonly params: readonly unknown[];
  readonly sql: string;
}

interface CapturedSearchQuery extends CapturedStatement {
  readonly preamble: readonly CapturedStatement[];
}

interface SearchQueryCapture {
  lexical: CapturedSearchQuery | null;
  vector: CapturedSearchQuery | null;
}

const BENCHMARK_FILE_ID = '00000000-0000-7000-8000-000000000270';
const BENCHMARK_SET_KEY = 'benchmark::hybrid-search';
const BENCHMARK_TIMESTAMP = new Date(0).toISOString();

function captureSearchQuery(
  capture: SearchQueryCapture,
  sql: string,
  params: readonly unknown[],
  preamble: readonly CapturedStatement[]
): void {
  const query = { params: [...params], preamble: [...preamble], sql };
  if (sql.includes('content_tsvector @@')) {
    capture.lexical = query;
  }
  if (sql.includes('embedding::halfvec(')) {
    capture.vector = query;
  }
}

function createRecordingDatabase(database: PGlite, capture: SearchQueryCapture): FileChunkDatabase {
  return {
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      captureSearchQuery(capture, sql, params, []);
      return database.query<T>(sql, params);
    },
    transaction: <T>(run: (transaction: FileChunkQueryTx) => Promise<T>) =>
      database.transaction(async (transaction) => {
        const preamble: CapturedStatement[] = [];
        return run({
          query: async <TRow = unknown>(sql: string, params: unknown[] = []) => {
            if (sql.trimStart().startsWith('SET LOCAL ')) {
              preamble.push({ params: [...params], sql });
            }
            captureSearchQuery(capture, sql, params, preamble);
            return transaction.query<TRow>(sql, params);
          },
        });
      }),
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function validateOptions(options: PGliteHybridSearchBenchmarkOptions): void {
  assertPositiveInteger(options.dimensions, 'Hybrid benchmark dimensions');
  assertPositiveInteger(options.iterations, 'Hybrid benchmark iterations');
  assertPositiveInteger(options.limit, 'Hybrid benchmark limit');
  assertPositiveInteger(options.rows, 'Hybrid benchmark rows');
  assertPositiveInteger(options.topics, 'Hybrid benchmark topics');
  if (!(Number.isInteger(options.warmupIterations) && options.warmupIterations >= 0)) {
    throw new Error('Hybrid benchmark warmupIterations must be a non-negative integer.');
  }
  if (options.dimensions > 4000) {
    throw new Error('Hybrid benchmark dimensions must not exceed the halfvec HNSW limit of 4000.');
  }
  if (options.topics > options.dimensions) {
    throw new Error('Hybrid benchmark topics must not exceed dimensions.');
  }
  if (options.topics > options.rows) {
    throw new Error('Hybrid benchmark topics must not exceed rows.');
  }
  if (options.iterations % options.topics !== 0) {
    throw new Error('Hybrid benchmark iterations must be divisible by topics.');
  }
}

function normalizeEmbedding(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!(Number.isFinite(norm) && norm > 0)) {
    throw new Error('Hybrid benchmark generated an invalid embedding norm.');
  }
  return values.map((value) => value / norm);
}

function createEmbedding(topic: number, dimensions: number, rowSeed: number): number[] {
  const values = Array.from(
    { length: dimensions },
    (_, index) => Math.sin((rowSeed + 1) * (index + 1)) * 0.015
  );
  values[topic] = (values[topic] ?? 0) + 1;
  return normalizeEmbedding(values);
}

function topicLabel(topic: number): string {
  return `benchmarktopic${topic}`;
}

function createCorpus(options: PGliteHybridSearchBenchmarkOptions): FileChunkInsert[] {
  return Array.from({ length: options.rows }, (_, rowIndex) => {
    const topic = rowIndex % options.topics;
    const label = topicLabel(topic);
    const content = `${label} ${label} retrieval benchmark row ${rowIndex} validates local hybrid search relevance`;
    return {
      chunkIndex: rowIndex,
      chunkSize: content.length,
      chunkType: 'text',
      content,
      contentHash: `benchmark-hash-${rowIndex}`,
      createdAt: BENCHMARK_TIMESTAMP,
      embedding: createEmbedding(topic, options.dimensions, rowIndex),
      embeddingHash: `benchmark-embedding-${rowIndex}`,
      embeddingSetId: BENCHMARK_SET_KEY,
      embeddingUpdatedAt: BENCHMARK_TIMESTAMP,
      fileRecordId: BENCHMARK_FILE_ID,
      id: `benchmark-chunk-${rowIndex}`,
      tokenCount: countTokensHeuristic(content),
      updatedAt: BENCHMARK_TIMESTAMP,
    };
  });
}

function createQueries(options: PGliteHybridSearchBenchmarkOptions): BenchmarkQuery[] {
  return Array.from({ length: options.topics }, (_, topic) => ({
    embedding: createEmbedding(topic, options.dimensions, options.rows + topic),
    text: topicLabel(topic),
  }));
}

async function createDefaultDatabase(): Promise<PGlite> {
  const database = await wasmLoader.createPGlite(
    `memory://hybrid-search-benchmark-${crypto.randomUUID()}`
  );
  await migrate(database);
  return database;
}

function readPlanRows(result: { rows: unknown[] }): string[] {
  return result.rows.map((row) => {
    if (!(row && typeof row === 'object' && 'QUERY PLAN' in row)) {
      throw new Error('Hybrid benchmark EXPLAIN returned a malformed plan row.');
    }
    const plan = (row as { 'QUERY PLAN': unknown })['QUERY PLAN'];
    if (typeof plan !== 'string') {
      throw new Error('Hybrid benchmark EXPLAIN plan text must be a string.');
    }
    return plan;
  });
}

async function explainIndexUsage(
  database: PGlite,
  capture: SearchQueryCapture,
  dimensions: number,
  forceIndexPlans: boolean
): Promise<PGliteHybridSearchBenchmarkReport['indexUsage']> {
  if (!(capture.lexical && capture.vector)) {
    throw new Error(
      `Hybrid benchmark did not capture both measured search statements (lexical=${String(Boolean(capture.lexical))}, vector=${String(Boolean(capture.vector))}).`
    );
  }
  const lexicalQuery = capture.lexical;
  const vectorQuery = capture.vector;
  return database.transaction(async (transaction) => {
    for (const statement of vectorQuery.preamble) {
      await transaction.query(statement.sql, [...statement.params]);
    }
    if (forceIndexPlans) {
      await transaction.query('SET LOCAL enable_seqscan = off');
    }
    const [ginResult, hnswResult] = await Promise.all([
      transaction.query(`EXPLAIN ${lexicalQuery.sql}`, [...lexicalQuery.params]),
      transaction.query(`EXPLAIN ${vectorQuery.sql}`, [...vectorQuery.params]),
    ]);
    const ginPlan = readPlanRows(ginResult);
    const hnswPlan = readPlanRows(hnswResult);
    return {
      ginPlan,
      hnswPlan,
      plannerMode: forceIndexPlans ? 'forced' : 'natural',
      usesGin: ginPlan.some((line) => line.includes('idx_file_chunks_content_tsvector')),
      usesHnsw: hnswPlan.some((line) => line.includes(`idx_file_chunks_emb_hnsw_${dimensions}`)),
    };
  });
}

export async function runPGliteHybridSearchBenchmark(
  options: PGliteHybridSearchBenchmarkOptions,
  dependencies: PGliteHybridSearchBenchmarkDependencies = {}
): Promise<PGliteHybridSearchBenchmarkReport> {
  validateOptions(options);
  const database = await (dependencies.createDatabase ?? createDefaultDatabase)();
  try {
    const queryCapture: SearchQueryCapture = { lexical: null, vector: null };
    const fileRepository = new FileRecordRepository(database);
    const chunkRepository = new FileChunkRepository(
      createRecordingDatabase(database, queryCapture)
    );
    const embeddingSetRepository = new EmbeddingSetsRepository(database);
    const embeddingSet = await embeddingSetRepository.getOrCreateSet(
      BENCHMARK_SET_KEY,
      'hybrid-search-benchmark',
      options.dimensions,
      'cosine',
      { name: 'Hybrid search benchmark' }
    );
    await embeddingSetRepository.waitForPendingDimensionIndexBuilds();
    await dropDimensionIndex(database, options.dimensions);
    await fileRepository.create({
      createdAt: BENCHMARK_TIMESTAMP,
      id: BENCHMARK_FILE_ID,
      name: 'hybrid-search-benchmark.txt',
      path: '/benchmark/hybrid-search-benchmark.txt',
      size: options.rows,
      updatedAt: BENCHMARK_TIMESTAMP,
    });
    const corpus = createCorpus(options).map((chunk) => ({
      ...chunk,
      embeddingSetId: embeddingSet.id,
    }));
    await chunkRepository.insertMany(corpus);
    await createDimensionIndex(database, options.dimensions, hnswParams());
    await database.query('ANALYZE file_chunks');

    const queries = createQueries(options);
    const vectorSourceLimit = Math.max(options.limit * 5, 50);
    const service = new HybridSearchService(chunkRepository);
    let hybridQueryIndex = 0;
    let vectorQueryIndex = 0;
    let minimumHybridResultCount = Number.POSITIVE_INFINITY;
    let minimumVectorOnlyResultCount = Number.POSITIVE_INFINITY;

    const measurement = await runHybridSearchBenchmark({
      iterations: options.iterations,
      runHybrid: async () => {
        const query = queries[hybridQueryIndex % queries.length];
        hybridQueryIndex += 1;
        if (!query) {
          throw new Error('Hybrid benchmark could not resolve its query.');
        }
        const response = await service.search(query.text, query.embedding, {
          embeddingSetId: embeddingSet.id,
          ftsLimit: vectorSourceLimit,
          includeHeadline: false,
          limit: options.limit,
          vectorLimit: vectorSourceLimit,
          vectorThreshold: 0,
        });
        minimumHybridResultCount = Math.min(minimumHybridResultCount, response.results.length);
      },
      runVectorOnly: async () => {
        const query = queries[vectorQueryIndex % queries.length];
        vectorQueryIndex += 1;
        if (!query) {
          throw new Error('Hybrid benchmark could not resolve its vector query.');
        }
        const results = await chunkRepository.searchSimilar(query.embedding, {
          embeddingSetId: embeddingSet.id,
          limit: vectorSourceLimit,
          threshold: 0,
        });
        minimumVectorOnlyResultCount = Math.min(minimumVectorOnlyResultCount, results.length);
      },
      thresholds: options.thresholds,
      warmupIterations: options.warmupIterations,
    });
    const indexUsage = await explainIndexUsage(
      database,
      queryCapture,
      options.dimensions,
      dependencies.forceIndexPlans ?? false
    );
    const failures = [...measurement.failures];
    if (!indexUsage.usesHnsw) {
      failures.push(`HNSW plan did not select idx_file_chunks_emb_hnsw_${options.dimensions}`);
    }
    if (minimumHybridResultCount <= 0) {
      failures.push('hybrid benchmark returned no results');
    }
    if (minimumVectorOnlyResultCount <= 0) {
      failures.push('vector-only benchmark returned no results');
    }

    return {
      ...measurement,
      corpus: {
        dimensions: options.dimensions,
        rows: options.rows,
        topics: options.topics,
      },
      failures,
      indexUsage,
      observations: {
        minimumHybridResultCount: Number.isFinite(minimumHybridResultCount)
          ? minimumHybridResultCount
          : 0,
        minimumVectorOnlyResultCount: Number.isFinite(minimumVectorOnlyResultCount)
          ? minimumVectorOnlyResultCount
          : 0,
        vectorSourceLimit,
      },
      passed: failures.length === 0,
    };
  } finally {
    await database.close();
  }
}
