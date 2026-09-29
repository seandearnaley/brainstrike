import type { IDatabase } from '@brainstrike/db';
import { JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import { buildEmbeddingInputHash } from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatProviderModelKey, startEmbeddingWorker } from '../index.js';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  EmbeddingStreamOptions,
  SimilarityResult,
} from '../types.js';
import type { EmbeddingCacheInterface } from '../worker/embedding-cache-types.js';
import type { EmbeddingStatsRefreshController } from '../worker/embedding-worker.js';
import { createEmbeddingStatsRefreshController } from '../worker/embedding-worker.js';

class FakeEmbeddingService implements EmbeddingService {
  private status: EmbeddingStatus = 'ready';

  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    this.status = 'ready';
    return Promise.resolve();
  }
  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    return {
      dimensions: 768,
      embedding: new Array(768).fill(0.1),
      model: 'fake-model',
      usage: { totalTokens: 10 },
    };
  }

  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.generateEmbedding(t)));
  }
  async generateEmbeddingsStream(
    texts: string[],
    onBatch: (batch: {
      startIndex: number;
      endIndex: number;
      results: EmbeddingResult[];
    }) => Promise<void> | void
  ): Promise<void> {
    const results = await this.generateEmbeddings(texts);
    await onBatch({ endIndex: results.length, results, startIndex: 0 });
  }
  async generateDocEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  async generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  calculateSimilarity(_e1: number[], _e2: number[]): SimilarityResult {
    return { distance: 0, method: 'cosine', similarity: 1 };
  }
  getStatus(): EmbeddingStatus {
    return this.status;
  }
  getConfig(): EmbeddingConfig {
    return { modelId: 'fake-model' };
  }
  async dispose(): Promise<void> {
    this.status = 'disposed';
  }
}

class ChunkedStreamingEmbeddingService extends FakeEmbeddingService {
  private batchStartObserver: ((startIndex: number) => void) | null = null;

  constructor(
    private readonly streamBatchSize: number,
    private readonly delayAfterBatchMs: number
  ) {
    super();
  }

  onBatchStart(observer: (startIndex: number) => void): void {
    this.batchStartObserver = observer;
  }

  override async generateEmbeddingsStream(
    texts: string[],
    onBatch: (batch: {
      startIndex: number;
      endIndex: number;
      results: EmbeddingResult[];
    }) => Promise<void> | void,
    options?: EmbeddingStreamOptions
  ): Promise<void> {
    const streamBatchSize = options?.streamBatchSize ?? this.streamBatchSize;
    for (let startIndex = 0; startIndex < texts.length; startIndex += streamBatchSize) {
      const endIndex = Math.min(texts.length, startIndex + streamBatchSize);
      const results = await this.generateEmbeddings(texts.slice(startIndex, endIndex));
      this.batchStartObserver?.(startIndex);
      await onBatch({ endIndex, results, startIndex });
      await new Promise((resolve) => setTimeout(resolve, this.delayAfterBatchMs));
    }
  }
}

class WrongDimensionStreamingEmbeddingService extends FakeEmbeddingService {
  override async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    return {
      dimensions: 10,
      embedding: new Array(10).fill(0.1),
      model: 'wrong-dimension-stream-model',
      usage: { totalTokens: 10 },
    };
  }
}

class RuntimeMetadataStreamingEmbeddingService extends ChunkedStreamingEmbeddingService {
  constructor(
    streamBatchSize: number,
    delayAfterBatchMs: number,
    private readonly runtime: NonNullable<EmbeddingResult['runtime']>
  ) {
    super(streamBatchSize, delayAfterBatchMs);
  }

  override async generateEmbedding(text: string): Promise<EmbeddingResult> {
    return {
      ...(await super.generateEmbedding(text)),
      runtime: this.runtime,
    };
  }
}

const PGLITE_SETUP_TIMEOUT_MS = 90_000;
const EMBEDDING_WORKER_TEST_TIMEOUT_MS = 30_000;

function vectorString(dim: number, entries: [number, number][]): string {
  const values = new Array(dim).fill(0);
  for (const [idx, value] of entries) {
    values[idx] = value;
  }
  return `[${values.join(',')}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasStatsRefreshLog(
  log: ReturnType<typeof vi.fn<(message: string, meta?: unknown) => void>>,
  reason: string
): boolean {
  return log.mock.calls.some(([message, meta]) => {
    if (message !== 'embedding_stats_refresh' || !isRecord(meta)) {
      return false;
    }
    return meta['reason'] === reason;
  });
}

function readIdleBackoffLogs(
  log: ReturnType<typeof vi.fn<(message: string, meta?: unknown) => void>>
): Record<string, unknown>[] {
  return log.mock.calls.flatMap(([message, meta]) => {
    if (message !== 'embedding_queue_idle_backoff' || !isRecord(meta)) {
      return [];
    }
    return [meta];
  });
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

interface InsertEmbeddingJobOptions {
  readonly db: PGlite;
  readonly modelKey: string;
  readonly now: string;
  readonly prefix: string;
}

async function insertQueuedEmbeddingJob({
  db,
  modelKey,
  now,
  prefix,
}: InsertEmbeddingJobOptions): Promise<void> {
  const compositeKey = formatProviderModelKey('local', modelKey);
  const embeddingSetId = `set-${prefix}`;
  const fileId = `file-${prefix}`;
  const chunkId = `chunk-${prefix}`;
  await db.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)`,
    [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
  );
  await db.query(
    `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [
      fileId,
      `${prefix}.ts`,
      `/${prefix}.ts`,
      100,
      'content',
      `${prefix}-hash`,
      10,
      embeddingSetId,
      now,
    ]
  );
  await db.query(
    `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
    VALUES ($1,$2,0,$3,$4,$5,'text',10,$6,$6)`,
    [chunkId, fileId, 'content', `${prefix}-hash`, 10, now]
  );
  await db.query(
    `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
    VALUES ($1,'embeddings','embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
    [
      `job-${prefix}`,
      JSON.stringify({
        chunkId,
        embeddingInputHash: await buildEmbeddingInputHash(`${prefix}-hash`, compositeKey),
        embeddingSetId,
        expectedDimension: 768,
        modelKey: compositeKey,
        sourceContentHash: `${prefix}-hash`,
      }),
      now,
    ]
  );
}

function countCollectionStatsRefreshQueries(db: PGlite): { getCount: () => number } {
  const originalQuery = db.query.bind(db);
  let count = 0;
  vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('aggregated_chunks') && sql.includes('collection_indexing_stats')) {
      count += 1;
    }
    return await originalQuery(sql, params);
  });
  return {
    getCount: () => count,
  };
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await fn()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('Embedding Worker Batch Optimization', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://embedding-worker-batch');
    await migrate(db);
  }, PGLITE_SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await db?.close();
    vi.restoreAllMocks();
  });

  it('uses completeBatch for already-completed jobs to avoid N+1 queries', async () => {
    const completeBatchSpy = vi.spyOn(JobQueue.prototype, 'completeBatch');
    const completeSpy = vi.spyOn(JobQueue.prototype, 'complete');

    const now = new Date().toISOString();
    const embeddingSetId = 'set-batch';
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const compositeKey = formatProviderModelKey('local', modelKey);
    const expectedHash = await (await import('node:crypto'))
      .createHash('sha256')
      .update(`hash-batch:${compositeKey}`)
      .digest('hex');

    // Create embedding set
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
    );

    const JOB_COUNT = 10;
    const fileId = 'file-batch';

    // Create file record
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [
        fileId,
        'batch.ts',
        '/batch.ts',
        100 * JOB_COUNT,
        'content',
        'hash-batch',
        10 * JOB_COUNT,
        now,
      ]
    );

    const dummyEmbedding = vectorString(768, [[0, 0.1]]);

    // Insert multiple chunks that are ALREADY processed (have valid hash)
    for (let i = 0; i < JOB_COUNT; i++) {
      const chunkId = `chunk-batch-${i}`;
      const jobId = `job-batch-${i}`;

      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding, embedding_hash, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'text',10,$7,$8,$9,$9)`,
        [chunkId, fileId, i, 'content', 'hash-batch', 10, dummyEmbedding, expectedHash, now]
      );

      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
        VALUES ($1,'embeddings','embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [
          jobId,
          JSON.stringify({
            chunkId,
            embeddingInputHash: expectedHash,
            embeddingSetId,
            expectedDimension: 768,
            modelKey: compositeKey,
            sourceContentHash: 'hash-batch',
          }),
          now,
        ]
      );
    }

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 2000,
      log: () => {}, // silence logs
      modelKey,
      service: new FakeEmbeddingService(),
    });

    // Wait for all jobs to match as succeeded
    await waitFor(async () => {
      const res = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
      );
      return Number(res.rows[0]?.count) === JOB_COUNT;
    }, 10_000);

    await controller.stop();

    // Verify optimizations
    // Should have called completeBatch at least once (might be more if batch size is small, but default is 50 so likely 1)
    expect(completeBatchSpy).toHaveBeenCalled();
    // Should NOT have called individual complete
    expect(completeSpy).not.toHaveBeenCalled();

    // Verify the arguments passed to completeBatch contain the correct job IDs
    const calls = completeBatchSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);

    const completedIds = calls.flatMap((args) => args[0].map((j) => j.id));
    expect(completedIds).toHaveLength(JOB_COUNT);
    for (let i = 0; i < JOB_COUNT; i++) {
      expect(completedIds).toContain(`job-batch-${i}`);
    }
  });

  it('waits for background database permits before claims but never before completions', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-pressure';
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const compositeKey = formatProviderModelKey('local', modelKey);
    const fileId = 'file-pressure';
    const chunkId = 'chunk-pressure';
    const jobId = 'job-pressure';
    const waitForBackgroundPermit = vi.fn(async () => undefined);

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
    );

    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'pressure.ts', '/pressure.ts', 100, 'content', 'hash-pressure', 10, now]
    );

    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
      VALUES ($1,$2,0,$3,$4,$5,'text',10,$6,$6)`,
      [chunkId, fileId, 'content', 'hash-pressure', 10, now]
    );

    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
      VALUES ($1,'embeddings','embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
      [
        jobId,
        JSON.stringify({
          chunkId,
          embeddingInputHash: await buildEmbeddingInputHash('hash-pressure', compositeKey),
          embeddingSetId,
          expectedDimension: 768,
          modelKey: compositeKey,
          sourceContentHash: 'hash-pressure',
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 2000,
      log: () => {},
      modelKey,
      service: new FakeEmbeddingService(),
      waitForBackgroundPermit,
    });

    await waitFor(async () => {
      const res = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
      );
      return Number(res.rows[0]?.count) === 1;
    }, 10_000);

    await controller.stop();

    expect(waitForBackgroundPermit).toHaveBeenCalledTimes(1);
    expect(waitForBackgroundPermit).toHaveBeenCalledWith({ label: 'embedding claim' });
    expect(waitForBackgroundPermit).not.toHaveBeenCalledWith({ label: 'embedding completion' });
  });

  it('retries transient database completion failures without stopping the local worker as fatal', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const onFatalError = vi.fn();
    await insertQueuedEmbeddingJob({
      db,
      modelKey,
      now,
      prefix: 'transient-db-completion',
    });

    let remainingCompletionFailures = 1;
    const wrappedDb: IDatabase = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('UPDATE file_chunks AS fc') && remainingCompletionFailures > 0) {
          remainingCompletionFailures -= 1;
          throw new Error(
            "Error invoking remote method 'db:query': Error: DB host request timed out: query"
          );
        }
        return await (db as unknown as IDatabase).query(sql, params);
      },
    };

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 1,
      db: wrappedDb,
      interBatchDelayMs: 10,
      leaseMs: 2000,
      log: () => {},
      modelKey,
      onFatalError,
      service: new FakeEmbeddingService(),
      stopOnFatalLocalError: true,
    });

    try {
      await waitFor(async () => {
        const res = await db.query<{ state: string }>(
          `SELECT state FROM job_queue WHERE id = 'job-transient-db-completion'`
        );
        return res.rows[0]?.state === 'succeeded';
      }, 10_000);
    } finally {
      await controller.stop();
    }

    expect(onFatalError).not.toHaveBeenCalled();
    expect(remainingCompletionFailures).toBe(0);
  });

  it('stops claiming new jobs when a local stream emits wrong embedding dimensions', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const onFatalError = vi.fn();
    await insertQueuedEmbeddingJob({
      db,
      modelKey,
      now,
      prefix: 'fatal-stream-dim-a',
    });
    await insertQueuedEmbeddingJob({
      db,
      modelKey,
      now,
      prefix: 'fatal-stream-dim-b',
    });
    await db.query(
      `UPDATE job_queue SET max_attempts = 1 WHERE id IN ('job-fatal-stream-dim-a', 'job-fatal-stream-dim-b')`
    );

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 10,
      leaseMs: 2000,
      log: () => {},
      modelKey,
      onFatalError,
      service: new WrongDimensionStreamingEmbeddingService(),
      stopOnFatalLocalError: true,
    });

    try {
      await waitFor(async () => {
        const res = await db.query<{ state: string }>(
          `SELECT state FROM job_queue WHERE id = 'job-fatal-stream-dim-a'`
        );
        return res.rows[0]?.state === 'failed';
      }, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      await controller.stop();
    }

    const followUpJob = await db.query<{ state: string }>(
      `SELECT state FROM job_queue WHERE id = 'job-fatal-stream-dim-b'`
    );

    expect(followUpJob.rows[0]?.state).toBe('queued');
    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(onFatalError.mock.calls[0]?.[0].message).toContain(
      "Local embedding execution failed for 'local::jinaai/jina-embeddings-v2-base-code': Embedding dimension mismatch"
    );
  });

  it('uses a resolved claim batch size when polling the queue', async () => {
    const claimManySpy = vi.spyOn(JobQueue.prototype, 'claimMany');
    const resolveClaimBatchSize = vi.fn(async () => 3);

    const controller = await startEmbeddingWorker({
      claimBatchSize: 10,
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 2000,
      log: () => {},
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      resolveClaimBatchSize,
      service: new FakeEmbeddingService(),
    });

    await waitFor(async () => claimManySpy.mock.calls.length > 0, 10_000);
    await controller.stop();

    expect(resolveClaimBatchSize).toHaveBeenCalled();
    expect(claimManySpy.mock.calls[0]?.[0]).toMatchObject({ limit: 3 });
  });

  it('treats a null resolved claim batch size as intentional no-claim backpressure', async () => {
    const claimManySpy = vi.spyOn(JobQueue.prototype, 'claimMany');
    claimManySpy.mockClear();
    const metricLogs: Record<string, unknown>[] = [];
    const resolveClaimBatchSize = vi.fn(async () => null);

    const controller = await startEmbeddingWorker({
      claimBatchSize: 10,
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 2000,
      log: (event, meta) => {
        if (event === 'worker_metrics') {
          metricLogs.push(meta as Record<string, unknown>);
        }
      },
      metricsIntervalMs: 5000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      resolveClaimBatchSize,
      service: new FakeEmbeddingService(),
    });

    try {
      await waitFor(async () => metricLogs.length > 0, 7000);
    } finally {
      await controller.stop();
    }

    expect(resolveClaimBatchSize).toHaveBeenCalled();
    expect(claimManySpy).not.toHaveBeenCalled();
    expect(metricLogs.at(-1)).toMatchObject({
      effectiveClaimBatchSize: 0,
      effectiveClaimBatchSizeError: null,
    });
  });

  it('keeps heartbeating only unfinished jobs after streamed sub-batches complete', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-stream-heartbeat';
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const compositeKey = formatProviderModelKey('local', modelKey);
    const fileId = 'file-stream-heartbeat';
    const jobCount = 8;

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [
        fileId,
        'stream-heartbeat.ts',
        '/stream-heartbeat.ts',
        100,
        'content',
        'stream-hash',
        10,
        now,
      ]
    );

    for (let index = 0; index < jobCount; index++) {
      const chunkId = `chunk-stream-heartbeat-${index}`;
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'text',10,$7,$7)`,
        [chunkId, fileId, index, `content ${index}`, `stream-hash-${index}`, 10, now]
      );
      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
        VALUES ($1,'embeddings','embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [
          `job-stream-heartbeat-${index}`,
          JSON.stringify({
            chunkId,
            embeddingInputHash: await buildEmbeddingInputHash(`stream-hash-${index}`, compositeKey),
            embeddingSetId,
            expectedDimension: 768,
            modelKey: compositeKey,
            sourceContentHash: `stream-hash-${index}`,
          }),
          now,
        ]
      );
    }

    const controller = await startEmbeddingWorker({
      claimBatchSize: jobCount,
      concurrency: 1,
      db: db as unknown as IDatabase,
      heartbeatIntervalMs: 10,
      interBatchDelayMs: 10,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      service: new ChunkedStreamingEmbeddingService(2, 30),
    });

    await waitFor(async () => {
      const res = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
      );
      return Number(res.rows[0]?.count) === jobCount;
    }, 10_000);

    await controller.stop();

    const failed = await db.query<{ count: number }>(
      `SELECT count(*) as count FROM job_queue WHERE state = 'failed'`
    );
    expect(Number(failed.rows[0]?.count)).toBe(0);
  });

  it('starts the next streamed inference batch before the prior DB completion resolves', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'overlap-a' });
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'overlap-b' });

    const service = new ChunkedStreamingEmbeddingService(1, 0);
    const batchStarts: number[] = [];
    service.onBatchStart((startIndex) => {
      batchStarts.push(startIndex);
    });

    const firstCompletionRelease = createDeferred();
    const originalCompleteEmbeddingChunkBatch = JobQueue.prototype.completeEmbeddingChunkBatch;
    const completeBatchSpy = vi
      .spyOn(JobQueue.prototype, 'completeEmbeddingChunkBatch')
      .mockImplementation(async function (this: JobQueue, ...args) {
        if (completeBatchSpy.mock.calls.length === 1) {
          await firstCompletionRelease.promise;
        }
        return await originalCompleteEmbeddingChunkBatch.apply(this, args);
      });

    const controller = await startEmbeddingWorker({
      claimBatchSize: 2,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      service,
    });

    let assertionError: unknown;
    try {
      await waitFor(async () => completeBatchSpy.mock.calls.length === 1, 10_000);
      try {
        await waitFor(async () => batchStarts.length >= 2, 500);
      } catch (error) {
        assertionError = error;
      }
    } finally {
      firstCompletionRelease.resolve();
      await controller.stop();
      completeBatchSpy.mockRestore();
    }

    if (assertionError) {
      throw assertionError;
    }
    expect(batchStarts).toEqual([0, 1]);
  });

  it('keeps a claimed permit until an accepted completion write settles after stream failure', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'stream-tail-a' });
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'stream-tail-b' });

    const completionRelease = createDeferred();
    const streamFailed = createDeferred();
    const originalComplete = JobQueue.prototype.completeEmbeddingChunkBatch;
    const completeSpy = vi
      .spyOn(JobQueue.prototype, 'completeEmbeddingChunkBatch')
      .mockImplementation(async function (this: JobQueue, ...args) {
        if (completeSpy.mock.calls.length === 1) {
          await completionRelease.promise;
        }
        return originalComplete.apply(this, args);
      });
    const originalClaim = JobQueue.prototype.claimMany;
    const claimSpy = vi.spyOn(JobQueue.prototype, 'claimMany').mockImplementation(async function (
      this: JobQueue,
      ...args
    ) {
      return originalClaim.apply(this, args);
    });
    const sentinel = new Error('stream failed after accepting completion');
    class FailingAfterEnqueueService extends FakeEmbeddingService {
      override async generateEmbeddingsStream(
        texts: string[],
        onBatch: (batch: {
          startIndex: number;
          endIndex: number;
          results: EmbeddingResult[];
        }) => Promise<void> | void
      ): Promise<void> {
        const results = await this.generateEmbeddings(texts);
        await onBatch({ endIndex: results.length, results, startIndex: 0 });
        streamFailed.resolve();
        throw sentinel;
      }
    }

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 2,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1,
      leaseMs: 5000,
      log: () => {},
      maxInFlightJobs: 1,
      modelKey,
      service: new FailingAfterEnqueueService(),
    });
    try {
      await streamFailed.promise;
      await waitFor(async () => completeSpy.mock.calls.length === 1, 10_000);
      // Give the stream failure path one task to unwind. A missing writer
      // drain would free this permit and admit the next claim immediately.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(claimSpy).toHaveBeenCalledTimes(1);
      const running = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE state = 'running'`
      );
      expect(Number(running.rows[0]?.count)).toBe(1);
      completionRelease.resolve();
      await waitFor(async () => claimSpy.mock.calls.length >= 2, 10_000);
    } finally {
      completionRelease.resolve();
      await controller.stop();
      completeSpy.mockRestore();
      claimSpy.mockRestore();
    }
  });

  it('keeps a terminal stream failure when its accepted completion write also fails', async (): Promise<void> => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'stream-dual-failure' });

    const completionRelease = createDeferred();
    const streamFailed = createDeferred();
    const completionError = new Error('secondary completion write failed');
    const completeSpy = vi
      .spyOn(JobQueue.prototype, 'completeEmbeddingChunkBatch')
      .mockImplementation(async () => {
        await completionRelease.promise;
        throw completionError;
      });
    const failBatchSpy = vi.spyOn(JobQueue.prototype, 'failBatch');
    const errorSpy = vi.spyOn(createLogger('EmbeddingWorker'), 'error');
    const terminalError = new Error('Invalid input: streamed inference rejected content');
    class TerminalStreamService extends FakeEmbeddingService {
      override async generateEmbeddingsStream(
        texts: string[],
        onBatch: (batch: {
          startIndex: number;
          endIndex: number;
          results: EmbeddingResult[];
        }) => Promise<void> | void
      ): Promise<void> {
        const results = await this.generateEmbeddings(texts);
        await onBatch({ endIndex: results.length, results, startIndex: 0 });
        streamFailed.resolve();
        throw terminalError;
      }
    }

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      maxInFlightJobs: 1,
      modelKey,
      service: new TerminalStreamService(),
    });
    try {
      await streamFailed.promise;
      await waitFor(async () => completeSpy.mock.calls.length === 1, 10_000);
      completionRelease.resolve();
      await waitFor(async () => failBatchSpy.mock.calls.length === 1, 10_000);
      expect(failBatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: terminalError.message,
          terminal: true,
        })
      );
      expect(errorSpy).toHaveBeenCalledWith(
        'Accepted embedding completion failed after stream error',
        expect.objectContaining({ message: completionError.message })
      );
    } finally {
      completionRelease.resolve();
      await controller.stop();
      completeSpy.mockRestore();
      failBatchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('bounds streamed inference overlap while DB completion capacity is full', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'bounded-overlap-a' });
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'bounded-overlap-b' });
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'bounded-overlap-c' });

    const service = new ChunkedStreamingEmbeddingService(1, 0);
    const batchStarts: number[] = [];
    service.onBatchStart((startIndex) => {
      batchStarts.push(startIndex);
    });

    const firstCompletionRelease = createDeferred();
    const originalCompleteEmbeddingChunkBatch = JobQueue.prototype.completeEmbeddingChunkBatch;
    const completeBatchSpy = vi
      .spyOn(JobQueue.prototype, 'completeEmbeddingChunkBatch')
      .mockImplementation(async function (this: JobQueue, ...args) {
        if (completeBatchSpy.mock.calls.length === 1) {
          await firstCompletionRelease.promise;
        }
        return await originalCompleteEmbeddingChunkBatch.apply(this, args);
      });

    const controller = await startEmbeddingWorker({
      claimBatchSize: 3,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      maxPendingCompletionBatches: 1,
      modelKey,
      service,
    });

    let assertionError: unknown;
    let blockedBatchStarts: number[] = [];
    try {
      await waitFor(async () => batchStarts.length >= 2, 10_000);
      try {
        await waitFor(async () => batchStarts.length >= 3, 500);
      } catch (error) {
        assertionError = error;
      }
      expect(assertionError).toBeInstanceOf(Error);
      blockedBatchStarts = [...batchStarts];
      assertionError = null;
    } finally {
      firstCompletionRelease.resolve();
      await controller.stop();
      completeBatchSpy.mockRestore();
    }

    if (assertionError) {
      throw assertionError;
    }
    expect(blockedBatchStarts).toEqual([0, 1]);
  });

  it('splits a streamed completion batch that exceeds the configured chunk capacity', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'chunk-capacity-a' });
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'chunk-capacity-b' });

    const originalCompleteEmbeddingChunkBatch = JobQueue.prototype.completeEmbeddingChunkBatch;
    const completeBatchSpy = vi
      .spyOn(JobQueue.prototype, 'completeEmbeddingChunkBatch')
      .mockImplementation(async function (this: JobQueue, ...args) {
        return await originalCompleteEmbeddingChunkBatch.apply(this, args);
      });

    const controller = await startEmbeddingWorker({
      claimBatchSize: 2,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      maxPendingCompletionChunks: 1,
      modelKey,
      service: new ChunkedStreamingEmbeddingService(2, 0),
    });

    let completeBatchSizes: number[] = [];
    try {
      await waitFor(async () => {
        const succeeded = await db.query<{ count: number }>(
          `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
        );
        return Number(succeeded.rows[0]?.count) === 2;
      }, 10_000);
      completeBatchSizes = completeBatchSpy.mock.calls.map(([jobs]) => jobs.length);
    } finally {
      await controller.stop();
      completeBatchSpy.mockRestore();
    }

    expect(completeBatchSizes).toEqual([1, 1]);
    const failed = await db.query<{ count: number }>(
      `SELECT count(*) as count FROM job_queue WHERE state = 'failed'`
    );
    expect(Number(failed.rows[0]?.count)).toBe(0);
  });

  it('splits streamed completion batches by aggregate byte capacity and caches matching slices', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'byte-split-a' });
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'byte-split-b' });

    const originalCompleteEmbeddingChunkBatch = JobQueue.prototype.completeEmbeddingChunkBatch;
    const completeBatchSpy = vi
      .spyOn(JobQueue.prototype, 'completeEmbeddingChunkBatch')
      .mockImplementation(async function (this: JobQueue, ...args) {
        return await originalCompleteEmbeddingChunkBatch.apply(this, args);
      });
    const setBatchMock = vi.fn(
      async (entries: Parameters<EmbeddingCacheInterface['setBatch']>[0]) => entries.length
    );
    const embeddingCache: EmbeddingCacheInterface = {
      get: vi.fn(async () => ({ entry: null, hit: false as const })),
      getBatch: vi.fn(async () => new Map()),
      set: vi.fn(async () => undefined),
      setBatch: setBatchMock,
    };

    const controller = await startEmbeddingWorker({
      claimBatchSize: 2,
      concurrency: 1,
      db: db as unknown as IDatabase,
      embeddingCache,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      maxPendingCompletionBytes: 4096,
      maxPendingCompletionChunks: 32,
      modelKey,
      service: new ChunkedStreamingEmbeddingService(2, 0),
    });

    let completeBatchSizes: number[] = [];
    try {
      await waitFor(async () => {
        const succeeded = await db.query<{ count: number }>(
          `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
        );
        return Number(succeeded.rows[0]?.count) === 2;
      }, 10_000);
      await waitFor(async () => setBatchMock.mock.calls.length === 2, 10_000);
      completeBatchSizes = completeBatchSpy.mock.calls.map(([jobs]) => jobs.length);
    } finally {
      await controller.stop();
      completeBatchSpy.mockRestore();
    }

    expect(completeBatchSizes).toEqual([1, 1]);
    expect(
      setBatchMock.mock.calls.map(([entries]) => entries.map((entry) => entry.contentHash))
    ).toEqual([['byte-split-a-hash'], ['byte-split-b-hash']]);
  });

  it('rejects a streamed completion batch that exceeds the configured byte capacity', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'byte-capacity' });
    await db.query(
      `UPDATE job_queue
       SET max_attempts = 1
       WHERE id = 'job-byte-capacity'`
    );

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      maxPendingCompletionBytes: 1,
      modelKey,
      service: new ChunkedStreamingEmbeddingService(1, 0),
    });

    try {
      await waitFor(async () => {
        const failed = await db.query<{ count: number }>(
          `SELECT count(*) as count FROM job_queue WHERE state = 'failed'`
        );
        return Number(failed.rows[0]?.count) === 1;
      }, 10_000);
    } finally {
      await controller.stop();
    }
  });

  it('does not leave claimed jobs running when deferred DB completion fails', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'deferred-failure-a' });
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'deferred-failure-b' });
    await db.query(
      `UPDATE job_queue
       SET max_attempts = 1
       WHERE id IN ('job-deferred-failure-a', 'job-deferred-failure-b')`
    );

    const service = new ChunkedStreamingEmbeddingService(1, 0);
    const batchStarts: number[] = [];
    service.onBatchStart((startIndex) => {
      batchStarts.push(startIndex);
    });

    const firstCompletionFailure = createDeferred();
    const originalCompleteEmbeddingChunkBatch = JobQueue.prototype.completeEmbeddingChunkBatch;
    const completeBatchSpy = vi
      .spyOn(JobQueue.prototype, 'completeEmbeddingChunkBatch')
      .mockImplementation(async function (this: JobQueue, ...args) {
        if (completeBatchSpy.mock.calls.length === 1) {
          await firstCompletionFailure.promise;
          throw new Error('deferred completion failed');
        }
        return await originalCompleteEmbeddingChunkBatch.apply(this, args);
      });

    const controller = await startEmbeddingWorker({
      claimBatchSize: 2,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      service,
    });

    try {
      await waitFor(async () => batchStarts.length >= 2, 10_000);
      firstCompletionFailure.resolve();
      await waitFor(async () => {
        const running = await db.query<{ count: number }>(
          `SELECT count(*) as count FROM job_queue WHERE state = 'running'`
        );
        return Number(running.rows[0]?.count) === 0;
      }, 10_000);
    } finally {
      await controller.stop();
      completeBatchSpy.mockRestore();
    }

    const states = await db.query<{ state: string }>(
      `SELECT state FROM job_queue
       WHERE id IN ('job-deferred-failure-a', 'job-deferred-failure-b')
       ORDER BY id`
    );
    expect(states.rows.map((row) => row.state).sort()).toEqual(['failed', 'succeeded']);
  });

  it('reports inactive after streamed inference finishes while DB completion remains pending', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'activity-db-pending' });

    const firstCompletionRelease = createDeferred();
    const originalCompleteEmbeddingChunkBatch = JobQueue.prototype.completeEmbeddingChunkBatch;
    const completeBatchSpy = vi
      .spyOn(JobQueue.prototype, 'completeEmbeddingChunkBatch')
      .mockImplementation(async function (this: JobQueue, ...args) {
        await firstCompletionRelease.promise;
        return await originalCompleteEmbeddingChunkBatch.apply(this, args);
      });
    const activityChanges: boolean[] = [];

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      onWorkerActivityChange: (active) => {
        activityChanges.push(active);
      },
      service: new ChunkedStreamingEmbeddingService(1, 0),
    });

    try {
      await waitFor(async () => completeBatchSpy.mock.calls.length === 1, 10_000);
      await waitFor(async () => activityChanges.at(-1) === false, 10_000);
      expect(activityChanges).toEqual([true, false]);
    } finally {
      firstCompletionRelease.resolve();
      await controller.stop();
      completeBatchSpy.mockRestore();
    }
  });

  it('uses dynamically resolved stream batch capacity for local streaming groups', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'dynamic-capacity-a' });
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'dynamic-capacity-b' });

    const service = new ChunkedStreamingEmbeddingService(99, 0);
    const batchStarts: number[] = [];
    service.onBatchStart((startIndex) => {
      batchStarts.push(startIndex);
    });

    const controller = await startEmbeddingWorker({
      claimBatchSize: 2,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      resolvePipelineCapacity: () => ({
        maxPendingCompletionBatches: 2,
        maxPendingCompletionBytes: 786_432,
        maxPendingCompletionChunks: 32,
        streamBatchSize: 1,
      }),
      service,
    });

    try {
      await waitFor(async () => {
        const res = await db.query<{ count: number }>(
          `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
        );
        return Number(res.rows[0]?.count) === 2;
      }, 10_000);
    } finally {
      await controller.stop();
    }

    expect(batchStarts).toEqual([0, 1]);
  });

  it('coalesces full indexing stats refreshes across streamed completion batches', async () => {
    const refreshCounter = countCollectionStatsRefreshQueries(db);
    const now = new Date().toISOString();
    const embeddingSetId = 'set-stats-coalesce';
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const compositeKey = formatProviderModelKey('local', modelKey);
    const fileId = 'file-stats-coalesce';
    const jobCount = 8;

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        fileId,
        'stats-coalesce.ts',
        '/stats-coalesce.ts',
        100,
        'content',
        'stats-coalesce-hash',
        10,
        embeddingSetId,
        now,
      ]
    );

    for (let index = 0; index < jobCount; index++) {
      const chunkId = `chunk-stats-coalesce-${index}`;
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'text',10,$7,$7)`,
        [chunkId, fileId, index, `content ${index}`, `stats-coalesce-hash-${index}`, 10, now]
      );
      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
        VALUES ($1,'embeddings','embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [
          `job-stats-coalesce-${index}`,
          JSON.stringify({
            chunkId,
            embeddingInputHash: await buildEmbeddingInputHash(
              `stats-coalesce-hash-${index}`,
              compositeKey
            ),
            embeddingSetId,
            expectedDimension: 768,
            modelKey: compositeKey,
            sourceContentHash: `stats-coalesce-hash-${index}`,
          }),
          now,
        ]
      );
    }

    const workerOptions: Parameters<typeof startEmbeddingWorker>[0] & {
      now: () => number;
      statsRefreshCompletedChunkThreshold: number;
      statsRefreshMinIntervalMs: number;
    } = {
      claimBatchSize: jobCount,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 10,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      now: () => 0,
      service: new ChunkedStreamingEmbeddingService(1, 0),
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    };

    const controller = await startEmbeddingWorker(workerOptions);

    await waitFor(async () => {
      const res = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
      );
      return Number(res.rows[0]?.count) === jobCount;
    }, 10_000);

    await controller.stop();

    expect(refreshCounter.getCount()).toBeLessThanOrEqual(2);
  });

  it('flushes pending indexing stats refreshes on idle and stop', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';

    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'stats-idle' });
    const idleLog = vi.fn<(message: string, meta?: unknown) => void>();
    const idleWorkerOptions: Parameters<typeof startEmbeddingWorker>[0] & {
      now: () => number;
      statsRefreshCompletedChunkThreshold: number;
      statsRefreshMinIntervalMs: number;
    } = {
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 10,
      leaseMs: 5000,
      log: idleLog,
      modelKey,
      now: () => 0,
      service: new FakeEmbeddingService(),
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    };

    const idleController = await startEmbeddingWorker(idleWorkerOptions);
    await waitFor(async () => hasStatsRefreshLog(idleLog, 'queue-idle'), 10_000);
    await idleController.stop();

    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'stats-stop' });
    const stopLog = vi.fn<(message: string, meta?: unknown) => void>();
    const stopWorkerOptions: Parameters<typeof startEmbeddingWorker>[0] & {
      now: () => number;
      statsRefreshCompletedChunkThreshold: number;
      statsRefreshMinIntervalMs: number;
    } = {
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: stopLog,
      modelKey,
      now: () => 0,
      service: new FakeEmbeddingService(),
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    };

    const stopController = await startEmbeddingWorker(stopWorkerOptions);
    await waitFor(async () => {
      const res = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE id = 'job-stats-stop' AND state = 'succeeded'`
      );
      return Number(res.rows[0]?.count) === 1;
    }, 10_000);

    await stopController.stop();

    expect(hasStatsRefreshLog(stopLog, 'worker-stop')).toBe(true);
  });

  it('backs off idle queue polling and emits wakeup telemetry', async () => {
    const idleLog = vi.fn<(message: string, meta?: unknown) => void>();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const idleWorkerOptions: Parameters<typeof startEmbeddingWorker>[0] & {
      idlePollInitialMs: number;
      idlePollMaxMs: number;
      now: () => number;
    } = {
      concurrency: 1,
      db: db as unknown as IDatabase,
      idlePollInitialMs: 5,
      idlePollMaxMs: 40,
      leaseMs: 5000,
      log: idleLog,
      modelKey,
      now: Date.now,
      service: new FakeEmbeddingService(),
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    };

    const controller = await startEmbeddingWorker(idleWorkerOptions);
    await waitFor(async () => readIdleBackoffLogs(idleLog).length >= 3, 2000, 5);
    await controller.stop();

    const backoffLogs = readIdleBackoffLogs(idleLog);
    expect(backoffLogs.slice(0, 3).map((meta) => meta['backoffMs'])).toEqual([5, 10, 40]);
    expect(backoffLogs.slice(0, 3).map((meta) => meta['idlePollCount'])).toEqual([1, 2, 4]);
    expect(backoffLogs[2]).toMatchObject({
      queue: 'embeddings',
      workerId: expect.any(String),
    });
    expect(typeof backoffLogs[2]?.['idleDurationBeforeBackoffMs']).toBe('number');
  });

  it('resets idle queue polling backoff after claimed work completes', async () => {
    const idleLog = vi.fn<(message: string, meta?: unknown) => void>();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const now = new Date().toISOString();
    const idleWorkerOptions: Parameters<typeof startEmbeddingWorker>[0] & {
      idlePollInitialMs: number;
      idlePollMaxMs: number;
      now: () => number;
    } = {
      concurrency: 1,
      db: db as unknown as IDatabase,
      idlePollInitialMs: 5,
      idlePollMaxMs: 40,
      leaseMs: 5000,
      log: idleLog,
      modelKey,
      now: Date.now,
      service: new FakeEmbeddingService(),
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    };

    const controller = await startEmbeddingWorker(idleWorkerOptions);
    try {
      await waitFor(
        async () => readIdleBackoffLogs(idleLog).some((meta) => meta['backoffMs'] === 10),
        2000,
        5
      );
      const idleLogCountBeforeWork = readIdleBackoffLogs(idleLog).length;

      await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'idle-reset' });
      await waitFor(async () => {
        const result = await db.query<{ count: number }>(
          `SELECT count(*) as count FROM job_queue WHERE id = 'job-idle-reset' AND state = 'succeeded'`
        );
        return Number(result.rows[0]?.count) === 1;
      }, 10_000);

      await waitFor(
        async () =>
          readIdleBackoffLogs(idleLog)
            .slice(idleLogCountBeforeWork)
            .some((meta) => meta['backoffMs'] === 5 && meta['idlePollCount'] === 1),
        2000,
        5
      );
    } finally {
      await controller.stop();
    }
  });

  it('caps default idle polling latency below interactive backfill thresholds', async () => {
    const idleLog = vi.fn<(message: string, meta?: unknown) => void>();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const idleWorkerOptions: Parameters<typeof startEmbeddingWorker>[0] & {
      idlePollInitialMs: number;
      now: () => number;
    } = {
      concurrency: 1,
      db: db as unknown as IDatabase,
      idlePollInitialMs: 300,
      leaseMs: 5000,
      log: idleLog,
      modelKey,
      now: Date.now,
      service: new FakeEmbeddingService(),
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    };

    const controller = await startEmbeddingWorker(idleWorkerOptions);
    await waitFor(async () => readIdleBackoffLogs(idleLog).length >= 3, 3000, 10);
    await controller.stop();

    expect(
      readIdleBackoffLogs(idleLog)
        .slice(0, 3)
        .map((meta) => meta['backoffMs'])
    ).toEqual([300, 600, 1000]);
  });

  it('rejects idle polling backoff options when max is below the initial delay', async () => {
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const invalidWorkerOptions: Parameters<typeof startEmbeddingWorker>[0] = {
      concurrency: 1,
      db: db as unknown as IDatabase,
      idlePollInitialMs: 50,
      idlePollMaxMs: 40,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      service: new FakeEmbeddingService(),
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    };

    await expect(startEmbeddingWorker(invalidWorkerOptions)).rejects.toThrow(
      'idlePollMaxMs must be greater than or equal to idlePollInitialMs'
    );
  });

  it('rejects malformed EMBED_REINIT_EVERY environment values', async () => {
    const originalValue = process.env['EMBED_REINIT_EVERY'];
    process.env['EMBED_REINIT_EVERY'] = '1e3';
    let controller: { stop: () => Promise<void> } | undefined;
    let thrown: unknown;

    try {
      controller = await startEmbeddingWorker({
        concurrency: 1,
        db: db as unknown as IDatabase,
        leaseMs: 5000,
        log: () => {},
        modelKey: 'jinaai/jina-embeddings-v2-base-code',
        service: new FakeEmbeddingService(),
        statsRefreshCompletedChunkThreshold: 512,
        statsRefreshMinIntervalMs: 60_000,
      });
    } catch (error) {
      thrown = error;
    } finally {
      await controller?.stop();
      if (originalValue === undefined) {
        Reflect.deleteProperty(process.env, 'EMBED_REINIT_EVERY');
      } else {
        process.env['EMBED_REINIT_EVERY'] = originalValue;
      }
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'EMBED_REINIT_EVERY must be a positive integer, received "1e3".'
    );
  });

  it('allows EMBED_REINIT_EVERY zero to disable scheduled reinitialization', async () => {
    const originalValue = process.env['EMBED_REINIT_EVERY'];
    process.env['EMBED_REINIT_EVERY'] = '0';
    let controller: { stop: () => Promise<void> } | undefined;

    try {
      controller = await startEmbeddingWorker({
        concurrency: 1,
        db: db as unknown as IDatabase,
        leaseMs: 5000,
        log: () => {},
        modelKey: 'jinaai/jina-embeddings-v2-base-code',
        service: new FakeEmbeddingService(),
        statsRefreshCompletedChunkThreshold: 512,
        statsRefreshMinIntervalMs: 60_000,
      });
    } finally {
      await controller?.stop();
      if (originalValue === undefined) {
        Reflect.deleteProperty(process.env, 'EMBED_REINIT_EVERY');
      } else {
        process.env['EMBED_REINIT_EVERY'] = originalValue;
      }
    }
  });

  it('allows explicit reinitEveryN zero to disable scheduled reinitialization', async () => {
    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 5000,
      log: () => {},
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      reinitEveryN: 0,
      service: new FakeEmbeddingService(),
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    });

    await controller.stop();
  });

  it('does not run scheduled WASM heap reinitialization for WebGPU batches', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    await insertQueuedEmbeddingJob({ db, modelKey, now, prefix: 'webgpu-no-scheduled-reinit' });
    const service = new RuntimeMetadataStreamingEmbeddingService(1, 0, {
      device: 'webgpu',
      dtype: 'fp16',
      fallbackApplied: false,
    });
    const disposeSpy = vi.spyOn(service, 'dispose');

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      reinitEveryN: 1,
      service,
    });

    try {
      await waitFor(async () => {
        const succeeded = await db.query<{ count: number }>(
          `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
        );
        return Number(succeeded.rows[0]?.count) === 1;
      }, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(disposeSpy).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
      disposeSpy.mockRestore();
    }
  });

  it('validates metrics interval config before initializing the embedding service', async () => {
    const originalValue = process.env['WORKER_METRICS_INTERVAL_MS'];
    process.env['WORKER_METRICS_INTERVAL_MS'] = 'abc';
    const service = new FakeEmbeddingService();
    const generateEmbeddingSpy = vi.spyOn(service, 'generateEmbedding');

    try {
      await expect(
        startEmbeddingWorker({
          concurrency: 1,
          db: db as unknown as IDatabase,
          leaseMs: 5000,
          log: () => {},
          modelKey: 'missing-custom-model',
          service,
          statsRefreshCompletedChunkThreshold: 512,
          statsRefreshMinIntervalMs: 60_000,
        })
      ).rejects.toThrow('WORKER_METRICS_INTERVAL_MS must be a positive integer, received "abc".');
      expect(generateEmbeddingSpy).not.toHaveBeenCalled();
    } finally {
      if (originalValue === undefined) {
        Reflect.deleteProperty(process.env, 'WORKER_METRICS_INTERVAL_MS');
      } else {
        process.env['WORKER_METRICS_INTERVAL_MS'] = originalValue;
      }
    }
  });

  it('disposes worker resources when stop-time indexing stats refresh fails', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const compositeKey = formatProviderModelKey('local', modelKey);
    const embeddingSetId = 'set-stop-refresh-failure';
    const fileId = 'file-stop-refresh-failure';
    const chunkId = 'chunk-stop-refresh-failure';
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        fileId,
        'stop-refresh-failure.ts',
        '/stop-refresh-failure.ts',
        100,
        'content',
        'hash',
        10,
        embeddingSetId,
        now,
      ]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
        VALUES ($1,$2,0,$3,$4,$5,'text',10,$6,$6)`,
      [chunkId, fileId, 'content', 'hash', 10, now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
        VALUES ('job-stop-refresh-failure','embeddings','embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId,
          embeddingInputHash: await buildEmbeddingInputHash('hash', compositeKey),
          embeddingSetId,
          expectedDimension: 768,
          modelKey: compositeKey,
          sourceContentHash: 'hash',
        }),
        now,
      ]
    );

    const service = new FakeEmbeddingService();
    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      now: () => 0,
      service,
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    });
    await waitFor(async () => {
      const res = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE id = 'job-stop-refresh-failure' AND state = 'succeeded'`
      );
      return Number(res.rows[0]?.count) === 1;
    }, 10_000);

    const originalQuery = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('aggregated_chunks') && sql.includes('collection_indexing_stats')) {
        throw new Error('stop stats refresh failed');
      }
      return await originalQuery(sql, params);
    });

    await expect(controller.stop()).resolves.toBeUndefined();
    expect(service.getStatus()).toBe('disposed');
  });

  it('does not mark indexing stats dirty when embedding completion loses lease', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const compositeKey = formatProviderModelKey('local', modelKey);
    const embeddingSetId = 'set-lease-loss-stats';
    const fileId = 'file-lease-loss-stats';
    const chunkId = 'chunk-lease-loss-stats';
    const jobId = 'job-lease-loss-stats';
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        fileId,
        'lease-loss-stats.ts',
        '/lease-loss-stats.ts',
        100,
        'content',
        'hash',
        10,
        embeddingSetId,
        now,
      ]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
        VALUES ($1,$2,0,$3,$4,$5,'text',10,$6,$6)`,
      [chunkId, fileId, 'content', 'hash', 10, now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
        VALUES ($1,'embeddings','embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
      [
        jobId,
        JSON.stringify({
          chunkId,
          embeddingInputHash: await buildEmbeddingInputHash('hash', compositeKey),
          embeddingSetId,
          expectedDimension: 768,
          modelKey: compositeKey,
          sourceContentHash: 'hash',
        }),
        now,
      ]
    );

    const completeBatchSpy = vi
      .spyOn(JobQueue.prototype, 'completeEmbeddingChunkBatch')
      .mockResolvedValueOnce([]);
    const originalQuery = db.query.bind(db);
    let dirtyWriteCount = 0;
    vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE collection_indexing_stats')) {
        dirtyWriteCount += 1;
      }
      return await originalQuery(sql, params);
    });

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      service: new FakeEmbeddingService(),
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    });
    await waitFor(async () => completeBatchSpy.mock.calls.length === 1, 10_000);

    await controller.stop();
    completeBatchSpy.mockRestore();

    const chunk = await db.query<{ count: number }>(
      'SELECT count(*) as count FROM file_chunks WHERE id = $1 AND embedding IS NOT NULL',
      [chunkId]
    );
    expect(Number(chunk.rows[0]?.count)).toBe(0);
    expect(dirtyWriteCount).toBe(0);
  });

  it('does not fail completed embedding jobs when stats maintenance fails', async () => {
    const now = new Date().toISOString();
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const compositeKey = formatProviderModelKey('local', modelKey);
    const embeddingSetId = 'set-stats-maintenance-failure';
    const fileId = 'file-stats-maintenance-failure';
    const chunkId = 'chunk-stats-maintenance-failure';
    const jobId = 'job-stats-maintenance-failure';
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        fileId,
        'stats-maintenance-failure.ts',
        '/stats-maintenance-failure.ts',
        100,
        'content',
        'hash',
        10,
        embeddingSetId,
        now,
      ]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
        VALUES ($1,$2,0,$3,$4,$5,'text',10,$6,$6)`,
      [chunkId, fileId, 'content', 'hash', 10, now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
        VALUES ($1,'embeddings','embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
      [
        jobId,
        JSON.stringify({
          chunkId,
          embeddingInputHash: await buildEmbeddingInputHash('hash', compositeKey),
          embeddingSetId,
          expectedDimension: 768,
          modelKey: compositeKey,
          sourceContentHash: 'hash',
        }),
        now,
      ]
    );

    const failBatchSpy = vi.spyOn(JobQueue.prototype, 'failBatch');
    const originalQuery = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE collection_indexing_stats')) {
        throw new Error('stats dirty mark failed');
      }
      return await originalQuery(sql, params);
    });

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      interBatchDelayMs: 1000,
      leaseMs: 5000,
      log: () => {},
      modelKey,
      service: new FakeEmbeddingService(),
      statsRefreshCompletedChunkThreshold: 512,
      statsRefreshMinIntervalMs: 60_000,
    });
    await waitFor(async () => {
      const res = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE id = $1 AND state = 'succeeded'`,
        [jobId]
      );
      return Number(res.rows[0]?.count) === 1;
    }, 10_000);

    await controller.stop();
    expect(failBatchSpy).not.toHaveBeenCalled();
    failBatchSpy.mockRestore();
  });

  it('keeps 20k-completion indexing stats refresh cadence bounded', async () => {
    const completedChunkCount = 20_000;
    const threshold = 512;
    let refreshCount = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('aggregated_chunks') && sql.includes('collection_indexing_stats')) {
          refreshCount += 1;
          return {
            rows: [
              {
                chunkCount: completedChunkCount,
                dirty: false,
                embeddedChunkCount: completedChunkCount,
                embeddingSetId: 'set-scale',
                fileCount: 1,
                lastRefreshedAt: new Date().toISOString(),
                pendingChunkCount: 0,
              },
            ],
          };
        }
        if (sql.includes('UPDATE collection_indexing_stats')) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    } as unknown as IDatabase;

    const controller = createEmbeddingStatsRefreshController({
      completedChunkThreshold: threshold,
      db,
      log: () => {},
      minIntervalMs: 60_000,
      now: () => 0,
    });

    for (let index = 0; index < completedChunkCount; index++) {
      await controller.recordCompletions(['set-scale'], 1);
      await controller.flushIfDue();
    }
    await controller.flush('worker-stop');

    expect(refreshCount).toBe(Math.ceil(completedChunkCount / threshold));
  });

  it('skips duplicate stats dirty writes while the same embedding set is already pending', async () => {
    let dirtyWriteCount = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE collection_indexing_stats')) {
          dirtyWriteCount += 1;
          return { rows: [] };
        }
        if (sql.includes('aggregated_chunks') && sql.includes('collection_indexing_stats')) {
          return {
            rows: [
              {
                chunkCount: 2,
                dirty: false,
                embeddedChunkCount: 2,
                embeddingSetId: 'set-pending',
                fileCount: 1,
                lastRefreshedAt: new Date().toISOString(),
                pendingChunkCount: 0,
              },
            ],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    } as unknown as IDatabase;

    const controller = createEmbeddingStatsRefreshController({
      completedChunkThreshold: 512,
      db,
      log: () => {},
      minIntervalMs: 60_000,
      now: () => 0,
    });

    await controller.recordCompletions(['set-pending'], 1);
    await controller.recordCompletions(['set-pending'], 1);
    await controller.flush('worker-stop');

    expect(dirtyWriteCount).toBe(1);
  });

  it('retains pending stats refresh work when dirty marking fails', async () => {
    let failDirtyWrite = true;
    let refreshCount = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE collection_indexing_stats')) {
          if (failDirtyWrite) {
            throw new Error('dirty mark failed');
          }
          return { rows: [] };
        }
        if (sql.includes('aggregated_chunks') && sql.includes('collection_indexing_stats')) {
          refreshCount += 1;
          return {
            rows: [
              {
                chunkCount: 1,
                dirty: false,
                embeddedChunkCount: 1,
                embeddingSetId: 'set-dirty-failure',
                fileCount: 1,
                lastRefreshedAt: new Date().toISOString(),
                pendingChunkCount: 0,
              },
            ],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    } as unknown as IDatabase;

    const controller = createEmbeddingStatsRefreshController({
      completedChunkThreshold: 512,
      db,
      log: () => {},
      minIntervalMs: 60_000,
      now: () => 0,
    });

    await expect(controller.recordCompletions(['set-dirty-failure'], 1)).rejects.toThrow(
      'dirty mark failed'
    );
    failDirtyWrite = false;
    await controller.flush('worker-stop');

    expect(refreshCount).toBe(1);
  });

  it('serializes concurrent stats refresh flushes', async () => {
    let activeRefreshCount = 0;
    let maxActiveRefreshCount = 0;
    let refreshCount = 0;
    let resolveFirstRefreshStarted: (() => void) | undefined;
    let releaseFirstRefresh: (() => void) | undefined;
    let releaseSecondRefresh: (() => void) | undefined;
    let controller: EmbeddingStatsRefreshController | undefined;
    const firstRefreshStarted = new Promise<void>((resolve) => {
      resolveFirstRefreshStarted = resolve;
    });
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE collection_indexing_stats')) {
          return { rows: [] };
        }
        if (sql.includes('aggregated_chunks') && sql.includes('collection_indexing_stats')) {
          refreshCount += 1;
          activeRefreshCount += 1;
          maxActiveRefreshCount = Math.max(maxActiveRefreshCount, activeRefreshCount);
          if (refreshCount === 1) {
            resolveFirstRefreshStarted?.();
            await new Promise<void>((release) => {
              releaseFirstRefresh = release;
            });
          }
          if (refreshCount === 2) {
            await controller?.recordCompletions(['set-concurrent-c'], 1);
            await new Promise<void>((release) => {
              releaseSecondRefresh = release;
            });
          }
          activeRefreshCount -= 1;
          return {
            rows: [
              {
                chunkCount: 1,
                dirty: false,
                embeddedChunkCount: 1,
                embeddingSetId: `set-concurrent-${refreshCount}`,
                fileCount: 1,
                lastRefreshedAt: new Date().toISOString(),
                pendingChunkCount: 0,
              },
            ],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    } as unknown as IDatabase;

    controller = createEmbeddingStatsRefreshController({
      completedChunkThreshold: 512,
      db,
      log: () => {},
      minIntervalMs: 60_000,
      now: () => 0,
    });

    await controller.recordCompletions(['set-concurrent-a'], 1);
    const firstFlush = controller.flush('worker-stop');

    await firstRefreshStarted;
    await controller.recordCompletions(['set-concurrent-b'], 1);
    const secondFlush = controller.flush('queue-idle');
    const thirdFlush = controller.flush('threshold');
    releaseFirstRefresh?.();
    await waitFor(async () => releaseSecondRefresh !== undefined, 10_000);
    releaseSecondRefresh?.();
    await Promise.all([firstFlush, secondFlush, thirdFlush]);
    await waitFor(async () => refreshCount === 3, 10_000);

    expect(maxActiveRefreshCount).toBe(1);
  });
});

// Increase timeouts to reduce flakiness under workspace-wide runs
vi.setConfig({
  hookTimeout: PGLITE_SETUP_TIMEOUT_MS,
  testTimeout: EMBEDDING_WORKER_TEST_TIMEOUT_MS,
});
