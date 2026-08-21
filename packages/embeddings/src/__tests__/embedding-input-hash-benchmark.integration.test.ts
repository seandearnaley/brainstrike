import type { IDatabase, Job } from '@brainstrike/db';
import { JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import {
  buildEmbeddingInputHash,
  buildEmbeddingJobInputHashes,
} from '@brainstrike/indexing-contract';
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import {
  type ClaimedEmbeddingJob,
  loadAndFilterChunks,
} from '../worker/embedding-worker-chunk-filter.js';
import { loadChunksBatch } from '../worker/embedding-worker-db-io.js';
import { assertEmbedChunkJob } from '../worker/embedding-worker-job-payload.js';

const BENCHMARK_TIMEOUT_MS = 90_000;
const MODEL_KEY = 'local::benchmark-model';
const MEASURED_ITERATIONS = 7;
const WARMUP_ITERATIONS = 2;

interface HashRelocationBenchmarkResult {
  readonly batchSize: number;
  readonly contentLength: number;
  readonly legacyWorkerHotPathMs: number;
  readonly persistedWorkerHotPathMs: number;
  readonly producerHashMs: number;
  readonly relocatedEndToEndMs: number;
}

interface FilterCounts {
  readonly completed: number;
  readonly toProcess: number;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const value = sorted[midpoint];
  if (value === undefined) {
    throw new Error('Cannot calculate a benchmark median without samples.');
  }
  return value;
}

async function measureMedian(operation: () => Promise<void>): Promise<number> {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    await operation();
  }

  const samples: number[] = [];
  for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }
  return median(samples);
}

async function seedScenario(
  db: PGlite,
  batchSize: number,
  contentLength: number
): Promise<{
  readonly contentHashes: readonly string[];
  readonly jobs: ClaimedEmbeddingJob[];
}> {
  const scenario = `b${batchSize}-c${contentLength}`;
  const now = new Date().toISOString();
  const fileId = `file-${scenario}`;
  const embeddingSetId = `set-${scenario}`;
  await db.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
     VALUES ($1, $2, 'benchmark-model', 8, 'cosine', $3)`,
    [embeddingSetId, MODEL_KEY, now]
  );
  await db.query(
    `INSERT INTO file_records
       (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'benchmark fixture', $5, 16, $6, $6)`,
    [fileId, `${scenario}.txt`, `/${scenario}.txt`, contentLength, `file-hash-${scenario}`, now]
  );

  const contentHashes = Array.from(
    { length: batchSize },
    (_, index) => `content-hash-${scenario}-${index}`
  );
  const embeddingInputHashes = await buildEmbeddingJobInputHashes(contentHashes, MODEL_KEY);
  const queue = new JobQueue(db as unknown as IDatabase);
  const jobs: Job[] = [];

  for (let index = 0; index < batchSize; index += 1) {
    const chunkId = `chunk-${scenario}-${index}`;
    const contentHash = contentHashes[index];
    const embeddingInputHash = embeddingInputHashes[index];
    if (!(contentHash && embeddingInputHash)) {
      throw new Error(`Missing benchmark identity for chunk '${chunkId}'.`);
    }
    await db.query(
      `INSERT INTO file_chunks
         (id, file_record_id, chunk_index, content, content_hash, token_count,
          chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 16, 'text', $6, $7, $7)`,
      [chunkId, fileId, index, 'x'.repeat(contentLength), contentHash, contentLength, now]
    );
    jobs.push(
      await queue.enqueue({
        dedupeKey: `${chunkId}:${embeddingSetId}:${contentHash}`,
        jobType: 'embed_chunk',
        payload: {
          chunkId,
          embeddingInputHash,
          embeddingSetId,
          expectedDimension: 8,
          modelKey: MODEL_KEY,
        },
        queue: 'embeddings',
      })
    );
  }

  return {
    contentHashes,
    jobs: jobs.map((job, index) => ({
      ...job,
      lease_token: `benchmark-lease-${scenario}-${index}`,
    })),
  };
}

async function runLegacyWorkerHotPath(
  db: IDatabase,
  jobs: ClaimedEmbeddingJob[]
): Promise<FilterCounts> {
  const payloads = jobs.map((job) => assertEmbedChunkJob(job));
  const chunks = await loadChunksBatch(
    db,
    payloads.map(({ chunkId }) => chunkId),
    'text'
  );
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  let completed = 0;
  let toProcess = 0;

  for (const payload of payloads) {
    const chunk = chunkById.get(payload.chunkId);
    if (!chunk) {
      throw new Error(`Legacy benchmark could not load chunk '${payload.chunkId}'.`);
    }
    const modelKey = payload.modelKey;
    if (!modelKey) {
      throw new Error(`Legacy benchmark job for chunk '${payload.chunkId}' has no model key.`);
    }
    const expectedHash = await buildEmbeddingInputHash(chunk.contentHash, modelKey);
    if (chunk.embeddingHash === expectedHash) {
      completed += 1;
    } else {
      toProcess += 1;
    }
  }
  return { completed, toProcess };
}

async function runPersistedWorkerHotPath(
  db: IDatabase,
  jobs: ClaimedEmbeddingJob[]
): Promise<FilterCounts> {
  const result = await loadAndFilterChunks(jobs, {
    db,
    failOrphanJobs: async () => {
      throw new Error('Persisted benchmark unexpectedly found an orphaned chunk.');
    },
    fileChunkIdType: 'text',
    logWarn: () => {},
  });
  return { completed: result.completed.length, toProcess: result.toProcess.length };
}

describe.sequential('embedding input hash relocation benchmark', () => {
  it(
    'reports worker-hot-path and relocated end-to-end medians by batch and content size',
    async () => {
      const batchSizes = [1, 8, 32] as const;
      const contentLengths = [128, 4096] as const;
      const db = await wasmLoader.createPGlite('memory://bst-393-hash-relocation');
      await migrate(db);
      const results: HashRelocationBenchmarkResult[] = [];

      try {
        for (const contentLength of contentLengths) {
          for (const batchSize of batchSizes) {
            const scenario = await seedScenario(db, batchSize, contentLength);
            const database = db as unknown as IDatabase;
            const legacyCounts = await runLegacyWorkerHotPath(database, scenario.jobs);
            const persistedCounts = await runPersistedWorkerHotPath(database, scenario.jobs);
            expect(persistedCounts).toEqual(legacyCounts);
            expect(persistedCounts).toEqual({ completed: 0, toProcess: batchSize });

            const legacyWorkerHotPathMs = await measureMedian(async () => {
              await runLegacyWorkerHotPath(database, scenario.jobs);
            });
            const persistedWorkerHotPathMs = await measureMedian(async () => {
              await runPersistedWorkerHotPath(database, scenario.jobs);
            });
            const producerHashMs = await measureMedian(async () => {
              await buildEmbeddingJobInputHashes(scenario.contentHashes, MODEL_KEY);
            });
            const relocatedEndToEndMs = producerHashMs + persistedWorkerHotPathMs;

            expect(legacyWorkerHotPathMs).toBeGreaterThan(0);
            expect(persistedWorkerHotPathMs).toBeGreaterThan(0);
            expect(producerHashMs).toBeGreaterThan(0);
            expect(relocatedEndToEndMs).toBeGreaterThan(0);
            results.push({
              batchSize,
              contentLength,
              legacyWorkerHotPathMs,
              persistedWorkerHotPathMs,
              producerHashMs,
              relocatedEndToEndMs,
            });
          }
        }

        expect(results).toHaveLength(batchSizes.length * contentLengths.length);
        console.info('BST-393 embedding input hash relocation benchmark', JSON.stringify(results));
      } finally {
        await db.close();
      }
    },
    BENCHMARK_TIMEOUT_MS
  );
});
