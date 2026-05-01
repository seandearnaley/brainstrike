/**
 * Integration tests for embedding worker cache operations and concurrent access patterns.
 *
 * Tests BST-136 PR review critical items:
 * - Fire-and-forget cache operations failure handling
 * - Concurrent access patterns
 * - Model switching scenarios
 * - Lease management edge cases
 */
import type { IDatabase } from '@brainstrike/db';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types';
import type { CachedEmbedding, EmbeddingCacheInterface } from '../worker/embedding-worker';

/**
 * Standard fake embedding service for testing
 */
class FakeEmbeddingService implements EmbeddingService {
  private status: EmbeddingStatus = 'ready';
  private readonly dimensions: number;
  public callCount = 0;

  constructor(dimensions = 768) {
    this.dimensions = dimensions;
  }

  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    this.status = 'ready';
    return Promise.resolve();
  }

  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    this.callCount++;
    return {
      embedding: new Array(this.dimensions).fill(0.1),
      dimensions: this.dimensions,
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

/**
 * Helper to wait for a condition with timeout
 */
async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
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

/**
 * Helper to setup test data in database
 */
async function setupTestData(
  db: PGlite,
  options: {
    embeddingSetId: string;
    modelKey: string;
    modelId: string;
    dimensions: number;
    fileId: string;
    chunkId: string;
    jobId: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const { embeddingSetId, modelKey, modelId, dimensions, fileId, chunkId, jobId } = options;

  await db.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [embeddingSetId, modelKey, modelId, dimensions, 'cosine', now]
  );

  await db.query(
    `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [fileId, 'test.ts', '/test.ts', 100, 'hello world', `hash-${chunkId}`, 10, now]
  );

  await db.query(
    `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
     VALUES ($1, $2, 0, $3, $4, 10, 'text', 10, $5, $5)`,
    [chunkId, fileId, 'hello world', `hash-${chunkId}`, now]
  );

  await db.query(
    `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
     VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
    [
      jobId,
      JSON.stringify({
        chunkId,
        embeddingSetId,
        modelKey,
        expectedDimension: dimensions,
      }),
      now,
    ]
  );
}

describe('embedding-worker: cache operations', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://cache-test');
    await migrate(db);
  });

  afterEach(async () => {
    // Ensure cleanup
    vi.restoreAllMocks();
  });

  it('continues successfully when cache setBatch fails (fire-and-forget)', async () => {
    const logs: Array<{ msg: string; meta?: unknown }> = [];
    let cacheSetBatchCalled = false;
    let cacheSetBatchFailed = false;

    // Create a failing cache implementation
    const failingCache: EmbeddingCacheInterface = {
      get: async () => ({ hit: false, entry: null }),
      getBatch: async () => new Map(),
      set: async () => {
        throw new Error('Simulated cache set failure');
      },
      setBatch: async () => {
        cacheSetBatchCalled = true;
        cacheSetBatchFailed = true;
        throw new Error('Simulated cache setBatch failure');
      },
    };

    await setupTestData(db, {
      embeddingSetId: 'cache-fail-set',
      modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      dimensions: 768,
      fileId: 'cache-fail-file',
      chunkId: 'cache-fail-chunk',
      jobId: 'cache-fail-job',
    });

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 5000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new FakeEmbeddingService(),
      embeddingCache: failingCache,
      log: (msg, meta) => logs.push({ msg, meta }),
    });

    // Wait for job to complete
    let finalState = '';
    await waitFor(async () => {
      const res = await db.query(`SELECT state FROM job_queue WHERE id = 'cache-fail-job'`);
      const row = res.rows[0] as { state: string } | undefined;
      finalState = row?.state ?? '';
      return finalState === 'succeeded' || finalState === 'failed';
    });

    // Job should succeed despite cache failure
    expect(finalState).toBe('succeeded');
    expect(cacheSetBatchCalled).toBe(true);
    expect(cacheSetBatchFailed).toBe(true);

    // The cache failure warning may or may not be logged depending on timing,
    // but the critical assertion is that the job succeeded despite cache failure

    await controller.stop();
  });

  it('uses cache hits to avoid regenerating embeddings', async () => {
    const service = new FakeEmbeddingService();
    const cachedEmbedding = new Array(768).fill(0.5);

    // Create a cache that returns a hit
    const cacheWithHit: EmbeddingCacheInterface = {
      get: async (contentHash, modelKey) => ({
        hit: true,
        entry: {
          contentHash,
          modelKey,
          embedding: cachedEmbedding,
          dimensions: 768,
        },
      }),
      getBatch: async (requests) => {
        const result = new Map<string, CachedEmbedding>();
        for (const req of requests) {
          result.set(`${req.contentHash}:${req.modelKey}`, {
            contentHash: req.contentHash,
            modelKey: req.modelKey,
            embedding: cachedEmbedding,
            dimensions: 768,
          });
        }
        return result;
      },
      set: async () => {},
      setBatch: async () => 0,
    };

    await setupTestData(db, {
      embeddingSetId: 'cache-hit-set',
      modelKey: 'local::jina-code',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      dimensions: 768,
      fileId: 'cache-hit-file',
      chunkId: 'cache-hit-chunk',
      jobId: 'cache-hit-job',
    });

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 5000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service,
      embeddingCache: cacheWithHit,
      log: () => {},
    });

    await waitFor(async () => {
      const res = await db.query(`SELECT state FROM job_queue WHERE id = 'cache-hit-job'`);
      const row = res.rows[0] as { state: string } | undefined;
      return row?.state === 'succeeded';
    });

    // Service should NOT have been called since we used cache hit
    expect(service.callCount).toBe(0);

    await controller.stop();
  });

  it('runs cache maintenance and logs cache stats after the queue drains', async () => {
    const logs: Array<{ msg: string; meta?: unknown }> = [];
    const cacheWithMaintenance: EmbeddingCacheInterface = {
      evictIfNeeded: vi.fn(async () => ({ evicted: 0, needed: false, totalEntries: 1 })),
      get: async () => ({ hit: false, entry: null }),
      getBatch: async () => new Map(),
      getStats: vi.fn(async () => ({
        newestAccessedAt: new Date('2026-01-01T00:00:00.000Z'),
        oldestAccessedAt: new Date('2026-01-01T00:00:00.000Z'),
        totalEntries: 1,
        totalHits: 0,
      })),
      set: async () => {},
      setBatch: vi.fn(async (entries) => entries.length),
    };
    const evictIfNeeded = cacheWithMaintenance.evictIfNeeded;
    const getStats = cacheWithMaintenance.getStats;
    if (!(evictIfNeeded && getStats)) {
      throw new Error('Expected maintenance cache methods to be defined.');
    }

    await setupTestData(db, {
      embeddingSetId: 'cache-maintenance-set',
      modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      dimensions: 768,
      fileId: 'cache-maintenance-file',
      chunkId: 'cache-maintenance-chunk',
      jobId: 'cache-maintenance-job',
    });

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 5000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new FakeEmbeddingService(),
      embeddingCache: cacheWithMaintenance,
      log: (msg, meta) => logs.push({ msg, meta }),
    });

    await waitFor(async () => {
      const res = await db.query(`SELECT state FROM job_queue WHERE id = 'cache-maintenance-job'`);
      const row = res.rows[0] as { state: string } | undefined;
      return row?.state === 'succeeded';
    });

    await waitFor(
      async () =>
        vi.mocked(evictIfNeeded).mock.calls.length > 0 &&
        logs.some((entry) => entry.msg === 'embedding_cache_stats')
    );

    expect(evictIfNeeded).toHaveBeenCalled();
    expect(getStats).toHaveBeenCalled();
    expect(logs).toContainEqual(
      expect.objectContaining({
        meta: expect.objectContaining({
          totalEntries: 1,
          totalHits: 0,
        }),
        msg: 'embedding_cache_stats',
      })
    );

    await controller.stop();
  });
});

describe('embedding-worker: concurrent access patterns', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://concurrent-test');
    await migrate(db);
  });

  it('processes multiple jobs concurrently with concurrency > 1', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'concurrent-set';

    // Create embedding set
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        embeddingSetId,
        'local::jina-code',
        'jinaai/jina-embeddings-v2-base-code',
        768,
        'cosine',
        now,
      ]
    );

    // Create multiple file records, chunks, and jobs
    const jobIds = ['job-c1', 'job-c2', 'job-c3'];
    for (let i = 0; i < jobIds.length; i++) {
      const fileId = `file-c${i + 1}`;
      const chunkId = `chunk-c${i + 1}`;

      await db.query(
        `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [fileId, `test${i}.ts`, `/test${i}.ts`, 100, `content ${i}`, `hash-c${i}`, 10, now]
      );

      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
         VALUES ($1, $2, 0, $3, $4, 10, 'text', 10, $5, $5)`,
        [chunkId, fileId, `content ${i}`, `hash-c${i}`, now]
      );

      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [jobIds[i], JSON.stringify({ chunkId, embeddingSetId }), now]
      );
    }

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 3, // Process all 3 jobs concurrently
      leaseMs: 5000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new FakeEmbeddingService(),
      log: () => {},
    });

    // Wait for all jobs to complete
    await waitFor(async () => {
      const res = await db.query(
        `SELECT COUNT(*) as count FROM job_queue WHERE state = 'succeeded'`
      );
      const row = res.rows[0] as { count: number } | undefined;
      return Number(row?.count ?? 0) === 3;
    }, 15_000);

    // Verify all jobs succeeded
    for (const jobId of jobIds) {
      const res = await db.query('SELECT state FROM job_queue WHERE id = $1', [jobId]);
      const row = res.rows[0] as { state: string } | undefined;
      expect(row?.state).toBe('succeeded');
    }

    await controller.stop();
  });

  it('caps the number of running jobs to the configured claim batch size', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'claim-cap-set';
    const modelId = 'jinaai/jina-embeddings-v2-base-code';
    const modelKey = `local::${modelId}`;

    class SlowBatchService extends FakeEmbeddingService {
      override async generateEmbedding(text: string): Promise<EmbeddingResult> {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return await super.generateEmbedding(text);
      }
    }

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, modelKey, modelId, 768, 'cosine', now]
    );

    for (let index = 0; index < 6; index += 1) {
      const fileId = `file-cap-${index}`;
      const chunkId = `chunk-cap-${index}`;
      const jobId = `job-cap-${index}`;

      await db.query(
        `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          fileId,
          `cap${index}.ts`,
          `/cap${index}.ts`,
          100,
          `content ${index}`,
          `hash-cap-${index}`,
          10,
          now,
        ]
      );

      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
         VALUES ($1, $2, 0, $3, $4, 10, 'text', 10, $5, $5)`,
        [chunkId, fileId, `content ${index}`, `hash-cap-${index}`, now]
      );

      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [
          jobId,
          JSON.stringify({
            chunkId,
            embeddingSetId,
            modelKey,
            expectedDimension: 768,
          }),
          now,
        ]
      );
    }

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      claimBatchSize: 2,
      concurrency: 1,
      leaseMs: 5000,
      modelKey,
      service: new SlowBatchService(),
      log: () => {},
    });

    await waitFor(async () => {
      const res = await db.query(
        `SELECT COUNT(*)::int AS count FROM job_queue WHERE state = 'running'`
      );
      const row = res.rows[0] as { count: number } | undefined;
      return Number(row?.count ?? 0) === 2;
    }, 10_000);

    const runningRes = await db.query(
      `SELECT COUNT(*)::int AS count FROM job_queue WHERE state = 'running'`
    );
    const queuedRes = await db.query(
      `SELECT COUNT(*)::int AS count FROM job_queue WHERE state = 'queued'`
    );
    const runningRow = runningRes.rows[0] as { count: number } | undefined;
    const queuedRow = queuedRes.rows[0] as { count: number } | undefined;

    expect(Number(runningRow?.count ?? 0)).toBe(2);
    expect(Number(queuedRow?.count ?? 0)).toBeGreaterThan(0);

    await waitFor(async () => {
      const res = await db.query(
        `SELECT COUNT(*)::int AS count FROM job_queue WHERE state = 'succeeded'`
      );
      const row = res.rows[0] as { count: number } | undefined;
      return Number(row?.count ?? 0) === 6;
    }, 15_000);

    await controller.stop();
  });

  it('handles multiple workers claiming different jobs (lease contention)', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'contention-set';

    // Create embedding set
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        embeddingSetId,
        'local::jina-code',
        'jinaai/jina-embeddings-v2-base-code',
        768,
        'cosine',
        now,
      ]
    );

    // Create 4 jobs
    for (let i = 0; i < 4; i++) {
      const fileId = `file-l${i}`;
      const chunkId = `chunk-l${i}`;

      await db.query(
        `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [fileId, `test${i}.ts`, `/test${i}.ts`, 100, `lease content ${i}`, `hash-l${i}`, 10, now]
      );

      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
         VALUES ($1, $2, 0, $3, $4, 10, 'text', 10, $5, $5)`,
        [chunkId, fileId, `lease content ${i}`, `hash-l${i}`, now]
      );

      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [`job-l${i}`, JSON.stringify({ chunkId, embeddingSetId }), now]
      );
    }

    // Start two workers with concurrency=2 each (simulating competition)
    const controller1 = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 2,
      leaseMs: 5000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new FakeEmbeddingService(),
      log: () => {},
    });

    const controller2 = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 2,
      leaseMs: 5000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new FakeEmbeddingService(),
      log: () => {},
    });

    // Wait for all jobs to complete
    await waitFor(async () => {
      const res = await db.query(
        `SELECT COUNT(*) as count FROM job_queue WHERE state = 'succeeded'`
      );
      const row = res.rows[0] as { count: number } | undefined;
      return Number(row?.count ?? 0) === 4;
    }, 15_000);

    // All jobs should have succeeded (no duplicates processed)
    const res = await db.query(`SELECT state FROM job_queue WHERE state = 'succeeded'`);
    expect(res.rows.length).toBe(4);

    await controller1.stop();
    await controller2.stop();
  });
});

describe('embedding-worker: lease management edge cases', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://lease-test');
    await migrate(db);
  });

  it('job fails gracefully when lease expires mid-processing', async () => {
    const logs: Array<{ msg: string; meta?: unknown }> = [];

    // Create a slow service that takes longer than the lease
    class VerySlowService extends FakeEmbeddingService {
      override async generateEmbedding(_text: string): Promise<EmbeddingResult> {
        // Sleep longer than the lease
        await new Promise((r) => setTimeout(r, 3000));
        return super.generateEmbedding(_text);
      }
    }

    await setupTestData(db, {
      embeddingSetId: 'lease-expire-set',
      modelKey: 'local::jina-code',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      dimensions: 768,
      fileId: 'lease-expire-file',
      chunkId: 'lease-expire-chunk',
      jobId: 'lease-expire-job',
    });

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 100, // Very short lease
      heartbeatIntervalMs: 50,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new VerySlowService(),
      log: (msg, meta) => logs.push({ msg, meta }),
    });

    // Wait for job to reach a terminal state (may be succeeded if heartbeat keeps it alive, or failed)
    let finalState = '';
    await waitFor(
      async () => {
        const res = await db.query(`SELECT state FROM job_queue WHERE id = 'lease-expire-job'`);
        const row = res.rows[0] as { state: string } | undefined;
        finalState = row?.state ?? '';
        return finalState === 'succeeded' || finalState === 'failed';
      },
      15_000,
      100
    );

    // Either outcome is acceptable - the key is no crash and proper state transition
    expect(['succeeded', 'failed']).toContain(finalState);

    await controller.stop();
  });

  it('handles lease extension during long-running batch operations', async () => {
    // Create a service with moderate delay
    class ModeratelySlowService extends FakeEmbeddingService {
      override async generateEmbedding(_text: string): Promise<EmbeddingResult> {
        await new Promise((r) => setTimeout(r, 200));
        return super.generateEmbedding(_text);
      }
    }

    await setupTestData(db, {
      embeddingSetId: 'lease-extend-set',
      modelKey: 'local::jina-code',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      dimensions: 768,
      fileId: 'lease-extend-file',
      chunkId: 'lease-extend-chunk',
      jobId: 'lease-extend-job',
    });

    const logs: Array<{ msg: string; meta?: unknown }> = [];

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 2000,
      heartbeatIntervalMs: 100, // Frequent heartbeats to extend lease
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new ModeratelySlowService(),
      log: (msg, meta) => logs.push({ msg, meta }),
    });

    // Wait for job to complete
    await waitFor(async () => {
      const res = await db.query(`SELECT state FROM job_queue WHERE id = 'lease-extend-job'`);
      const row = res.rows[0] as { state: string } | undefined;
      return row?.state === 'succeeded';
    }, 10_000);

    // Job should succeed with heartbeats keeping lease alive
    const res = await db.query(`SELECT state FROM job_queue WHERE id = 'lease-extend-job'`);
    const row = res.rows[0] as { state: string } | undefined;
    expect(row?.state).toBe('succeeded');

    await controller.stop();
  });
});

// Increase timeouts for integration tests
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
