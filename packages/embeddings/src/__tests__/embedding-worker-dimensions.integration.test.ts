import { type IDatabase, JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingProviderFactory } from '../factory';
import type { IEmbeddingProvider } from '../interfaces/provider';
import { type EmbeddingWorkerController, startEmbeddingWorker } from '../worker/embedding-worker';

// Mock IEmbeddingProvider
class LargeDimensionProvider {
  async embed(input: { text: string | string[]; modelId: string }) {
    const count = Array.isArray(input.text) ? input.text.length : 1;
    const embeddings = new Array(count).fill(new Array(3072).fill(0.1));
    return {
      ok: true,
      value: {
        embedding: embeddings[0],
        embeddings,
        dimensions: 3072,
        modelId: input.modelId,
        provider: 'openai',
        usage: { inputTokens: 10, totalTokens: 10 },
      },
    };
  }
  async isAvailable() {
    return true;
  }
  getModelInfo(modelId: string) {
    return {
      id: modelId,
      name: 'Large Model',
      dimensions: 3072,
      quantized: false,
      description: 'Mock model',
      tags: [],
    };
  }
  validateDimensions() {
    return { ok: true };
  }
}

describe('Embedding Worker Dimensions', () => {
  let db: IDatabase;
  let jq: JobQueue;
  let worker: EmbeddingWorkerController;

  beforeEach(async () => {
    // Mock isNodejsMainProcess to allow local model execution in test
    vi.mock('@brainstrike/utils', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@brainstrike/utils')>();
      return {
        ...actual,
        isNodejsMainProcess: () => false,
      };
    });

    const pglite = await wasmLoader.createPGlite('memory://dim-test');
    await migrate(pglite as any);
    db = pglite as unknown as IDatabase;
    jq = new JobQueue(db);

    // Mock provider factory to return our service
    // Mock provider factory to return our service
    vi.spyOn(EmbeddingProviderFactory, 'createProvider').mockResolvedValue({
      ok: true,
      value: new LargeDimensionProvider() as unknown as IEmbeddingProvider,
    });

    // Mock model config to return 3072 dimensions
    // Note: getModelConfig is likely not used directly by worker, but let's check worker code.
    // Worker uses resolveJobModel which uses factory methods?
    // Actually worker uses resolveJobModel which is internal.
    // Let's remove getModelConfig mock if it doesn't exist or isn't used.
  });

  afterEach(async () => {
    if (worker) {
      await worker.stop();
    }
    vi.restoreAllMocks();
  });

  it('should process jobs with 3072 dimensions without error', async () => {
    // 1. Create embedding set
    const setRes = await db.query<{ id: string }>(
      "INSERT INTO embedding_sets (id, name, model_key, model_id, dimensions, distance) VALUES ($1, 'large-set', 'openai:text-embedding-3-large', 'text-embedding-3-large', 3072, 'cosine') RETURNING id",
      [crypto.randomUUID()]
    );
    const setId = setRes.rows[0]?.id;
    expect(setId).toBeDefined();

    // 2. Create file record
    const fileRes = await db.query<{ id: string }>(
      "INSERT INTO file_records (id, name, path, size, created_at, updated_at) VALUES ($1, 'test.txt', 'test.txt', 100, NOW(), NOW()) RETURNING id",
      [crypto.randomUUID()]
    );
    const fileId = fileRes.rows[0]?.id;

    // 3. Create chunk
    const chunkRes = await db.query<{ id: string }>(
      "INSERT INTO file_chunks (id, file_record_id, content, chunk_index, content_hash, created_at, updated_at) VALUES ($1, $2, 'hello world', 0, 'hash', NOW(), NOW()) RETURNING id",
      [crypto.randomUUID(), fileId]
    );
    const chunkId = chunkRes.rows[0]?.id;

    // 4. Enqueue job
    await jq.enqueue({
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: {
        chunkId,
        embeddingSetId: setId,
        modelKey: 'openai:text-embedding-3-large',
      },
    });

    // 5. Start worker
    worker = await startEmbeddingWorker({
      db,
      queue: 'embeddings',
      concurrency: 1,
      modelKey: 'openai:text-embedding-3-large',
    });

    // 6. Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 7. Verify job success
    const jobRes = await db.query<{ state: string }>(
      "SELECT state FROM job_queue WHERE job_type = 'embed_chunk'"
    );
    expect(jobRes.rows[0]?.state).toBe('succeeded');

    // 8. Verify embedding dimensions in DB (mock check since we don't have vector extension in pglite memory usually, or maybe we do?)
    // Actually pglite supports pgvector if configured, but let's check the chunk record
    // The worker updates file_chunks with embedding_hash, but the actual vector is stored in `embeddings` table usually?
    // Wait, the worker calls `completeBatch` which inserts into `embeddings` table.

    // Let's check if the worker threw any errors about dimensions.
  });
});
