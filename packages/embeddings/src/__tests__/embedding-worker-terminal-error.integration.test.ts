import { type IDatabase, type Job, JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types.js';
import { startEmbeddingWorker } from '../worker/embedding-worker.js';

// Mock isNodejsMainProcess to allow local model execution in test
vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    isNodejsMainProcess: () => false,
  };
});

class TerminalErrorService implements EmbeddingService {
  private callCount = 0;

  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    return Promise.resolve();
  }
  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    this.callCount++;
    // Allow first call to succeed for ensureModelDimension check
    if (this.callCount === 1) {
      return {
        dimensions: 1536,
        embedding: new Array(1536).fill(0),
        model: 'test-model',
        usage: { totalTokens: 10 },
      };
    }
    throw new Error('API request failed with status 400');
  }
  async generateEmbeddings(_texts: string[]): Promise<EmbeddingResult[]> {
    this.callCount++;
    throw new Error('API request failed with status 400');
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
  calculateSimilarity(_embedding1: number[], _embedding2: number[]): SimilarityResult {
    return { distance: 0, method: 'cosine', similarity: 0 };
  }
  getStatus(): EmbeddingStatus {
    return 'ready';
  }
  getConfig(): EmbeddingConfig {
    return { modelId: 'test-model' };
  }
  async dispose(): Promise<void> {}
}

describe('Embedding Worker - Terminal Errors', () => {
  let db: IDatabase;
  let jq: JobQueue;
  let worker: { stop: () => Promise<void> };

  beforeEach(async () => {
    const pglite = await wasmLoader.createPGlite('memory://terminal-error-test');
    await migrate(pglite as unknown as Parameters<typeof migrate>[0]);
    db = pglite as unknown as IDatabase;
    jq = new JobQueue(db);
    // Clean up
    await db.query('DELETE FROM job_queue');
    await db.query('DELETE FROM file_chunks');
  });

  afterEach(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  it('should immediately fail jobs with terminal errors', async () => {
    // 1. Create a file record and chunk
    const fileId = crypto.randomUUID();
    await db.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at, content_hash)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), $5)`,
      [fileId, 'test.ts', '/tmp/test.ts', 100, 'hash123']
    );

    const chunkId = crypto.randomUUID();
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [chunkId, fileId, 0, 'test content', 'hash123', 10, 'text', 100]
    );

    // 2. Create embedding set
    const setId = crypto.randomUUID();
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [setId, 'local::test-model', 'test-model', 1536, 'cosine']
    );

    // 3. Enqueue a job
    await jq.enqueue({
      jobType: 'embed_chunk',
      payload: {
        chunkId,
        embeddingInputHash: '0000000000000000000000000000000000000000000000000000000000000001',
        embeddingSetId: setId,
        expectedDimension: 1536,
        modelKey: 'local::test-model',
        sourceContentHash: 'hash123',
      },
      queue: 'embeddings',
    });

    // 4. Start worker with terminal error service
    worker = await startEmbeddingWorker({
      concurrency: 1,
      db,
      enable: true,
      // Align the worker's active model with the job payload so there is no
      // model-switch reinit (whose DB lookup for the uncatalogued 'test-model'
      // would otherwise throw and mask the injected terminal 'status 400').
      modelKey: 'local::test-model',
      service: new TerminalErrorService(),
    });

    // 4. Wait for processing
    await new Promise((r) => setTimeout(r, 1000));

    // 5. Verify job is failed immediately
    const jobs = await db.query<Job>('SELECT * FROM job_queue');
    expect(jobs.rows.length).toBe(1);
    const job = jobs.rows[0];

    if (!job) {
      throw new Error('Job not found');
    }
    expect(job.state).toBe('failed');
    expect(job.error).toContain('status 400');
    // Should be 1 attempt (the one that failed terminally)
    expect(job.attempts).toBe(1);
  });
});
