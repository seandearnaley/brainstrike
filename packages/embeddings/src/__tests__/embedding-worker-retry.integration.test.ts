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
  private dims = 768;
  private fails = 1;
  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    this.status = 'ready';
    return Promise.resolve();
  }
  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    if (this.fails > 0) {
      this.fails -= 1;
      throw new Error('transient-failure');
    }
    const embedding = Array.from({ length: this.dims }, (_, i) => ((i % 7) - 3) / 10);
    return { embedding, dimensions: this.dims, model: 'fake-model' };
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
    process.env.DISABLE_VECTOR_EXTENSION = 'true';
    db = await wasmLoader.createPGlite('memory://embedding-worker-retry');
    await migrate(db);
  });

  it('retries after a transient failure and succeeds', async () => {
    const now = new Date().toISOString();
    const fileId = 'file-r1';
    const chunkId = 'chunk-r1';
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
      [JSON.stringify({ chunkId }), now]
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
      const state = String(res.rows[0]?.['state'] ?? '');
      const attempts = Number(res.rows[0]?.['attempts'] ?? 0);
      return state === 'succeeded' && attempts >= 2;
    });

    await controller.stop();
  });
});
// Increase timeouts to reduce flakiness under workspace-wide runs
vi.setConfig({ hookTimeout: 30000, testTimeout: 30000 });
