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
});

// Increase timeouts to reduce flakiness under workspace-wide runs
vi.setConfig({
  hookTimeout: PGLITE_SETUP_TIMEOUT_MS,
  testTimeout: EMBEDDING_WORKER_TEST_TIMEOUT_MS,
});
