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

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

const loggerCalls = {
  error: [] as unknown[][],
  warn: [] as unknown[][],
  info: [] as unknown[][],
  debug: [] as unknown[][],
};

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => loggerCalls.error.push(args),
    warn: (...args: unknown[]) => loggerCalls.warn.push(args),
    info: (...args: unknown[]) => loggerCalls.info.push(args),
    debug: (...args: unknown[]) => loggerCalls.debug.push(args),
  }),
  generateUUID: () => 'test-uuid',
}));

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
    clearModelConfigCache();
    db = await wasmLoader.createPGlite('memory://embedding-worker-error-logging');
    await migrate(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('logs the error message and stack when a batch fails', async () => {
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('job-error','embeddings','embed_chunk', $1, 'queued', $2, 0, 1, 0, $2, $2)`,
      [JSON.stringify({ chunkId: 'missing-chunk', embeddingSetId: 'set-missing' }), now]
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
});
