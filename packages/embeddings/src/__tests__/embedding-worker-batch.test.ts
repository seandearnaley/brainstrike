import { type IDatabase, JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index';
import { clearModelConfigCache } from '../worker/embedding-worker';

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
  generateUUID: () => 'test-uuid',
}));

// Mock the service to avoid loading actual models
vi.mock('../bge-m3-service', () => {
  return {
    SimpleEmbeddingService: class {
      async initializeWithModel() {}
      async initialize() {}
      async generateEmbeddings(texts: string[]) {
        return texts.map((_t) => ({
          embedding: new Array(768).fill(0.1),
          dimensions: 768,
          model: 'mock-model',
        }));
      }
      async dispose() {}
      getConfig() {
        return { modelId: 'mock-model' };
      }
    },
  };
});

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (true) {
    if (await fn()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Embedding Worker Batch Optimization', () => {
  let db: PGlite;

  beforeEach(async () => {
    clearModelConfigCache();
    db = await wasmLoader.createPGlite('memory://embedding-worker-batch-test');
    await migrate(db);
  });

  afterEach(async () => {
    await db.close();
    vi.restoreAllMocks();
  });

  it(
    'uses completeBatch for already-completed jobs to avoid N+1 queries',
    { timeout: 30_000 },
    async () => {
      const completeBatchSpy = vi.spyOn(JobQueue.prototype, 'completeBatch');
      const now = new Date().toISOString();

      // 1. Setup a chunk that is already embedded (embedding_hash matches)
      // Let the worker process a job once to populate the hash, then re-queue it.

      // Insert model to avoid DB lookup error
      await db.query(
        `INSERT INTO models (id, provider_id, name, capabilities, parameters)
         VALUES ('all-MiniLM-L6-v2', 'local', 'MiniLM', '{"defaultDimension": 768}', '{}')`
      );

      await db.query(
        `INSERT INTO embedding_sets (id, name, dimensions, created_at, model_key, model_id, distance)
       VALUES ('set-1', 'Default', 768, $1, 'local:all-MiniLM-L6-v2', 'all-MiniLM-L6-v2', 'cosine')`,
        [now]
      );

      await db.query(
        `INSERT INTO file_records (id, path, name, size, created_at, updated_at)
         VALUES ('file-1', '/test', 'test', 10, $1, $1)`,
        [now]
      );

      // Insert chunk
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, content, content_hash, chunk_index, embedding_set_id, created_at, updated_at)
         VALUES ('chunk-1', 'file-1', 'test-content', 'hash-1', 0, 'set-1', $1, $1)`,
        [now]
      );

      // Enqueue job 1
      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ('job-1', 'embeddings', 'embed_chunk', $1, 'queued', $2, 0, 1, 0, $2, $2)`,
        [
          JSON.stringify({
            chunkId: 'chunk-1',
            embeddingSetId: 'set-1',
            modelKey: 'local:all-MiniLM-L6-v2',
          }),
          now,
        ]
      );

      // Start worker to process job-1 (this will generate the embedding and hash)
      const controller1 = await startEmbeddingWorker({
        db: db as unknown as IDatabase,
        concurrency: 1,
        leaseMs: 5000,
        modelKey: 'local:all-MiniLM-L6-v2',
      });

      await waitFor(async () => {
        const res = await db.query<{ state: string }>(
          "SELECT state FROM job_queue WHERE id = 'job-1'"
        );
        return res.rows[0]?.state === 'succeeded';
      });

      await controller1.stop();
      completeBatchSpy.mockClear(); // Clear first run calls

      // Verify chunk has hash
      const chunkRes = await db.query<{ embedding_hash: string }>(
        "SELECT embedding_hash FROM file_chunks WHERE id = 'chunk-1'"
      );
      expect(chunkRes.rows[0]?.embedding_hash).toBeDefined();

      // Enqueue job 2 for SAME chunk (should be skipped/completed immediately)
      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ('job-2', 'embeddings', 'embed_chunk', $1, 'queued', $2, 0, 1, 0, $2, $2)`,
        [
          JSON.stringify({
            chunkId: 'chunk-1',
            embeddingSetId: 'set-1',
            modelKey: 'local:all-MiniLM-L6-v2',
          }),
          now,
        ]
      );

      // Start worker again
      const controller2 = await startEmbeddingWorker({
        db: db as unknown as IDatabase,
        concurrency: 1,
        leaseMs: 5000,
        modelKey: 'local:all-MiniLM-L6-v2',
      });

      await waitFor(async () => {
        const res = await db.query<{ state: string }>(
          "SELECT state FROM job_queue WHERE id = 'job-2'"
        );
        return res.rows[0]?.state === 'succeeded';
      });

      // Check if completeBatch was used (it should be, even for skipped jobs if they are part of a group)
      expect(completeBatchSpy).toHaveBeenCalled(); // This assertion expects completeBatch usage.

      await controller2.stop();
    }
  );
});
