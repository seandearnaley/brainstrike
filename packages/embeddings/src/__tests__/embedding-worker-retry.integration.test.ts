import type { IDatabase } from '@brainstrike/db';
import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingProviderFactory, startEmbeddingWorker } from '../index.js';
import type { IEmbeddingProvider } from '../interfaces/provider.js';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types.js';

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

interface FlakyHostedProviderOptions {
  dimensions: number;
  embeddingValue: number;
  errorMessage: string;
  shouldFail: (attempt: number) => boolean;
}

/**
 * Hosted providers are not served by the injected `service` — the worker routes
 * them through `EmbeddingProviderFactory.createProvider(...).embed()`. This mock
 * plays a transient-then-recovering hosted provider: it returns a non-terminal
 * `api_error` (HTTP 5xx, which `classifyFailure` treats as retryable) for the
 * first N attempts, then succeeds. The shared `attempts` counter persists across
 * requeues because the worker re-invokes the same provider instance each attempt.
 */
function createFlakyHostedProvider(options: FlakyHostedProviderOptions): {
  getAttempts: () => number;
  provider: IEmbeddingProvider;
} {
  let attempts = 0;

  const provider: IEmbeddingProvider = {
    async embed(input) {
      attempts++;
      if (options.shouldFail(attempts)) {
        return {
          error: {
            message: options.errorMessage,
            provider: 'openai',
            statusCode: 503,
            type: 'api_error',
          },
          ok: false,
        };
      }

      const texts = Array.isArray(input.text) ? input.text : [input.text];
      return {
        ok: true,
        value: {
          dimensions: options.dimensions,
          embedding: new Array(options.dimensions).fill(options.embeddingValue),
          embeddings: texts.map(() => new Array(options.dimensions).fill(options.embeddingValue)),
          modelId: input.modelId,
          provider: 'openai',
        },
      };
    },
    getMetadata: () => null,
    getModelInfo: () => null,
    isAvailable: () => Promise.resolve(true),
    validateDimensions: () => ({ ok: true, value: undefined }),
  };

  return { getAttempts: () => attempts, provider };
}

/**
 * Contract note: for LOCAL embedding models the worker deliberately does NOT
 * retry an execution failure back into the model. The first failure is latched
 * (`localModelExecutionFailure`) and every subsequent queue re-claim fail-fasts
 * with `Local embedding execution previously failed for '<model>': <cause>`
 * rather than re-invoking the (potentially broken) local model. The queue still
 * records the retry/backoff attempts, but the job terminates as `failed`.
 *
 * (Transient retry-to-success is a HOSTED-provider behavior; the injected local
 * fake here can only exercise the local fail-fast-latch contract.)
 */
describe('embedding-worker retries and backoff', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  it('latches a transient local execution failure and fails fast on retry', async () => {
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
          embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000001',
          embeddingSetId,
          expectedDimension: 768,
          modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
          sourceContentHash: 'hhash',
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
        // The first attempt fails; a no-latch worker would succeed on attempt 3,
        // but the local latch fail-fasts every retry so the job never succeeds.
        errorMessage: 'Temporary service failure',
        shouldFail: (attempt) => attempt <= 2,
        totalTokens: 10,
      }),
    });

    // Queue exhausts its retries (max_attempts=3) and terminates as failed.
    await waitFor(async () => {
      const res = await db.query(`SELECT state, attempts FROM job_queue WHERE id = 'job-r1'`);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      return String(row?.['state'] ?? '') === 'failed';
    });

    const res = await db.query(`SELECT state, attempts, error FROM job_queue WHERE id = 'job-r1'`);
    const row = res.rows[0] as
      | { state: string; attempts: number; error: string | null }
      | undefined;
    expect(row?.state).toBe('failed');
    // The queue re-claimed the job across its retry budget...
    expect(row?.attempts).toBeGreaterThanOrEqual(2);
    // ...but the latch short-circuited each retry instead of re-invoking the model.
    expect(row?.error).toContain('Local embedding execution previously failed');
    expect(row?.error).toContain('Temporary service failure');

    await controller.stop();
  });

  it('fail-fast latches a termination-style local execution error', async () => {
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
          embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000001',
          embeddingSetId,
          expectedDimension: 768,
          modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
          sourceContentHash: 't-hash',
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
        // Even a single first-attempt failure latches: retries fail-fast rather
        // than re-invoking the model (which would otherwise succeed on attempt 2).
        errorMessage: 'Worker terminated unexpectedly',
        shouldFail: (attempt) => attempt === 1,
        totalTokens: 8,
      }),
    });

    await waitFor(async () => {
      const res = await db.query(`SELECT state, attempts FROM job_queue WHERE id = 'job-r2'`);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      return String(row?.['state'] ?? '') === 'failed';
    });

    const res = await db.query(`SELECT state, attempts, error FROM job_queue WHERE id = 'job-r2'`);
    const row = res.rows[0] as
      | { state: string; attempts: number; error: string | null }
      | undefined;
    expect(row?.state).toBe('failed');
    expect(row?.attempts).toBeGreaterThanOrEqual(2);
    expect(row?.error).toContain('Local embedding execution previously failed');
    expect(row?.error).toContain('Worker terminated unexpectedly');

    await controller.stop();
  });
});

/**
 * The local fail-fast latch above intentionally cannot exercise transient
 * retry-to-success. Hosted providers have no such latch — a non-terminal
 * provider error is requeued by the job queue (`attempts < max_attempts`) and a
 * later attempt can succeed. This asserts that end-to-end through the worker,
 * complementing the queue-layer retry tests in `packages/db`.
 */
describe('embedding-worker hosted-provider retries', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries a transient hosted-provider failure and completes', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-h1';
    const fileId = 'file-h1';
    const chunkId = 'chunk-h1';
    const modelKey = 'openai::text-embedding-3-small';

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, modelKey, 'text-embedding-3-small', 768, 'cosine', now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'hosted.ts', '/hosted.ts', 100, 'embed me', 'hhash', 10, now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
      VALUES ($1,$2,0,$3,$4,10,'text',10,$5,$5)`,
      [chunkId, fileId, 'embed me', 'hhash', now]
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
          modelKey,
          sourceContentHash: 'hhash',
        }),
        now,
      ]
    );

    // Fail transiently on attempts 1 and 2, then succeed on attempt 3 (right at
    // the max_attempts boundary), exercising two requeues through the queue.
    const flaky = createFlakyHostedProvider({
      dimensions: 768,
      embeddingValue: 0.3,
      errorMessage: 'Service temporarily unavailable',
      shouldFail: (attempt) => attempt <= 2,
    });

    const createProviderSpy = vi
      .spyOn(EmbeddingProviderFactory, 'createProvider')
      .mockResolvedValue({ ok: true, value: flaky.provider });

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 1000,
      modelKey,
      // The injected service only bootstraps the startup dimension probe; the
      // hosted job itself is served by the mocked provider factory above.
      service: createFlakyService({
        embeddingValue: 0.3,
        errorMessage: 'unused-by-hosted-path',
        shouldFail: () => false,
        totalTokens: 10,
      }),
    });

    await waitFor(async () => {
      const res = await db.query(`SELECT state, attempts FROM job_queue WHERE id = 'job-h1'`);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      const state = String(row?.['state'] ?? '');
      const attempts = Number(row?.['attempts'] ?? 0);
      return state === 'succeeded' && attempts === 3;
    });

    await controller.stop();

    expect(flaky.getAttempts()).toBe(3);
    expect(createProviderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: 768,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
      })
    );
  });

  async function seedHostedStopJob(db: PGlite): Promise<string> {
    const modelKey = 'openai::text-embedding-3-small';
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ('stop-hosted-set', $1, 'text-embedding-3-small', 768, 'cosine', $2)`,
      [modelKey, now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
       VALUES ('stop-hosted-file', 'hosted.ts', '/hosted.ts', 100, 'embed me', 'stop-hosted-hash', 10, $1, $1)`,
      [now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ('stop-hosted-chunk', 'stop-hosted-file', 0, 'embed me', 'stop-hosted-hash', 10, 'text', 10, $1, $1)`,
      [now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('stop-hosted-job', 'embeddings', 'embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId: 'stop-hosted-chunk',
          embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000001',
          embeddingSetId: 'stop-hosted-set',
          expectedDimension: 768,
          modelKey,
          sourceContentHash: 'stop-hosted-hash',
        }),
        now,
      ]
    );

    return modelKey;
  }

  async function seedLocalStopJob(db: PGlite): Promise<void> {
    const now = new Date().toISOString();
    const modelKey = 'local::jinaai/jina-embeddings-v2-base-code';
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ('stop-local-set', $1, 'jinaai/jina-embeddings-v2-base-code', 768, 'cosine', $2)`,
      [modelKey, now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ('stop-local-chunk', 'stop-hosted-file', 1, 'never initialize', 'stop-local-hash', 10, 'text', 16, $1, $1)`,
      [now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('stop-local-job', 'embeddings', 'embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId: 'stop-local-chunk',
          embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000002',
          embeddingSetId: 'stop-local-set',
          expectedDimension: 768,
          modelKey,
          sourceContentHash: 'stop-local-hash',
        }),
        now,
      ]
    );
  }

  it('does not start a later local model group after hosted inference is stopped', async () => {
    const started = Promise.withResolvers<void>();
    const modelKey = await seedHostedStopJob(db);
    await seedLocalStopJob(db);
    const fatalError = vi.fn();
    const provider: IEmbeddingProvider = {
      async embed(input) {
        started.resolve();
        try {
          await new Promise<void>((_resolve, reject) => {
            input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
              once: true,
            });
          });
        } catch (error) {
          return {
            error: {
              originalError: error instanceof Error ? error : new Error(String(error)),
              provider: 'openai',
              type: 'network_error',
            },
            ok: false,
          };
        }
        throw new Error('Stopped hosted inference cannot succeed.');
      },
      getMetadata: () => null,
      getModelInfo: () => null,
      isAvailable: () => Promise.resolve(true),
      validateDimensions: () => ({ ok: true, value: undefined }),
    };
    vi.spyOn(EmbeddingProviderFactory, 'createProvider').mockResolvedValue({
      ok: true,
      value: provider,
    });
    const controller = await startEmbeddingWorker({
      claimBatchSize: 2,
      concurrency: 1,
      db,
      leaseMs: 10_000,
      maxInFlightJobs: 2,
      modelKey,
      onFatalError: fatalError,
      service: createFlakyService({
        embeddingValue: 0.3,
        errorMessage: 'unused-by-hosted-path',
        shouldFail: () => false,
        totalTokens: 10,
      }),
      stopOnFatalLocalError: true,
    });
    try {
      await started.promise;
      const beforeStop = await db.query<{ attempts: number; state: string }>(
        `SELECT state, attempts FROM job_queue WHERE id = 'stop-local-job'`
      );
      expect(beforeStop.rows[0]).toMatchObject({ attempts: 1, state: 'running' });

      await controller.stop();

      const afterStop = await db.query<{ attempts: number; error: string | null; state: string }>(
        `SELECT state, attempts, error FROM job_queue WHERE id = 'stop-local-job'`
      );
      expect(afterStop.rows[0]).toMatchObject({ attempts: 1, error: null, state: 'running' });
      expect(fatalError).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it('aborts an active hosted request on Stop without consuming another attempt', async () => {
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let abortObserved = false;
    const modelKey = await seedHostedStopJob(db);

    const provider: IEmbeddingProvider = {
      async embed(input) {
        started.resolve();
        try {
          await new Promise<void>((resolve, reject) => {
            input.signal?.addEventListener(
              'abort',
              () => {
                abortObserved = true;
                reject(input.signal?.reason);
              },
              { once: true }
            );
            void released.promise.then(resolve);
          });
        } catch (error) {
          return {
            error: {
              originalError: error instanceof Error ? error : new Error(String(error)),
              provider: 'openai',
              type: 'network_error',
            },
            ok: false,
          };
        }
        throw new Error('A stopped request cannot complete.');
      },
      getMetadata: () => null,
      getModelInfo: () => null,
      isAvailable: () => Promise.resolve(true),
      validateDimensions: () => ({ ok: true, value: undefined }),
    };
    vi.spyOn(EmbeddingProviderFactory, 'createProvider').mockResolvedValue({
      ok: true,
      value: provider,
    });
    const controller = await startEmbeddingWorker({
      db,
      leaseMs: 10_000,
      modelKey,
      service: createFlakyService({
        embeddingValue: 0.3,
        errorMessage: 'unused-by-hosted-path',
        shouldFail: () => false,
        totalTokens: 10,
      }),
    });
    await started.promise;
    const stopping = controller.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = await Promise.race([
        stopping.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      expect(stopped).toBe(true);
      expect(abortObserved).toBe(true);
      const job = await db.query<{ attempts: number; state: string }>(
        `SELECT state, attempts FROM job_queue WHERE id = 'stop-hosted-job'`
      );
      expect(job.rows[0]).toMatchObject({ attempts: 1, state: 'running' });
    } finally {
      clearTimeout(timer);
      released.resolve();
      await stopping;
    }
  });

  it('records an independent hosted failure racing Stop', async () => {
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const modelKey = await seedHostedStopJob(db);
    const provider: IEmbeddingProvider = {
      async embed(input) {
        started.resolve();
        input.signal?.addEventListener('abort', () => released.resolve(), { once: true });
        await released.promise;
        return {
          error: {
            originalError: new Error('Independent provider failure'),
            provider: 'openai',
            type: 'network_error',
          },
          ok: false,
        };
      },
      getMetadata: () => null,
      getModelInfo: () => null,
      isAvailable: () => Promise.resolve(true),
      validateDimensions: () => ({ ok: true, value: undefined }),
    };
    vi.spyOn(EmbeddingProviderFactory, 'createProvider').mockResolvedValue({
      ok: true,
      value: provider,
    });
    const controller = await startEmbeddingWorker({
      db,
      leaseMs: 10_000,
      modelKey,
      service: createFlakyService({
        embeddingValue: 0.3,
        errorMessage: 'unused-by-hosted-path',
        shouldFail: () => false,
        totalTokens: 10,
      }),
    });
    await started.promise;
    const stopping = controller.stop();
    try {
      await stopping;
      const job = await db.query<{ attempts: number; error: string; state: string }>(
        `SELECT state, attempts, error FROM job_queue WHERE id = 'stop-hosted-job'`
      );
      expect(job.rows[0]).toMatchObject({
        attempts: 1,
        error: expect.stringContaining('Independent provider failure'),
        state: 'queued',
      });
    } finally {
      released.resolve();
      await stopping;
    }
  });
});
