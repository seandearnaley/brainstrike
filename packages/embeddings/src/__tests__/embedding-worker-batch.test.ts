import type { IDatabase } from '@brainstrike/db';
import { JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatProviderModelKey, startEmbeddingWorker } from '../index';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types';
import type { EmbeddingStatsRefreshController } from '../worker/embedding-worker';
import { createEmbeddingStatsRefreshController } from '../worker/embedding-worker';

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
      embedding: new Array(768).fill(0.1),
      dimensions: 768,
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
    await onBatch({ startIndex: 0, endIndex: results.length, results });
  }
  async generateDocEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  async generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  calculateSimilarity(_e1: number[], _e2: number[]): SimilarityResult {
    return { similarity: 1, distance: 0, method: 'cosine' };
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
  constructor(
    private readonly streamBatchSize: number,
    private readonly delayAfterBatchMs: number
  ) {
    super();
  }

  override async generateEmbeddingsStream(
    texts: string[],
    onBatch: (batch: {
      startIndex: number;
      endIndex: number;
      results: EmbeddingResult[];
    }) => Promise<void> | void
  ): Promise<void> {
    for (let startIndex = 0; startIndex < texts.length; startIndex += this.streamBatchSize) {
      const endIndex = Math.min(texts.length, startIndex + this.streamBatchSize);
      const results = await this.generateEmbeddings(texts.slice(startIndex, endIndex));
      await onBatch({ startIndex, endIndex, results });
      await new Promise((resolve) => setTimeout(resolve, this.delayAfterBatchMs));
    }
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
        embeddingSetId,
        modelKey: compositeKey,
        expectedDimension: 768,
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
            embeddingSetId,
            modelKey: compositeKey,
            expectedDimension: 768,
          }),
          now,
        ]
      );
    }

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 2000,
      modelKey,
      service: new FakeEmbeddingService(),
      log: () => {}, // silence logs
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

  it('waits for background database permits before claiming and completing jobs', async () => {
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
          embeddingSetId,
          modelKey: compositeKey,
          expectedDimension: 768,
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 2000,
      modelKey,
      service: new FakeEmbeddingService(),
      waitForBackgroundPermit,
      log: () => {},
    });

    await waitFor(async () => {
      const res = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
      );
      return Number(res.rows[0]?.count) === 1;
    }, 10_000);

    await controller.stop();

    expect(waitForBackgroundPermit).toHaveBeenCalledWith({ label: 'embedding claim' });
    expect(waitForBackgroundPermit).toHaveBeenCalledWith({ label: 'embedding completion' });
  });

  it('uses a resolved claim batch size when polling the queue', async () => {
    const claimManySpy = vi.spyOn(JobQueue.prototype, 'claimMany');
    const resolveClaimBatchSize = vi.fn(async () => 3);

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      claimBatchSize: 10,
      concurrency: 1,
      leaseMs: 2000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      resolveClaimBatchSize,
      service: new FakeEmbeddingService(),
      log: () => {},
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
      db: db as unknown as IDatabase,
      claimBatchSize: 10,
      concurrency: 1,
      leaseMs: 2000,
      metricsIntervalMs: 5000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      resolveClaimBatchSize,
      service: new FakeEmbeddingService(),
      log: (event, meta) => {
        if (event === 'worker_metrics') {
          metricLogs.push(meta as Record<string, unknown>);
        }
      },
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
            embeddingSetId,
            modelKey: compositeKey,
            expectedDimension: 768,
          }),
          now,
        ]
      );
    }

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      claimBatchSize: jobCount,
      concurrency: 1,
      heartbeatIntervalMs: 10,
      interBatchDelayMs: 10,
      leaseMs: 5000,
      modelKey,
      service: new ChunkedStreamingEmbeddingService(2, 30),
      log: () => {},
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
            embeddingSetId,
            modelKey: compositeKey,
            expectedDimension: 768,
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
      db: db as unknown as IDatabase,
      claimBatchSize: jobCount,
      concurrency: 1,
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
      db: db as unknown as IDatabase,
      concurrency: 1,
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
      db: db as unknown as IDatabase,
      concurrency: 1,
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
      db: db as unknown as IDatabase,
      concurrency: 1,
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
      db: db as unknown as IDatabase,
      concurrency: 1,
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
      db: db as unknown as IDatabase,
      concurrency: 1,
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
      db: db as unknown as IDatabase,
      concurrency: 1,
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
        db: db as unknown as IDatabase,
        concurrency: 1,
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
        db: db as unknown as IDatabase,
        concurrency: 1,
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
      db: db as unknown as IDatabase,
      concurrency: 1,
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

  it('validates metrics interval config before initializing the embedding service', async () => {
    const originalValue = process.env['WORKER_METRICS_INTERVAL_MS'];
    process.env['WORKER_METRICS_INTERVAL_MS'] = 'abc';
    const service = new FakeEmbeddingService();
    const generateEmbeddingSpy = vi.spyOn(service, 'generateEmbedding');

    try {
      await expect(
        startEmbeddingWorker({
          db: db as unknown as IDatabase,
          concurrency: 1,
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
          embeddingSetId,
          modelKey: compositeKey,
          expectedDimension: 768,
        }),
        now,
      ]
    );

    const service = new FakeEmbeddingService();
    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
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

  it('marks indexing stats dirty when chunk updates succeed but job completion loses lease', async () => {
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
          embeddingSetId,
          modelKey: compositeKey,
          expectedDimension: 768,
        }),
        now,
      ]
    );

    const completeBatchSpy = vi
      .spyOn(JobQueue.prototype, 'completeBatch')
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
      db: db as unknown as IDatabase,
      concurrency: 1,
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
        'SELECT count(*) as count FROM file_chunks WHERE id = $1 AND embedding IS NOT NULL',
        [chunkId]
      );
      return Number(res.rows[0]?.count) === 1;
    }, 10_000);

    await controller.stop();
    completeBatchSpy.mockRestore();

    expect(dirtyWriteCount).toBe(1);
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
          embeddingSetId,
          modelKey: compositeKey,
          expectedDimension: 768,
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
      db: db as unknown as IDatabase,
      concurrency: 1,
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
                embeddingSetId: 'set-scale',
                fileCount: 1,
                chunkCount: completedChunkCount,
                embeddedChunkCount: completedChunkCount,
                pendingChunkCount: 0,
                dirty: false,
                lastRefreshedAt: new Date().toISOString(),
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
                embeddingSetId: 'set-pending',
                fileCount: 1,
                chunkCount: 2,
                embeddedChunkCount: 2,
                pendingChunkCount: 0,
                dirty: false,
                lastRefreshedAt: new Date().toISOString(),
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
                embeddingSetId: 'set-dirty-failure',
                fileCount: 1,
                chunkCount: 1,
                embeddedChunkCount: 1,
                pendingChunkCount: 0,
                dirty: false,
                lastRefreshedAt: new Date().toISOString(),
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
                embeddingSetId: `set-concurrent-${refreshCount}`,
                fileCount: 1,
                chunkCount: 1,
                embeddedChunkCount: 1,
                pendingChunkCount: 0,
                dirty: false,
                lastRefreshedAt: new Date().toISOString(),
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
