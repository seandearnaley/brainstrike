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

class SlowEmbeddingService implements EmbeddingService {
  private status: EmbeddingStatus = 'ready';
  private dims = 768;
  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    this.status = 'ready';
    return Promise.resolve();
  }
  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    // Delay a bit to allow heartbeat to fire
    await new Promise((r) => setTimeout(r, 30));
    const embedding = Array.from({ length: this.dims }, (_, i) => ((i % 7) - 3) / 50);
    return { embedding, dimensions: this.dims, model: 'slow-model' };
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
    return { modelId: 'slow-model' } as unknown as EmbeddingConfig;
  }
  async dispose(): Promise<void> {
    this.status = 'disposed';
  }
}

describe('embedding-worker: heartbeat error logging', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://embedding-worker-hb');
    await migrate(db);
  });

  it('logs heartbeat errors without crashing the worker', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-h1';
    const fileId = 'file-h1';
    const chunkId = 'chunk-h1';

    // Create embedding set first (required for jobs)
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, 'local::jina-code', 'jina-code', 768, 'cosine', now]
    );

    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'h.ts', '/h.ts', 10, 'heartbeat', 'h', 5, now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1,$2,0,$3,$4,5,'text',5,$5,$5)`,
      [chunkId, fileId, 'heartbeat', 'h', now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('job-h1','embeddings','embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [JSON.stringify({ chunkId, embeddingSetId }), now]
    );

    // Wrap db to throw on heartbeat updates
    const throwingDb: IDatabase = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('UPDATE job_queue SET leased_until')) {
          throw new Error('Simulated heartbeat failure');
        }
        return (db as unknown as IDatabase).query(sql, params);
      },
    };

    const logs: Array<{ msg: string; meta?: unknown }> = [];
    const controller = await startEmbeddingWorker({
      db: throwingDb,
      concurrency: 1,
      leaseMs: 100,
      heartbeatIntervalMs: 5,
      modelKey: 'jina-code',
      service: new SlowEmbeddingService(),
      log: (msg, meta) => logs.push({ msg, meta }),
    });

    // Wait until job completes and ensure heartbeat error was logged at least once
    let sawHeartbeatError = false;
    for (let i = 0; i < 200; i++) {
      const res = (await db.query(`SELECT state FROM job_queue WHERE id = 'job-h1'`)) as {
        rows: Array<{ state: string }>;
      };
      if (logs.some((l) => l.msg === 'worker_heartbeat_error')) {
        sawHeartbeatError = true;
      }
      if (res.rows[0] && res.rows[0].state === 'succeeded') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(sawHeartbeatError).toBe(true);

    await controller.stop();
  });
});
