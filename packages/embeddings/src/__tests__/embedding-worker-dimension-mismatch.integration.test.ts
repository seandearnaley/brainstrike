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
    process.env['DISABLE_VECTOR_EXTENSION'] = 'true';
    db = await wasmLoader.createPGlite('memory://embedding-worker-dim-mismatch');
    await migrate(db);
  });

  it('fails the job when embedding dimensions do not match model config', async () => {
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
});
