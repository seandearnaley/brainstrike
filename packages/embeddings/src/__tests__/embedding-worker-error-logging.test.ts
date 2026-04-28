import { type IDatabase, migrate, wasmLoader } from '@brainstrike/db';
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

const PGLITE_SETUP_TIMEOUT_MS = 90_000;
const EMBEDDING_WORKER_TEST_TIMEOUT_MS = 30_000;

vi.setConfig({
  hookTimeout: PGLITE_SETUP_TIMEOUT_MS,
  testTimeout: EMBEDDING_WORKER_TEST_TIMEOUT_MS,
});

const loggerCalls = {
  error: [] as unknown[][],
  warn: [] as unknown[][],
  info: [] as unknown[][],
  debug: [] as unknown[][],
  trace: [] as unknown[][],
};

vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    createLogger: () => ({
      error: (...args: unknown[]) => loggerCalls.error.push(args),
      warn: (...args: unknown[]) => loggerCalls.warn.push(args),
      info: (...args: unknown[]) => loggerCalls.info.push(args),
      debug: (...args: unknown[]) => loggerCalls.debug.push(args),
      trace: (...args: unknown[]) => loggerCalls.trace.push(args),
    }),
    generateUUID: () => 'test-uuid',
  };
});

vi.mock('../bge-m3-service', () => {
  class MockSimpleEmbeddingService implements EmbeddingService {
    private status: EmbeddingStatus = 'idle';
    private modelId = 'mock-model';
    private dimensions = 768;

    async initializeWithModel(
      modelKeyOrConfig?: string | ModelConfig,
      _onProgress?: (progress: EmbeddingProgress) => void
    ): Promise<void> {
      if (typeof modelKeyOrConfig === 'object' && modelKeyOrConfig) {
        this.dimensions = modelKeyOrConfig.dimensions;
        this.modelId = modelKeyOrConfig.id;
      }
      this.status = 'ready';
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

  return { SimpleEmbeddingService: MockSimpleEmbeddingService };
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

describe('embedding-worker error logging', () => {
  let db: PGlite;

  beforeEach(async () => {
    loggerCalls.error.length = 0;
    loggerCalls.warn.length = 0;
    loggerCalls.info.length = 0;
    loggerCalls.debug.length = 0;
    loggerCalls.trace.length = 0;
    clearModelConfigCache();
    db = await wasmLoader.createPGlite('memory://embedding-worker-error-logging');
    await migrate(db);
  }, PGLITE_SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await db.close();
  });

  it('logs the error message and stack when a batch fails', async () => {
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('job-error','embeddings','embed_chunk', $1, 'queued', $2, 0, 1, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId: 'missing-chunk',
          embeddingSetId: 'set-missing',
          modelKey: 'local::mock-model',
          expectedDimension: 768,
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      leaseMs: 500,
    });

    await waitFor(async () => {
      const res = await db.query<{ state: string }>(
        `SELECT state FROM job_queue WHERE id = 'job-error'`
      );
      return res.rows[0]?.state === 'failed';
    });

    const failureLog = loggerCalls.error.find(
      ([message]) => message === 'handleBatchFailure: Job(s) failed'
    );
    expect(failureLog).toBeDefined();
    const [, meta] = (failureLog ?? []) as [unknown, { error?: unknown; stack?: unknown }];
    expect(typeof meta?.error).toBe('string');
    expect(String(meta?.error)).toMatch(/Chunk not found/i);
    expect(String(meta?.stack)).toContain('Chunk not found');

    await controller.stop();
  });

  it('does not spam local model readiness checks after the model is initialized', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-log-spam';
    const fileId = 'file-log-spam';
    const modelId = 'Xenova/all-MiniLM-L6-v2';
    const modelKey = `local::${modelId}`;

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, modelKey, modelId, 384, 'cosine', now]
    );

    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [fileId, 'log-spam.ts', '/log-spam.ts', 300, 'content', 'hash-log-spam', 30, now]
    );

    for (let i = 0; i < 3; i += 1) {
      const chunkId = `chunk-log-spam-${i}`;
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'text', 10, $7, $7)`,
        [chunkId, fileId, i, `content ${i}`, `hash-log-spam-${i}`, 10, now]
      );

      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [
          `job-log-spam-${i}`,
          JSON.stringify({
            chunkId,
            embeddingSetId,
            modelKey,
            expectedDimension: 384,
          }),
          now,
        ]
      );
    }

    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      claimBatchSize: 1,
      leaseMs: 1000,
      modelKey: modelId,
    });

    await waitFor(async () => {
      const res = await db.query<{ count: number }>(
        `SELECT count(*) as count FROM job_queue WHERE state = 'succeeded'`
      );
      return Number(res.rows[0]?.count) === 3;
    });

    await controller.stop();

    const readinessChecks = loggerCalls.debug.filter(
      ([message]) => message === 'ensureLocalModel check'
    );
    expect(readinessChecks).toHaveLength(0);
  });

  it('reports the configured claim batch size when claim-size resolution fails', async () => {
    const metricLogs: Record<string, unknown>[] = [];
    let resolverCalls = 0;
    const controller = await startEmbeddingWorker({
      db: db as unknown as IDatabase,
      concurrency: 1,
      claimBatchSize: 4,
      leaseMs: 1000,
      metricsIntervalMs: 5000,
      resolveClaimBatchSize: async () => {
        resolverCalls += 1;
        if (resolverCalls === 1) {
          return 2;
        }
        throw new Error('resolver unavailable');
      },
      log: (event, meta) => {
        if (event === 'worker_metrics') {
          metricLogs.push(meta as Record<string, unknown>);
        }
      },
    });

    try {
      await waitFor(async () => resolverCalls >= 2, 10_000);
      await waitFor(
        async () =>
          metricLogs.some(
            (entry) => entry['effectiveClaimBatchSizeError'] === 'resolver unavailable'
          ),
        10_000
      );
    } finally {
      await controller.stop();
    }

    const errorMetric = metricLogs.find(
      (entry) => entry['effectiveClaimBatchSizeError'] === 'resolver unavailable'
    );
    expect(errorMetric).toMatchObject({
      effectiveClaimBatchSize: 4,
      effectiveClaimBatchSizeError: 'resolver unavailable',
    });
    expect(
      loggerCalls.error.some(([message]) => message === 'Critical worker error in processBatch')
    ).toBe(false);
  });
});
