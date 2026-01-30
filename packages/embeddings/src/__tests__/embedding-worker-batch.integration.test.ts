import type { IDatabase } from '@brainstrike/db';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startEmbeddingWorker } from '../index';
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

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  // biome-ignore lint/correctness/noConstantCondition: valid loop pattern for tests
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

describe('embedding-worker-batch', () => {
  let db: PGlite;
  let queryCount = 0;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://embedding-worker-batch');
    await migrate(db);

    // Wrap query to count
    const originalQuery = db.query.bind(db);
    queryCount = 0;

    // biome-ignore lint/suspicious/noExplicitAny: mocking PGlite query method needs flexibility
    (db as unknown as { query: (...args: any[]) => Promise<any> }).query = async (
      // biome-ignore lint/suspicious/noExplicitAny: generic query args
      ...args: any[]
    ) => {
      queryCount++;
      // biome-ignore lint/suspicious/noExplicitAny: generic query args
      return originalQuery(...(args as [string, any[]?]));
    };
  });

  afterEach(async () => {
    await db.close();
  });

  it('processes a batch of jobs with a single SELECT for chunks (N+1 regression test)', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-batch-1';
    const jobCount = 50;

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

    // Create file record
    const fileId = 'file-batch-1';
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'batch.ts', '/batch.ts', 100, 'hello world', 'hash1', 10, now]
    );

    // Create chunks and jobs
    for (let i = 0; i < jobCount; i++) {
      const chunkId = `chunk-b-${i}`;
      const jobId = `job-b-${i}`;

      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,10,'text',10,$6,$6)`,
        [chunkId, fileId, i, `content ${i}`, `hash${i}`, now]
      );

      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
            VALUES ($1,'embeddings','embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [jobId, JSON.stringify({ chunkId, embeddingSetId }), now]
      );
    }

    queryCount = 0;

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 60_000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new FakeEmbeddingService(),
      log: () => {},
    });

    await waitFor(async () => {
      const res = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
      );
      return Number(res.rows[0].count) === jobCount;
    }, 30_000);

    await controller.stop();

    // Benchmark history:
    // N+1 implementation: ~111 queries for 50 jobs.
    // Optimized implementation: ~61 queries for 50 jobs.
    // We expect significantly less than 100 queries to prove optimization.
    const EXPECTED_MAX_QUERIES = 100;
    expect(queryCount).toBeLessThan(EXPECTED_MAX_QUERIES);
  });

  it('fails jobs when chunk is missing', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-missing';

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

    // Enqueue a job for a non-existent chunk
    const jobId = 'job-missing';
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
        VALUES ($1,'embeddings','embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
      [jobId, JSON.stringify({ chunkId: 'missing-chunk-id', embeddingSetId }), now]
    );

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 60_000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new FakeEmbeddingService(),
      log: () => {},
    });

    await waitFor(async () => {
      const res = await db.query<{ state: string }>('SELECT state FROM job_queue WHERE id = $1', [
        jobId,
      ]);
      return res.rows[0]?.state === 'failed';
    });

    // Check error message
    const res = await db.query<{ error: string }>('SELECT error FROM job_queue WHERE id = $1', [
      jobId,
    ]);
    expect(res.rows[0].error).toContain('Chunk not found');

    await controller.stop();
  });
});
