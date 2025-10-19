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
    // Return intentionally wrong dimensions (e.g., 4)
    return { embedding: [0, 0, 0, 0], dimensions: 4, model: 'wrong-dim-model' };
  }
  async generateDocEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  async generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  calculateSimilarity(_e1: number[], _e2: number[]): SimilarityResult {
    return { similarity: 0, distance: 1, method: 'cosine' };
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

describe('embedding-worker: dimension mismatch handling', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://embedding-worker-dim-mismatch');
    await migrate(db);
  });

  it('rejects worker initialization with non-768D model', async () => {
    // Try to start worker with a non-768D model (all-MiniLM-L6-v2 is 384D)
    await expect(
      startEmbeddingWorker({
        db: db as unknown as IDatabase,
        concurrency: 1,
        modelKey: 'all-MiniLM-L6-v2', // 384D model
      })
    ).rejects.toThrow(
      /Model 'all-MiniLM-L6-v2' produces 384D embeddings, but BrainStrike enforces 768D/
    );

    await expect(
      startEmbeddingWorker({
        db: db as unknown as IDatabase,
        concurrency: 1,
        modelKey: 'bge-large-en-v1.5', // 1024D model
      })
    ).rejects.toThrow(
      /Model 'bge-large-en-v1.5' produces 1024D embeddings, but BrainStrike enforces 768D/
    );
  });

  it('accepts worker initialization with 768D model', async () => {
    // jina-code is 768D, should work
    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      modelKey: 'jina-code',
    });
    expect(controller).toBeDefined();
    await controller.stop();

    // bge-base-en-v1.5 is also 768D, should work
    const controller2 = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      modelKey: 'bge-base-en-v1.5',
    });
    expect(controller2).toBeDefined();
    await controller2.stop();
  });

  it('fails the job when custom service returns wrong dimension embeddings', async () => {
    const now = new Date().toISOString();
    const fileId = 'file-d1';
    const chunkId = 'chunk-d1';
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
      [JSON.stringify({ chunkId }), now]
    );

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 1000,
      modelKey: 'jina-code',
      service: new WrongDimService(),
    });

    // Wait for failure
    for (let i = 0; i < 200; i++) {
      const res = await db.query(`SELECT state FROM job_queue WHERE id = 'job-d1'`);
      const rowData = res.rows[0] as { state: string } | undefined;
      if (rowData?.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const row = await db.query(`SELECT state, attempts FROM job_queue WHERE id = 'job-d1'`);
    const rowData = row.rows[0] as { state: string; attempts: number } | undefined;
    expect(rowData?.state).toBe('failed');
    expect(rowData?.attempts).toBeGreaterThanOrEqual(1);

    await controller.stop();
  });

  it('fails the job when payload expectedDimension does not match 768D baseline', async () => {
    const now = new Date().toISOString();
    const fileId = 'file-d2';
    const chunkId = 'chunk-d2';
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
    // Job with expectedDimension=384 in payload
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('job-d2','embeddings','embed_chunk', $1, 'queued', $2, 0, 1, 0, $2, $2)`,
      [JSON.stringify({ chunkId, expectedDimension: 384 }), now]
    );

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 1000,
      modelKey: 'jina-code', // 768D model
    });

    // Wait for failure
    for (let i = 0; i < 200; i++) {
      const res = await db.query(`SELECT state FROM job_queue WHERE id = 'job-d2'`);
      const rowData = res.rows[0] as { state: string } | undefined;
      if (rowData?.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const row = await db.query(`SELECT state, error FROM job_queue WHERE id = 'job-d2'`);
    const rowData = row.rows[0] as { state: string; error: string } | undefined;
    expect(rowData?.state).toBe('failed');
    expect(rowData?.error).toMatch(/Job payload expects 384D embeddings, but worker enforces 768D/);

    await controller.stop();
  });
});
