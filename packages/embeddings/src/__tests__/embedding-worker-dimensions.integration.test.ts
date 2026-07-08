import { type IDatabase, JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types';
import { type EmbeddingWorkerController, startEmbeddingWorker } from '../worker/embedding-worker';

/**
 * Mock EmbeddingService that returns 3072-dimensional embeddings
 * (simulating OpenAI text-embedding-3-large)
 */
class LargeDimensionService implements EmbeddingService {
  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    return Promise.resolve();
  }

  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    return {
      dimensions: 3072,
      embedding: new Array(3072).fill(0.1),
      model: 'text-embedding-3-large',
      usage: { totalTokens: 10 },
    };
  }

  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    return texts.map(() => ({
      dimensions: 3072,
      embedding: new Array(3072).fill(0.1),
      model: 'text-embedding-3-large',
      usage: { totalTokens: 10 },
    }));
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
    return { distance: 0.05, method: 'cosine', similarity: 0.95 };
  }

  getStatus(): EmbeddingStatus {
    return 'ready';
  }

  getConfig(): EmbeddingConfig {
    return { modelId: 'text-embedding-3-large' };
  }

  async dispose(): Promise<void> {}
}

// Mock isNodejsMainProcess to allow local model execution in test
vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    isNodejsMainProcess: () => false,
  };
});

describe('Embedding Worker Dimensions', () => {
  let db: IDatabase;
  let jq: JobQueue;
  let worker: EmbeddingWorkerController;

  beforeEach(async () => {
    const pglite = await wasmLoader.createPGlite('memory://dim-test');
    await migrate(pglite as unknown as Parameters<typeof migrate>[0]);
    db = pglite as unknown as IDatabase;
    jq = new JobQueue(db);
    // Clean up any existing data
    await db.query('DELETE FROM job_queue');
    await db.query('DELETE FROM file_chunks');
  });

  afterEach(async () => {
    if (worker) {
      await worker.stop();
    }
    vi.restoreAllMocks();
  });

  it('should process jobs with 3072 dimensions without error', async () => {
    // 1. Create file record
    const fileId = crypto.randomUUID();
    await db.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at, content_hash)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), $5)`,
      [fileId, 'test.txt', '/tmp/test.txt', 100, 'hash123']
    );

    // 2. Create chunk
    const chunkId = crypto.randomUUID();
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [chunkId, fileId, 0, 'hello world', 'hash123', 10, 'text', 100]
    );

    // 3. Create embedding set with 3072 dimensions
    const setId = crypto.randomUUID();
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [setId, 'local::large-dim-model', 'large-dim-model', 3072, 'cosine']
    );

    // 4. Enqueue job
    await jq.enqueue({
      jobType: 'embed_chunk',
      payload: {
        chunkId,
        embeddingSetId: setId,
        expectedDimension: 3072,
        modelKey: 'local::large-dim-model',
      },
      queue: 'embeddings',
    });

    // 5. Start worker with custom service that returns 3072-dim embeddings
    worker = await startEmbeddingWorker({
      concurrency: 1,
      db,
      enable: true,
      service: new LargeDimensionService(),
    });

    // 6. Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 7. Verify job success - the key test is that 3072 dimensions didn't cause errors
    const jobRes = await db.query<{ state: string; error: string | null }>(
      "SELECT state, error FROM job_queue WHERE job_type = 'embed_chunk'"
    );
    const job = jobRes.rows[0];
    expect(job).toBeDefined();
    expect(job?.state).toBe('succeeded');
    expect(job?.error).toBeNull();
  });
});
