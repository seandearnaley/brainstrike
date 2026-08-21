import type { IDatabase } from '@brainstrike/db';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index.js';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  ModelConfig,
  SimilarityResult,
} from '../types.js';
import { clearModelConfigCache } from '../worker/embedding-worker.js';

const { mockState } = vi.hoisted(() => ({
  mockState: {
    failureMessage: null as string | null,
    failureModelId: null as string | null,
    initializeAttempts: [] as string[],
    initializedWith: [] as Array<{ id: string; dimensions: number }>,
    streamAttempts: [] as string[],
    streamFailureMessage: null as string | null,
    streamFailureModelId: null as string | null,
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
              description: 'mock',
              dimensions: this.dimensions,
              id: typeof modelKeyOrConfig === 'string' ? modelKeyOrConfig : this.modelId,
              name: 'mock-model',
              quantized: false,
              tags: ['mock'],
            };

      this.modelId = cfg.id;
      this.dimensions = cfg.dimensions;
      mockState.initializeAttempts.push(cfg.id);
      if (mockState.failureModelId === cfg.id) {
        throw new Error(mockState.failureMessage ?? `Failed to initialize ${cfg.id}`);
      }
      this.status = 'ready';
      mockState.initializedWith.push({ dimensions: cfg.dimensions, id: cfg.id });
    }

    async initialize(config?: Partial<EmbeddingConfig>): Promise<void> {
      if (config?.modelId) {
        this.modelId = config.modelId;
      }
      this.status = 'ready';
    }

    async generateEmbedding(text: string): Promise<EmbeddingResult> {
      return {
        dimensions: this.dimensions,
        embedding: new Array(this.dimensions).fill(0.1),
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
      mockState.streamAttempts.push(this.modelId);
      if (mockState.streamFailureModelId === this.modelId) {
        throw new Error(
          mockState.streamFailureMessage ?? `Failed to stream embeddings for ${this.modelId}`
        );
      }
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
      return { modelId: this.modelId };
    }

    async dispose(): Promise<void> {
      this.status = 'disposed';
    }
  }

  return {
    __simpleServiceMockState: mockState,
    SimpleEmbeddingService: MockSimpleEmbeddingService,
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
    mockState.failureMessage = null;
    mockState.failureModelId = null;
    mockState.initializedWith.length = 0;
    mockState.initializeAttempts.length = 0;
    mockState.streamFailureMessage = null;
    mockState.streamFailureModelId = null;
    mockState.streamAttempts.length = 0;
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
      concurrency: 1,
      db: db as unknown as IDatabase,
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockState.initializedWith[0]).toEqual({
      dimensions: 384,
      id: 'Xenova/all-MiniLM-L6-v2',
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
      concurrency: 1,
      db: db as unknown as IDatabase,
      modelKey: 'transformers::Xenova/all-MiniLM-L6-v2',
    });

    await new Promise((r) => setTimeout(r, 50));
    const lastInit = mockState.initializedWith.at(-1);
    expect(lastInit).toEqual({
      dimensions: 384,
      id: 'Xenova/all-MiniLM-L6-v2',
    });

    await controller.stop();
  });

  it('can start the worker loop without initializing the local model', async () => {
    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      initializeLocalModelOnStart: false,
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockState.initializedWith).toEqual([]);

    await controller.stop();
  });

  it('throws a clear error when the model is missing from the database', async () => {
    await expect(
      startEmbeddingWorker({
        concurrency: 1,
        db: db as unknown as IDatabase,
        modelKey: 'nonexistent-model',
      })
    ).rejects.toThrow(/not found in database/i);
  });

  it('latches local model initialization failures and fails later jobs without retrying init', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-init-failure';
    const payloadModelKey = 'transformers::Xenova/all-MiniLM-L6-v2';
    mockState.failureModelId = 'Xenova/all-MiniLM-L6-v2';
    mockState.failureMessage = 'WebGPU initialization failed';

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, payloadModelKey, 'Xenova/all-MiniLM-L6-v2', 384, 'cosine', now]
    );

    for (const suffix of ['a', 'b']) {
      const fileId = `file-init-failure-${suffix}`;
      const chunkId = `chunk-init-failure-${suffix}`;
      const jobId = `job-init-failure-${suffix}`;

      await db.query(
        `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [fileId, `${suffix}.ts`, `/${suffix}.ts`, 42, `hello ${suffix}`, `hash-${suffix}`, 11, now]
      );

      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
         VALUES ($1,$2,0,$3,$4,$5,'text',$6,$7,$7)`,
        [chunkId, fileId, `hello ${suffix}`, `hash-${suffix}`, 11, 11, now]
      );

      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ($1,'embeddings','embed_chunk',$2,'queued',$3,0,1,0,$3,$3)`,
        [
          jobId,
          JSON.stringify({
            chunkId,
            embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000001',
            embeddingSetId,
            expectedDimension: 384,
            modelKey: payloadModelKey,
            sourceContentHash: `hash-${suffix}`,
          }),
          now,
        ]
      );
    }

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 1,
      db: db as unknown as IDatabase,
      initializeLocalModelOnStart: false,
      leaseMs: 2000,
    });

    await waitFor(async () => {
      const res = await db.query<{ failed_count: string }>(
        `SELECT COUNT(*)::text AS failed_count
           FROM job_queue
          WHERE id IN ('job-init-failure-a', 'job-init-failure-b')
            AND state = 'failed'`
      );
      return Number(res.rows[0]?.failed_count ?? 0) === 2;
    });

    expect(mockState.initializeAttempts).toEqual(['Xenova/all-MiniLM-L6-v2']);

    await controller.stop();
  });

  it('latches local embedding stream failures and fails later jobs without retrying execution', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-stream-failure';
    const payloadModelKey = 'transformers::Xenova/all-MiniLM-L6-v2';
    mockState.streamFailureModelId = 'Xenova/all-MiniLM-L6-v2';
    mockState.streamFailureMessage = 'WebGPU execution failed';

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, payloadModelKey, 'Xenova/all-MiniLM-L6-v2', 384, 'cosine', now]
    );

    for (const suffix of ['a', 'b']) {
      const fileId = `file-stream-failure-${suffix}`;
      const chunkId = `chunk-stream-failure-${suffix}`;
      const jobId = `job-stream-failure-${suffix}`;

      await db.query(
        `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [
          fileId,
          `${suffix}.ts`,
          `/${suffix}.ts`,
          42,
          `hello ${suffix}`,
          `stream-hash-${suffix}`,
          11,
          now,
        ]
      );

      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
         VALUES ($1,$2,0,$3,$4,$5,'text',$6,$7,$7)`,
        [chunkId, fileId, `hello ${suffix}`, `stream-hash-${suffix}`, 11, 11, now]
      );

      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ($1,'embeddings','embed_chunk',$2,'queued',$3,0,1,0,$3,$3)`,
        [
          jobId,
          JSON.stringify({
            chunkId,
            embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000001',
            embeddingSetId,
            expectedDimension: 384,
            modelKey: payloadModelKey,
            sourceContentHash: `stream-hash-${suffix}`,
          }),
          now,
        ]
      );
    }

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 1,
      db: db as unknown as IDatabase,
      initializeLocalModelOnStart: false,
      leaseMs: 2000,
    });

    await waitFor(async () => {
      const res = await db.query<{ failed_count: string }>(
        `SELECT COUNT(*)::text AS failed_count
           FROM job_queue
          WHERE id IN ('job-stream-failure-a', 'job-stream-failure-b')
            AND state = 'failed'`
      );
      return Number(res.rows[0]?.failed_count ?? 0) === 2;
    });

    expect(mockState.streamAttempts).toEqual(['Xenova/all-MiniLM-L6-v2']);

    await controller.stop();
  });

  it('stops claiming new jobs after a fatal local stream failure when configured', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-fatal-stream-failure';
    const payloadModelKey = 'transformers::Xenova/all-MiniLM-L6-v2';
    const fatalErrors: string[] = [];
    mockState.streamFailureModelId = 'Xenova/all-MiniLM-L6-v2';
    mockState.streamFailureMessage = 'WebGPU execution failed';

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, payloadModelKey, 'Xenova/all-MiniLM-L6-v2', 384, 'cosine', now]
    );

    for (const suffix of ['a', 'b']) {
      const fileId = `file-fatal-stream-failure-${suffix}`;
      const chunkId = `chunk-fatal-stream-failure-${suffix}`;
      const jobId = `job-fatal-stream-failure-${suffix}`;

      await db.query(
        `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [
          fileId,
          `${suffix}.ts`,
          `/${suffix}.ts`,
          42,
          `hello ${suffix}`,
          `fatal-stream-hash-${suffix}`,
          11,
          now,
        ]
      );

      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
         VALUES ($1,$2,0,$3,$4,$5,'text',$6,$7,$7)`,
        [chunkId, fileId, `hello ${suffix}`, `fatal-stream-hash-${suffix}`, 11, 11, now]
      );

      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ($1,'embeddings','embed_chunk',$2,'queued',$3,0,1,0,$3,$3)`,
        [
          jobId,
          JSON.stringify({
            chunkId,
            embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000001',
            embeddingSetId,
            expectedDimension: 384,
            modelKey: payloadModelKey,
            sourceContentHash: `fatal-stream-hash-${suffix}`,
          }),
          now,
        ]
      );
    }

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 1,
      db: db as unknown as IDatabase,
      initializeLocalModelOnStart: false,
      leaseMs: 2000,
      onFatalError: (error) => {
        fatalErrors.push(error.message);
      },
      stopOnFatalLocalError: true,
    });

    await waitFor(async () => {
      const res = await db.query<{ state: string }>(
        `SELECT state FROM job_queue WHERE id = 'job-fatal-stream-failure-a'`
      );
      return res.rows[0]?.state === 'failed';
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const followUpJob = await db.query<{ state: string }>(
      `SELECT state FROM job_queue WHERE id = 'job-fatal-stream-failure-b'`
    );

    expect(followUpJob.rows[0]?.state).toBe('queued');
    expect(mockState.streamAttempts).toEqual(['Xenova/all-MiniLM-L6-v2']);
    expect(fatalErrors).toEqual([
      "Local embedding execution failed for 'transformers::Xenova/all-MiniLM-L6-v2': WebGPU execution failed",
    ]);

    await controller.stop();
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
          embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000001',
          embeddingSetId,
          expectedDimension: 384,
          modelKey: payloadModelKey,
          sourceContentHash: 'hash-switch',
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
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
          embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000001',
          embeddingSetId,
          expectedDimension: 384,
          modelKey: payloadModelKey,
          sourceContentHash: 'hash-lazy',
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      initializeLocalModelOnStart: false,
      leaseMs: 2000,
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
        dimensions: 384,
        id: 'Xenova/all-MiniLM-L6-v2',
      },
    ]);

    await controller.stop();
  });
});
