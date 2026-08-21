import type { IDatabase } from '@brainstrike/db';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { startEmbeddingWorker } from '../index.js';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types.js';

class SlowEmbeddingService implements EmbeddingService {
  private status: EmbeddingStatus = 'ready';
  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    this.status = 'ready';
    return Promise.resolve();
  }
  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    await new Promise((resolve) => setTimeout(resolve, 600)); // > 500ms heartbeat
    return {
      dimensions: 768,
      embedding: new Array(768).fill(0.1),
      model: 'slow-model',
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
      [
        JSON.stringify({
          chunkId,
          embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000001',
          embeddingSetId,
          expectedDimension: 768,
          modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
          sourceContentHash: 'h',
        }),
        now,
      ]
    );

    // Wrap db to throw on heartbeat lease-extension updates. The worker uses
    // JobQueue.heartbeatBatch, whose SQL is `UPDATE job_queue AS j SET
    // leased_until = $1, ...` — matching the lease-extension SET clause (which
    // only the heartbeat statements lead with) is robust to that `AS j` alias,
    // whereas the old `UPDATE job_queue SET leased_until` literal no longer hit.
    const throwingDb: IDatabase = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SET leased_until = $1')) {
          throw new Error('Simulated heartbeat failure');
        }
        return (db as unknown as IDatabase).query(sql, params);
      },
    };

    const logs: Array<{ msg: string; meta?: unknown }> = [];
    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: throwingDb,
      heartbeatIntervalMs: 5,
      leaseMs: 100,
      log: (msg, meta) => logs.push({ meta, msg }),
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new SlowEmbeddingService(),
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
      if (res.rows[0] && res.rows[0].state === 'succeeded') {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(sawHeartbeatError).toBe(true);

    await controller.stop();
  });
});
