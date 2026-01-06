import { describe, expect, it, vi } from 'vitest';
import {
  createVectorQueueService,
  type VectorQueueDatabase,
  type VectorQueueServiceDependencies,
} from '../vector-status/vector-queue-service';

describe('vector-queue-service', () => {
  it('refresh aggregates queue metrics and latency', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 1, running: 2, failed: 3, succeeded: 4 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const now = Date.now();
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('COUNT')) {
          return { rows: [{ count: '3' }] } as { rows: unknown[] };
        }
        if (sql.includes('SELECT error')) {
          return { rows: [{ error: 'failure' }] } as { rows: unknown[] };
        }
        if (sql.includes('run_at AS')) {
          return {
            rows: [
              {
                runAt: new Date(now - 1000).toISOString(),
                updatedAt: new Date(now).toISOString(),
              },
              {
                runAt: new Date(now - 2000).toISOString(),
                updatedAt: new Date(now - 500).toISOString(),
              },
            ],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      getCoverageForSet: vi.fn(async () => ({
        totalChunks: 12,
        chunksWithEmbeddingsForSet: 7,
      })),
      clearEmbeddingsForSet: vi.fn(async () => 0),
    };

    const service = createVectorQueueService({
      db,
      jobQueue,
      chunkRepository,
    });

    const snapshot = await service.refresh('set-1');

    expect(jobQueue.getQueueStats).toHaveBeenCalledWith('embeddings');
    expect(chunkRepository.getCoverageForSet).toHaveBeenCalledWith('set-1');
    expect(snapshot.coverage).toEqual({ total: 12, withSet: 7 });
    expect(snapshot.queueCounts).toEqual({ queued: 1, running: 2, failed: 3, succeeded: 4 });
    expect(snapshot.throughput).toBe(3);
    expect(snapshot.lastError).toBe('failure');
    expect(snapshot.latency.p50Ms).toBeGreaterThan(0);
  });

  it('backfill enqueues chunks with dedupe keys', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 2, running: 1, failed: 0, succeeded: 5 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (typeof params === 'undefined') {
          queries.push({ sql });
        } else {
          queries.push({ sql, params });
        }
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::jina-code', modelId: 'jina-code', dimensions: 768 }],
          } as { rows: unknown[] };
        }
        if (sql.startsWith('SELECT c.id')) {
          return {
            rows: [
              { id: '1', fileRecordId: '10', contentHash: 'aa' },
              { id: '2', fileRecordId: '11', contentHash: 'bb' },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('INSERT INTO job_queue')) {
          return { rows: [{ inserted: 2 }] } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      getCoverageForSet: vi.fn(async () => ({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 })),
      clearEmbeddingsForSet: vi.fn(async () => 0),
    };

    const service = createVectorQueueService({
      db,
      jobQueue,
      chunkRepository,
    });

    const progressUpdates: Array<{ done: number; total: number }> = [];
    const counts = await service.backfill('set-1', (done, total) => {
      progressUpdates.push({ done, total });
    });

    const metadataQuery = queries.find((entry) => entry.sql.includes('FROM embedding_sets'));
    const selectQuery = queries.find((entry) => entry.sql.includes('FROM file_chunks'));
    const insertQuery = queries.find((entry) => entry.sql.includes('INSERT INTO job_queue'));

    if (!(metadataQuery && selectQuery && insertQuery)) {
      throw new Error('Expected metadata, select, and insert queries');
    }

    expect(metadataQuery.sql).toContain('FROM embedding_sets');
    expect(selectQuery.sql).toContain('FROM file_chunks');
    expect(insertQuery.sql).toContain('INSERT INTO job_queue');

    const insertParams = insertQuery.params ?? [];
    expect(insertParams).toEqual(expect.arrayContaining(['1:set-1:aa', '2:set-1:bb']));

    const payloads = insertParams
      .filter((value) => typeof value === 'string' && String(value).includes('"chunkId"'))
      .map((value) => JSON.parse(String(value)) as Record<string, unknown>);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload).toMatchObject({ modelKey: 'local::jina-code', expectedDimension: 768 });
    }
    expect(progressUpdates).toEqual([
      { done: 0, total: 2 },
      { done: 2, total: 2 },
    ]);
    expect(counts).toEqual({ queued: 2, running: 1, failed: 0, succeeded: 5 });
  });

  it('reembedSet clears embeddings then triggers backfill', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 3, running: 0, failed: 0, succeeded: 10 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'openai::text-embedding-3-small', modelId: null, dimensions: 1536 }],
          } as { rows: unknown[] };
        }
        if (sql.startsWith('SELECT c.id')) {
          // Return 3 chunks that need re-embedding
          return {
            rows: [
              { id: '1', fileRecordId: '10', contentHash: 'hash1' },
              { id: '2', fileRecordId: '11', contentHash: 'hash2' },
              { id: '3', fileRecordId: '12', contentHash: 'hash3' },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('INSERT INTO job_queue')) {
          return { rows: [{ inserted: 3 }] } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      getCoverageForSet: vi.fn(async () => ({ totalChunks: 5, chunksWithEmbeddingsForSet: 0 })),
      clearEmbeddingsForSet: vi.fn(async () => 5), // Cleared 5 embeddings
    };

    const service = createVectorQueueService({
      db,
      jobQueue,
      chunkRepository,
    });

    const progressUpdates: Array<{ done: number; total: number }> = [];
    const result = await service.reembedSet('set-123', (done, total) => {
      progressUpdates.push({ done, total });
    });

    // Verify clearEmbeddingsForSet was called with the correct embeddingSetId
    expect(chunkRepository.clearEmbeddingsForSet).toHaveBeenCalledWith('set-123');
    expect(chunkRepository.clearEmbeddingsForSet).toHaveBeenCalledTimes(1);

    // Verify result structure
    expect(result.clearedCount).toBe(5);
    expect(result.queueCounts).toEqual({ queued: 3, running: 0, failed: 0, succeeded: 10 });

    // Verify progress callbacks were invoked during backfill
    expect(progressUpdates).toEqual([
      { done: 0, total: 3 },
      { done: 3, total: 3 },
    ]);
  });

  it('reembedSet returns zero cleared when no embeddings exist', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::test-model', modelId: 'test-model', dimensions: 384 }],
          } as { rows: unknown[] };
        }
        // No chunks to backfill
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      getCoverageForSet: vi.fn(async () => ({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 })),
      clearEmbeddingsForSet: vi.fn(async () => 0), // Nothing to clear
    };

    const service = createVectorQueueService({
      db,
      jobQueue,
      chunkRepository,
    });

    const result = await service.reembedSet('empty-set', vi.fn());

    expect(chunkRepository.clearEmbeddingsForSet).toHaveBeenCalledWith('empty-set');
    expect(result.clearedCount).toBe(0);
    expect(result.queueCounts).toEqual({ queued: 0, running: 0, failed: 0, succeeded: 0 });
  });
});
