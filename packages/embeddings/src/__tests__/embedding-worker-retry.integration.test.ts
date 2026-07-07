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

// Increase timeouts to reduce flakiness under workspace-wide runs
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

interface FlakyServiceOptions {
  embeddingValue: number;
  errorMessage: string;
  shouldFail: (attempt: number) => boolean;
  totalTokens: number;
}

function createFlakyService(options: FlakyServiceOptions): EmbeddingService {
  let status: EmbeddingStatus = 'ready';
  // Intentionally shared across embedding entry points so retry behavior stays
  // consistent regardless of which service method the worker calls.
  let attempts = 0;

  const generateEmbedding = async (_text: string): Promise<EmbeddingResult> => {
    attempts++;
    if (options.shouldFail(attempts)) {
      throw new Error(options.errorMessage);
    }

    return {
      dimensions: 768,
      embedding: new Array(768).fill(options.embeddingValue),
      model: 'fake-model',
      usage: { totalTokens: options.totalTokens },
    };
  };

  return {
    calculateSimilarity(_e1: number[], _e2: number[]): SimilarityResult {
      return { distance: 0, method: 'cosine', similarity: 1 };
    },
    async dispose(): Promise<void> {
      status = 'disposed';
    },
    async generateDocEmbedding(text: string): Promise<EmbeddingResult> {
      return generateEmbedding(text);
    },
    generateEmbedding,
    async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
      const results: EmbeddingResult[] = [];
      for (const text of texts) {
        results.push(await generateEmbedding(text));
      }
      return results;
    },
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
    },
    async generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
      return generateEmbedding(text);
    },
    getConfig(): EmbeddingConfig {
      return { modelId: 'fake-model' };
    },
    getStatus(): EmbeddingStatus {
      return status;
    },
    initialize(
      _config?: Partial<EmbeddingConfig>,
      _onProgress?: (progress: EmbeddingProgress) => void
    ): Promise<void> {
      status = 'ready';
      return Promise.resolve();
    },
  };
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 15_000,
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
      service: createFlakyService({
        embeddingValue: 0.1,
        errorMessage: 'Temporary service failure',
        shouldFail: (attempt) => attempt <= 2,
        totalTokens: 10,
      }),
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

  it('retries when the worker task fails with a termination-style error', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-r2';
    const fileId = 'file-r2';
    const chunkId = 'chunk-r2';

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
      [fileId, 'worker.ts', '/worker.ts', 100, 'retry termination', 't-hash', 10, now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
      VALUES ($1,$2,0,$3,$4,10,'text',10,$5,$5)`,
      [chunkId, fileId, 'retry termination', 't-hash', now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
      VALUES ('job-r2','embeddings','embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
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
      service: createFlakyService({
        embeddingValue: 0.2,
        errorMessage: 'Worker terminated unexpectedly',
        shouldFail: (attempt) => attempt === 1,
        totalTokens: 8,
      }),
    });

    await waitFor(async () => {
      const res = await db.query(`SELECT state, attempts FROM job_queue WHERE id = 'job-r2'`);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      const state = String(row?.['state'] ?? '');
      const attempts = Number(row?.['attempts'] ?? 0);
      return state === 'succeeded' && attempts === 2;
    });

    await controller.stop();
  });
});
