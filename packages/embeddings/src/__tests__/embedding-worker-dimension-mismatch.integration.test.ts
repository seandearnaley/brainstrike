import type { IDatabase } from '@brainstrike/db';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { startEmbeddingWorker } from '../index';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types';

class WrongDimService implements EmbeddingService {
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
      dimensions: 10,
      embedding: new Array(10).fill(0.1), // Wrong dimension (10 vs 768)
      model: 'wrong-dim-model',
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
    return { distance: 1, method: 'cosine', similarity: 0 };
  }
  getStatus(): EmbeddingStatus {
    return this.status;
  }
  getConfig(): EmbeddingConfig {
    return { modelId: 'wrong-dim-model' } as unknown as EmbeddingConfig;
  }
  async dispose(): Promise<void> {
    this.status = 'disposed';
  }
}

/**
 * Neutral 768-dim fake used by tests whose intent is worker/queue plumbing
 * (startup, dimension-guard gating) rather than real inference. Injecting it
 * short-circuits the real TransformersBackend init that would otherwise throw
 * `WebGPU Acceleration Unavailable` in headless Node.
 */
class NeutralEmbeddingService implements EmbeddingService {
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

describe('embedding-worker: dimension mismatch handling', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://embedding-worker-dim-mismatch');
    await migrate(db);
  });

  it('initializes worker with non-default embedding dimensions', async () => {
    const controller384 = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      modelKey: 'Xenova/all-MiniLM-L6-v2', // 384D model
      service: new NeutralEmbeddingService(),
    });
    expect(controller384).toBeDefined();
    await controller384.stop();

    const controller1024 = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      modelKey: 'Xenova/bge-large-en-v1.5', // 1024D model (catalog id)
      service: new NeutralEmbeddingService(),
    });
    expect(controller1024).toBeDefined();
    await controller1024.stop();
  });

  it('initializes worker with 768D models', async () => {
    // jina-code is 768D, should work
    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new NeutralEmbeddingService(),
    });
    expect(controller).toBeDefined();
    await controller.stop();

    // bge-base-en-v1.5 is also 768D, should work
    const controller2 = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      modelKey: 'Xenova/bge-base-en-v1.5',
      service: new NeutralEmbeddingService(),
    });
    expect(controller2).toBeDefined();
    await controller2.stop();
  });

  it('fails the job when custom service returns wrong dimension embeddings', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-d1';
    const fileId = 'file-d1';
    const chunkId = 'chunk-d1';

    // Create embedding set first (required for jobs)
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        embeddingSetId,
        'local::jinaai/jina-embeddings-v2-base-code',
        'jinaai/jina-embeddings-v2-base-code',
        768,
        'cosine',
        now,
      ]
    );

    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'd.ts', '/d.ts', 10, 'dim test', 'h1', 5, now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1,$2,0,$3,$4,5,'text',5,$5,$5)`,
      [chunkId, fileId, 'dim test', 'h1', now]
    );
    // Set max_attempts = 1 so it becomes failed instead of re-queued
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('job-d1','embeddings','embed_chunk', $1, 'queued', $2, 0, 1, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId,
          embeddingSetId,
          expectedDimension: 768,
          modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 1000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new WrongDimService(),
    });

    // Wait for failure
    for (let i = 0; i < 200; i++) {
      const res = await db.query(`SELECT state FROM job_queue WHERE id = 'job-d1'`);
      const rowData = res.rows[0] as { state: string } | undefined;
      if (rowData?.state === 'failed') {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const row = await db.query(`SELECT state, attempts FROM job_queue WHERE id = 'job-d1'`);
    const rowData = row.rows[0] as { state: string; attempts: number } | undefined;
    expect(rowData?.state).toBe('failed');
    expect(rowData?.attempts).toBeGreaterThanOrEqual(1);

    await controller.stop();
  });

  it('fails jobs when payload expectedDimension does not match the target set dimension', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-d2';
    const fileId = 'file-d2';
    const chunkId = 'chunk-d2';

    // Create embedding set first (required for jobs)
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        embeddingSetId,
        'local::jinaai/jina-embeddings-v2-base-code',
        'jinaai/jina-embeddings-v2-base-code',
        768,
        'cosine',
        now,
      ]
    );

    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'd2.ts', '/d2.ts', 10, 'dim test 2', 'h2', 5, now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1,$2,0,$3,$4,5,'text',5,$5,$5)`,
      [chunkId, fileId, 'dim test 2', 'h2', now]
    );
    // Job intentionally carries stale dimension metadata and must fail fast.
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('job-d2','embeddings','embed_chunk', $1, 'queued', $2, 0, 1, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId,
          embeddingSetId,
          expectedDimension: 384,
          modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 1000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code', // 768D model
      // Guard under test (payload=384 vs set=768) fires on job claim before any
      // embedding runs; the neutral fake only prevents a real-backend startup.
      service: new NeutralEmbeddingService(),
    });

    // Wait for job failure
    for (let i = 0; i < 200; i++) {
      const res = await db.query(`SELECT state FROM job_queue WHERE id = 'job-d2'`);
      const rowData = res.rows[0] as { state: string } | undefined;
      if (rowData?.state === 'failed') {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const row = await db.query(`SELECT state, attempts, error FROM job_queue WHERE id = 'job-d2'`);
    const rowData = row.rows[0] as
      | { state: string; attempts: number; error: string | null }
      | undefined;
    expect(rowData?.state).toBe('failed');
    expect(rowData?.attempts).toBeGreaterThanOrEqual(1);
    expect(rowData?.error).toContain('payload=384, set=768');

    await controller.stop();
  });
});
