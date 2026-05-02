import type { BrowserPGliteStorageSelection } from './browser-pglite-storage.js';

export interface BrowserPGliteStorageBenchmarkClient {
  readonly close?: () => Promise<void>;
  readonly exec: (sql: string) => Promise<unknown>;
  readonly query: <T = unknown>(sql: string) => Promise<{ rows: T[] }>;
}

export interface BrowserPGliteStorageBenchmarkAdapter {
  readonly clock?: () => number;
  readonly createClient: (
    selection: BrowserPGliteStorageSelection
  ) => Promise<BrowserPGliteStorageBenchmarkClient>;
  readonly rows?: number;
  readonly selections: readonly BrowserPGliteStorageSelection[];
}

export interface BrowserPGliteStorageBenchmarkStep {
  readonly elapsedMs: number;
  readonly name:
    | 'bootstrap'
    | 'file-record-insert'
    | 'chunk-record-insert'
    | 'count-query'
    | 'vector-query';
}

export interface BrowserPGliteStorageBenchmarkResult {
  readonly dataDir: string;
  readonly reason: BrowserPGliteStorageSelection['reason'];
  readonly rows: number;
  readonly steps: readonly BrowserPGliteStorageBenchmarkStep[];
  readonly storage: BrowserPGliteStorageSelection['storage'];
  readonly totalMs: number;
}

const DEFAULT_BENCHMARK_ROWS = 200;

export async function runBrowserPGliteStorageBenchmark({
  clock = () => performance.now(),
  createClient,
  rows = DEFAULT_BENCHMARK_ROWS,
  selections,
}: BrowserPGliteStorageBenchmarkAdapter): Promise<BrowserPGliteStorageBenchmarkResult[]> {
  const benchmarkRows = toPositiveInteger(rows);
  const results: BrowserPGliteStorageBenchmarkResult[] = [];

  for (const selection of selections) {
    const client = await createClient(selection);
    const steps: BrowserPGliteStorageBenchmarkStep[] = [];
    const startedAt = clock();
    try {
      await measureStep(clock, steps, 'bootstrap', async () => {
        await client.exec(`
          CREATE EXTENSION IF NOT EXISTS vector;
          DROP TABLE IF EXISTS bst_storage_benchmark_chunks;
          DROP TABLE IF EXISTS bst_storage_benchmark_files;
          CREATE TABLE IF NOT EXISTS bst_storage_benchmark_files (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            token_count INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS bst_storage_benchmark_chunks (
            id TEXT PRIMARY KEY,
            file_id TEXT NOT NULL REFERENCES bst_storage_benchmark_files(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            embedding vector(3) NOT NULL
          );
          CREATE INDEX IF NOT EXISTS bst_storage_benchmark_chunks_embedding_hnsw
            ON bst_storage_benchmark_chunks USING hnsw (embedding vector_cosine_ops);
        `);
      });

      await measureStep(clock, steps, 'file-record-insert', async () => {
        await client.exec(buildFileRecordInsert(benchmarkRows));
      });

      await measureStep(clock, steps, 'chunk-record-insert', async () => {
        await client.exec(buildChunkRecordInsert(benchmarkRows));
      });

      await measureStep(clock, steps, 'count-query', async () => {
        await client.query(`
          SELECT COUNT(*)::int AS chunks
          FROM bst_storage_benchmark_chunks
          WHERE content LIKE 'benchmark chunk %';
        `);
      });

      await measureStep(clock, steps, 'vector-query', async () => {
        await client.query(`
          SELECT id
          FROM bst_storage_benchmark_chunks
          ORDER BY embedding <-> '[0.1,0.2,0.3]'::vector
          LIMIT 20;
        `);
      });
    } finally {
      await client.close?.();
    }

    results.push({
      dataDir: selection.dataDir,
      reason: selection.reason,
      rows: benchmarkRows,
      steps,
      storage: selection.storage,
      totalMs: clock() - startedAt,
    });
  }

  return results;
}

async function measureStep(
  clock: () => number,
  steps: BrowserPGliteStorageBenchmarkStep[],
  name: BrowserPGliteStorageBenchmarkStep['name'],
  run: () => Promise<void>
): Promise<void> {
  const startedAt = clock();
  await run();
  steps.push({
    elapsedMs: clock() - startedAt,
    name,
  });
}

function buildFileRecordInsert(rows: number): string {
  return `
    INSERT INTO bst_storage_benchmark_files (id, path, content_hash, token_count)
    SELECT
      'file-' || series::text,
      '/benchmark/file-' || series::text || '.md',
      'hash-' || series::text,
      128 + series
    FROM generate_series(1, ${toPositiveInteger(rows)}) AS series;
  `;
}

function buildChunkRecordInsert(rows: number): string {
  return `
    INSERT INTO bst_storage_benchmark_chunks (id, file_id, content, embedding)
    SELECT
      'chunk-' || series::text,
      'file-' || series::text,
      'benchmark chunk ' || series::text,
      ('[' ||
        ((series % 10)::float / 10)::text || ',' ||
        (((series + 3) % 10)::float / 10)::text || ',' ||
        (((series + 6) % 10)::float / 10)::text ||
      ']')::vector
    FROM generate_series(1, ${toPositiveInteger(rows)}) AS series;
  `;
}

function toPositiveInteger(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`Expected a positive integer row count, got ${value}`);
  }
  return value;
}
