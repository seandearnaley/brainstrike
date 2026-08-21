import type { IDatabase, Job } from '@brainstrike/db';
import { JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import { buildEmbeddingJobInputHashes } from '@brainstrike/indexing-contract';
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import {
  type ClaimedEmbeddingJob,
  type LoadAndFilterChunksOptions,
  loadAndFilterChunks,
} from '../worker/embedding-worker-chunk-filter.js';
import { type EmbedChunkRow, loadChunksBatch } from '../worker/embedding-worker-db-io.js';

const BENCHMARK_TIMEOUT_MS = 90_000;
const MODEL_KEY = 'local::benchmark-model';
const MEASURED_ITERATIONS = 7;
const WARMUP_ITERATIONS = 2;

interface HashRelocationBenchmarkResult {
  readonly batchSize: number;
  readonly contentLength: number;
  readonly historicalWorkerHotPathMs: number;
  readonly persistedWorkerHotPathMs: number;
  readonly producerHashMs: number;
  readonly relocatedEndToEndMs: number;
}

interface FilterClassification {
  readonly completedChunkIds: readonly string[];
  readonly toProcessChunkIds: readonly string[];
}

interface HistoricalEmbedChunkPayload {
  readonly chunkId: string;
  readonly embeddingSetId: string;
  readonly expectedDimension: number;
  readonly modelKey: string;
}

interface HistoricalEmbeddingJobModel {
  readonly compositeKey: string;
}

interface HistoricalLoadAndFilterChunksOptions {
  readonly db: IDatabase;
  readonly failOrphanJobs: (
    jobs: Array<{ id: string; leaseToken: string }>,
    error: string
  ) => Promise<void>;
  readonly fileChunkIdType: string;
  readonly hashExpectedEmbedding: (input: string) => Promise<string>;
  readonly logWarn: (message: string, meta?: unknown) => void;
}

interface HistoricalLoadedChunkItem {
  readonly chunk: EmbedChunkRow;
  readonly expectedHash: string;
  readonly job: ClaimedEmbeddingJob;
  readonly payload: HistoricalEmbedChunkPayload;
}

interface HistoricalFilterResult {
  readonly completed: readonly HistoricalLoadedChunkItem[];
  readonly orphanCount: number;
  readonly toProcess: readonly HistoricalLoadedChunkItem[];
}

interface TaggedFilterResult {
  readonly completed: readonly { readonly chunk: { readonly id: string } }[];
  readonly toProcess: readonly { readonly chunk: { readonly id: string } }[];
}

function assertHistoricalEmbedChunkJob(claimed: Job): HistoricalEmbedChunkPayload {
  if (claimed.jobType !== 'embed_chunk') {
    throw new Error(`Unsupported job type: ${claimed.jobType}`);
  }
  const payload = (claimed.payload || {}) as HistoricalEmbedChunkPayload;
  if (typeof payload.chunkId !== 'string' || payload.chunkId.length === 0) {
    throw new Error('Missing chunkId in payload');
  }
  if (typeof payload.embeddingSetId !== 'string' || payload.embeddingSetId.length === 0) {
    throw new Error('Missing embeddingSetId in payload');
  }
  if (typeof payload.modelKey !== 'string' || payload.modelKey.length === 0) {
    throw new Error('Missing modelKey in payload');
  }
  if (!Number.isFinite(payload.expectedDimension) || (payload.expectedDimension ?? 0) <= 0) {
    throw new Error('Missing expectedDimension in payload');
  }
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Verbatim pre-BST-391 worker helper: the historical timing must not absorb the
// relocated helper's validation, error surface, or byte-to-hex implementation.
async function historicalSha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in the renderer embedding worker.');
  }

  try {
    const data = new TextEncoder().encode(input);
    const digest = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch (error) {
    throw new Error(
      `Web Crypto SHA-256 failed in the renderer embedding worker: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function withoutRelocatedHash(job: ClaimedEmbeddingJob): ClaimedEmbeddingJob {
  if (!isRecord(job.payload)) {
    throw new Error(`Benchmark job '${job.id}' does not have an object payload.`);
  }
  const { embeddingInputHash, sourceContentHash, ...historicalPayload } = job.payload;
  if (typeof embeddingInputHash !== 'string' || typeof sourceContentHash !== 'string') {
    throw new Error(`Benchmark job '${job.id}' is missing its relocated source identities.`);
  }
  return { ...job, payload: historicalPayload };
}

function historicalIsEmbeddingUpToDate(chunk: EmbedChunkRow, expectedHash: string): boolean {
  return Boolean(chunk.embeddingHash && chunk.embeddingHash === expectedHash);
}

function classifyTaggedFilterResult(result: TaggedFilterResult): FilterClassification {
  return {
    completedChunkIds: result.completed.map((item) => item.chunk.id).sort(),
    toProcessChunkIds: result.toProcess.map((item) => item.chunk.id).sort(),
  };
}

// Production stores both current and previous embedding identities as 64-hex
// SHA-256 digests; changing one nibble keeps stale comparisons shape-faithful.
function makeStaleEmbeddingHash(currentHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(currentHash)) {
    throw new Error(`Cannot derive a stale fixture hash from '${currentHash}'.`);
  }
  const replacement = currentHash.startsWith('0') ? '1' : '0';
  return `${replacement}${currentHash.slice(1)}`;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const upper = sorted[midpoint];
  if (upper === undefined) {
    throw new Error('Cannot calculate a benchmark median without samples.');
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[midpoint - 1];
  if (lower === undefined) {
    throw new Error('Cannot calculate an even-sample benchmark median without a lower value.');
  }
  return (lower + upper) / 2;
}

async function measureMedian(operation: () => Promise<unknown>): Promise<number> {
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
  readonly embeddingSetId: string;
  readonly expectedClassification: FilterClassification;
  readonly fileId: string;
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

  // SHA-256 leaves at most 55 input bytes in one padded block, so a production
  // 64-hex chunk hash plus ':' already forces a second block. MODEL_KEY makes
  // this concrete fixture input 87 bytes, but does not cause that second block.
  const contentHashes = await Promise.all(
    Array.from({ length: batchSize }, (_, index) =>
      historicalSha256Hex(`benchmark-content-${scenario}-${index}`)
    )
  );
  expect(contentHashes.filter((hash) => !/^[0-9a-f]{64}$/.test(hash))).toEqual([]);
  const embeddingInputHashes = await buildEmbeddingJobInputHashes(contentHashes, MODEL_KEY);
  const queue = new JobQueue(db as unknown as IDatabase);
  const jobs: Job[] = [];
  const completedChunkIds: string[] = [];
  const toProcessChunkIds: string[] = [];

  for (let index = 0; index < batchSize; index += 1) {
    const chunkId = `chunk-${scenario}-${index}`;
    const contentHash = contentHashes[index];
    const embeddingInputHash = embeddingInputHashes[index];
    if (!(contentHash && embeddingInputHash)) {
      throw new Error(`Missing benchmark identity for chunk '${chunkId}'.`);
    }
    const isCurrent = (index + (contentLength === 4096 ? 1 : 0)) % 2 === 0;
    const embeddingHash = isCurrent
      ? embeddingInputHash
      : makeStaleEmbeddingHash(embeddingInputHash);
    expect(embeddingHash).toMatch(/^[0-9a-f]{64}$/);
    if (!isCurrent) {
      expect(embeddingHash).not.toBe(embeddingInputHash);
    }
    const expectedIds = isCurrent ? completedChunkIds : toProcessChunkIds;
    expectedIds.push(chunkId);
    await db.query(
      `INSERT INTO file_chunks
         (id, file_record_id, chunk_index, content, content_hash, token_count,
          chunk_type, chunk_size, embedding_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 16, 'text', $6, $7, $8, $8)`,
      [
        chunkId,
        fileId,
        index,
        'x'.repeat(contentLength),
        contentHash,
        contentLength,
        embeddingHash,
        now,
      ]
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
          sourceContentHash: contentHash,
        },
        queue: 'embeddings',
      })
    );
  }

  return {
    contentHashes,
    embeddingSetId,
    expectedClassification: {
      completedChunkIds: completedChunkIds.sort(),
      toProcessChunkIds: toProcessChunkIds.sort(),
    },
    fileId,
    jobs: jobs.map((job, index) => ({
      ...job,
      lease_token: `benchmark-lease-${scenario}-${index}`,
    })),
  };
}

async function runHistoricalWorkerHotPath(
  jobs: ClaimedEmbeddingJob[],
  jobModel: HistoricalEmbeddingJobModel,
  options: HistoricalLoadAndFilterChunksOptions
): Promise<HistoricalFilterResult> {
  const chunkIds = jobs.map((job) => assertHistoricalEmbedChunkJob(job).chunkId);
  const loadedChunks = await loadChunksBatch(options.db, chunkIds, options.fileChunkIdType);
  const chunkMap = new Map(loadedChunks.map((chunk) => [chunk.id, chunk]));
  const found: Array<{
    chunk: EmbedChunkRow;
    job: ClaimedEmbeddingJob;
    payload: ReturnType<typeof assertHistoricalEmbedChunkJob>;
  }> = [];
  const orphans: Array<{ chunkId: string; job: ClaimedEmbeddingJob }> = [];

  for (const job of jobs) {
    const payload = assertHistoricalEmbedChunkJob(job);
    const chunk = chunkMap.get(payload.chunkId);
    if (chunk) {
      found.push({ chunk, job, payload });
    } else {
      orphans.push({ chunkId: payload.chunkId, job });
    }
  }
  if (orphans.length > 0) {
    options.logWarn('Embedding jobs reference deleted chunks; failing as terminal', {
      orphanCount: orphans.length,
      sampleChunkIds: orphans.slice(0, 3).map((orphan) => orphan.chunkId),
    });
    await options.failOrphanJobs(
      orphans.map((orphan) => ({ id: orphan.job.id, leaseToken: orphan.job.lease_token })),
      'Chunk no longer exists (likely re-chunked or deleted)'
    );
  }

  const toProcess: HistoricalLoadedChunkItem[] = [];
  const completed: HistoricalLoadedChunkItem[] = [];
  for (const item of found) {
    // Reproduce the historical claim path exactly: it awaited one SHA-256 per
    // found chunk in this loop, before BST-391 moved hashing to producers.
    const expectedHash = await options.hashExpectedEmbedding(
      `${item.chunk.contentHash}:${jobModel.compositeKey}`
    );
    const tagged = { ...item, expectedHash };
    if (historicalIsEmbeddingUpToDate(item.chunk, expectedHash)) {
      completed.push(tagged);
    } else {
      toProcess.push(tagged);
    }
  }
  return { completed, orphanCount: orphans.length, toProcess };
}

function createHistoricalWorkerHotPathOptions(db: IDatabase): HistoricalLoadAndFilterChunksOptions {
  return {
    db,
    failOrphanJobs: async () => {
      throw new Error('Historical benchmark unexpectedly found an orphaned chunk.');
    },
    fileChunkIdType: 'text',
    hashExpectedEmbedding: historicalSha256Hex,
    logWarn: () => {},
  };
}

function createPersistedWorkerHotPathOptions(db: IDatabase): LoadAndFilterChunksOptions {
  return {
    db,
    failTerminalJobs: async () => {
      throw new Error('Persisted benchmark unexpectedly found an orphaned or stale chunk.');
    },
    fileChunkIdType: 'text',
    logWarn: () => {},
  };
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
            const historicalJobs = scenario.jobs.map(withoutRelocatedHash);
            const historicalJobModel = { compositeKey: MODEL_KEY } as const;
            const historicalOptions = createHistoricalWorkerHotPathOptions(database);
            const persistedOptions = createPersistedWorkerHotPathOptions(database);
            const runHistoricalWorkerFilter = () =>
              runHistoricalWorkerHotPath(historicalJobs, historicalJobModel, historicalOptions);
            const runPersistedWorkerHotPath = () =>
              loadAndFilterChunks(scenario.jobs, persistedOptions);
            const historicalResult = await runHistoricalWorkerFilter();
            const persistedResult = await runPersistedWorkerHotPath();
            const historicalTaggedItems = [
              ...historicalResult.completed,
              ...historicalResult.toProcess,
            ];
            expect(historicalResult.orphanCount).toBe(0);
            expect(persistedResult.orphanCount).toBe(0);
            expect(persistedResult.staleCount).toBe(0);
            expect(historicalTaggedItems).toHaveLength(batchSize);
            for (const historicalTaggedItem of historicalTaggedItems) {
              expect(historicalTaggedItem).toMatchObject({
                chunk: expect.any(Object),
                expectedHash: expect.any(String),
                job: expect.any(Object),
                payload: expect.any(Object),
              });
            }
            const historicalClassification = classifyTaggedFilterResult(historicalResult);
            const persistedClassification = classifyTaggedFilterResult(persistedResult);
            expect(
              persistedClassification,
              'Historical and persisted filters disagree; verify whether the embedding-input hash format intentionally changed.'
            ).toEqual(historicalClassification);
            expect(persistedClassification).toEqual(scenario.expectedClassification);

            const historicalWorkerHotPathMs = await measureMedian(runHistoricalWorkerFilter);
            const persistedWorkerHotPathMs = await measureMedian(runPersistedWorkerHotPath);
            const producerHashMs = await measureMedian(async () => {
              await buildEmbeddingJobInputHashes(scenario.contentHashes, MODEL_KEY);
            });
            const relocatedEndToEndMs = await measureMedian(async () => {
              await buildEmbeddingJobInputHashes(scenario.contentHashes, MODEL_KEY);
              await runPersistedWorkerHotPath();
            });
            results.push({
              batchSize,
              contentLength,
              historicalWorkerHotPathMs,
              persistedWorkerHotPathMs,
              producerHashMs,
              relocatedEndToEndMs,
            });
            await db.query('DELETE FROM job_queue WHERE id = ANY($1)', [
              scenario.jobs.map((job) => job.id),
            ]);
            await db.query('DELETE FROM file_records WHERE id = $1', [scenario.fileId]);
            await db.query('DELETE FROM embedding_sets WHERE id = $1', [scenario.embeddingSetId]);
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
