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
  ModelConfig,
  SimilarityResult,
} from '../types';
import { clearModelConfigCache } from '../worker/embedding-worker';

const { mockState } = vi.hoisted(() => ({
  mockState: {
    initializedWith: [] as Array<{ id: string; dimensions: number }>,
  },
}));

vi.mock('../bge-m3-service', () => {
  class MockSimpleEmbeddingService implements EmbeddingService {
    private status: EmbeddingStatus = 'idle';
    private modelId = 'mock-model';
    private dimensions = 384;

    async initializeWithModel(
      modelKeyOrConfig?: string | ModelConfig,
      _onProgress?: (progress: EmbeddingProgress) => void
    ): Promise<void> {
      const cfg: ModelConfig =
        typeof modelKeyOrConfig === 'object'
          ? modelKeyOrConfig
          : {
              id: typeof modelKeyOrConfig === 'string' ? modelKeyOrConfig : this.modelId,
              name: 'mock-model',
              dimensions: this.dimensions,
              quantized: false,
              description: 'mock',
              tags: ['mock'],
            };

      this.modelId = cfg.id;
      this.dimensions = cfg.dimensions;
      this.status = 'ready';
      mockState.initializedWith.push({ id: cfg.id, dimensions: cfg.dimensions });
    }

    async initialize(config?: Partial<EmbeddingConfig>): Promise<void> {
      if (config?.modelId) {
        this.modelId = config.modelId;
      }
      this.status = 'ready';
    }

    async generateEmbedding(text: string): Promise<EmbeddingResult> {
      return {
        embedding: new Array(this.dimensions).fill(0.1),
        dimensions: this.dimensions,
        model: this.modelId,
        usage: { totalTokens: text.length },
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
      return { modelId: this.modelId };
    }

    async dispose(): Promise<void> {
      this.status = 'disposed';
    }
  }

  return {
    SimpleEmbeddingService: MockSimpleEmbeddingService,
    __simpleServiceMockState: mockState,
  };
});

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25
): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
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

describe('embedding-worker model resolution (HuggingFace IDs)', () => {
  let db: PGlite;

  beforeEach(async () => {
    mockState.initializedWith.length = 0;
    clearModelConfigCache();
    db = await wasmLoader.createPGlite('memory://embedding-worker-model-resolution');
    await migrate(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('initializes using the fallback model ID when no model key is specified', async () => {
    // Worker defaults to FALLBACK_MODEL_CONFIG.id ('Xenova/all-MiniLM-L6-v2')
    // which must exist in the database
    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockState.initializedWith[0]).toEqual({
      id: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
    });

    await controller.stop();
  });

  it('looks up models in the database by HuggingFace ID (no short keys)', async () => {
    const found = await db.query(
      "SELECT id FROM models WHERE id = 'Xenova/all-MiniLM-L6-v2' LIMIT 1"
    );
    expect(found.rows.length).toBe(1);

    const shortKey = await db.query("SELECT id FROM models WHERE id = 'all-MiniLM-L6-v2'");
    expect(shortKey.rows.length).toBe(0);
  });

  it('accepts composite transformers keys and resolves dimensions from DB', async () => {
    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      modelKey: 'transformers::Xenova/all-MiniLM-L6-v2',
    });

    await new Promise((r) => setTimeout(r, 50));
    const lastInit = mockState.initializedWith.at(-1);
    expect(lastInit).toEqual({
      id: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
    });

    await controller.stop();
  });

  it('can start the worker loop without initializing the local model', async () => {
    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      initializeLocalModelOnStart: false,
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockState.initializedWith).toEqual([]);

    await controller.stop();
  });

  it('throws a clear error when the model is missing from the database', async () => {
    await expect(
      startEmbeddingWorker({
        db: db as unknown as IDatabase,
        concurrency: 1,
        modelKey: 'nonexistent-model',
      })
    ).rejects.toThrow(/not found in database/i);
  });

  it('processes jobs that request a different local model via payload', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-switch';
    const fileId = 'file-switch';
    const chunkId = 'chunk-switch';
    const payloadModelKey = 'transformers::Xenova/all-MiniLM-L6-v2';

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, payloadModelKey, 'Xenova/all-MiniLM-L6-v2', 384, 'cosine', now]
    );

    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'switch.ts', '/switch.ts', 42, 'hello switch', 'hash-switch', 11, now]
    );

    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1,$2,0,$3,$4,$5,'text',$6,$7,$7)`,
      [chunkId, fileId, 'hello switch', 'hash-switch', 11, 11, now]
    );

    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('job-switch','embeddings','embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId,
          embeddingSetId,
          modelKey: payloadModelKey,
          expectedDimension: 384,
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 2000,
    });

    await waitFor(async () => {
      const res = await db.query<{ state: string }>(
        `SELECT state FROM job_queue WHERE id = 'job-switch'`
      );
      const state = res.rows[0]?.state;
      return state === 'succeeded';
    }, 10_000);

    const chunkRow = await db.query(
      'SELECT embedding, embedding_set_id, embedding_hash FROM file_chunks WHERE id = $1',
      [chunkId]
    );
    const chunk = chunkRow.rows[0] as
      | { embedding: string | null; embedding_set_id: string | null; embedding_hash: string | null }
      | undefined;

    expect(chunk?.embedding_set_id).toBe(embeddingSetId);
    expect(chunk?.embedding_hash).toBeTruthy();
    // The worker initializes with the default fallback model first,
    // then switches to the job's requested model
    expect(mockState.initializedWith.map((m) => m.id)).toContain('Xenova/all-MiniLM-L6-v2');

    await controller.stop();
  });

  it('initializes the deferred local model when the first local job is claimed', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-lazy';
    const fileId = 'file-lazy';
    const chunkId = 'chunk-lazy';
    const payloadModelKey = 'transformers::Xenova/all-MiniLM-L6-v2';

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, payloadModelKey, 'Xenova/all-MiniLM-L6-v2', 384, 'cosine', now]
    );

    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'lazy.ts', '/lazy.ts', 42, 'hello lazy', 'hash-lazy', 11, now]
    );

    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1,$2,0,$3,$4,$5,'text',$6,$7,$7)`,
      [chunkId, fileId, 'hello lazy', 'hash-lazy', 11, 11, now]
    );

    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('job-lazy','embeddings','embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId,
          embeddingSetId,
          modelKey: payloadModelKey,
          expectedDimension: 384,
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 2000,
      initializeLocalModelOnStart: false,
    });

    expect(mockState.initializedWith).toEqual([]);

    await waitFor(async () => {
      const res = await db.query<{ state: string }>(
        `SELECT state FROM job_queue WHERE id = 'job-lazy'`
      );
      return res.rows[0]?.state === 'succeeded';
    }, 10_000);

    expect(mockState.initializedWith).toEqual([
      {
        id: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 384,
      },
    ]);

    await controller.stop();
  });
});
