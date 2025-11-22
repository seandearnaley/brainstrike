import type { IDatabase } from '@brainstrike/db';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types';

class FlakyEmbeddingService implements EmbeddingService {
  private status: EmbeddingStatus = 'ready';
  private attempts = 0;

  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    this.status = 'ready';
    return Promise.resolve();
  }
  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    this.attempts++;
    if (this.attempts <= 2) {
      throw new Error('Temporary service failure');
    }
    return {
      embedding: new Array(768).fill(0.1),
      dimensions: 768,
      model: 'fake-model',
      usage: { totalTokens: 10 },
    };
  }
  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      results.push(await this.generateEmbedding(text));
    }
    return results;
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
  timeoutMs = 15000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  while (true) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timeout waiting for condition');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('embedding-worker retries and backoff', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://embedding-worker-retry');
    await migrate(db);
  });

  it('retries after a transient failure and succeeds', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-r1';
    const fileId = 'file-r1';
    const chunkId = 'chunk-r1';

    // Create embedding set first (required for jobs)
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, 'local::jina-code', 'jina-code', 768, 'cosine', now]
    );

    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'h.ts', '/h.ts', 100, 'retry me', 'hhash', 10, now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
      VALUES ($1,$2,0,$3,$4,10,'text',10,$5,$5)`,
      [chunkId, fileId, 'retry me', 'hhash', now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
      VALUES ('job-r1','embeddings','embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [JSON.stringify({ chunkId, embeddingSetId }), now]
    );

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 1000,
      modelKey: 'jina-code',
      service: new FlakyEmbeddingService(),
    });

    await waitFor(async () => {
      const res = await db.query(`SELECT state, attempts FROM job_queue WHERE id = 'job-r1'`);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      const state = String(row?.['state'] ?? '');
      const attempts = Number(row?.['attempts'] ?? 0);
      return state === 'succeeded' && attempts >= 2;
    });

    await controller.stop();
  });
});
// Increase timeouts to reduce flakiness under workspace-wide runs
vi.setConfig({ hookTimeout: 30000, testTimeout: 30000 });
