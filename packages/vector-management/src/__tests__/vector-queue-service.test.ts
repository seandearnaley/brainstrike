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
      enqueue: vi.fn(),
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
                runAt: new Date(now - 1_000).toISOString(),
                updatedAt: new Date(now).toISOString(),
              },
              {
                runAt: new Date(now - 2_000).toISOString(),
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
    const enqueueCalls: Array<{ dedupeKey?: string }> = [];
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 2, running: 1, failed: 0, succeeded: 5 },
      ]),
      enqueue: vi.fn(async (params) => {
        enqueueCalls.push({ dedupeKey: params.dedupeKey });
        return {
          id: '1',
          queue: params.queue,
          jobType: params.jobType,
          state: 'queued' as const,
          runAt: new Date().toISOString(),
          attempts: 0,
          max_attempts: 5,
          backoff_ms: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const queries: string[] = [];
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith('SELECT c.id')) {
          return {
            rows: [
              { id: '1', fileRecordId: '10', contentHash: 'aa' },
              { id: '2', fileRecordId: '11', contentHash: 'bb' },
            ],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      getCoverageForSet: vi.fn(async () => ({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 })),
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

    expect(queries).toContain('BEGIN');
    expect(queries).toContain('COMMIT');
    expect(enqueueCalls).toEqual([{ dedupeKey: '1:set-1:aa' }, { dedupeKey: '2:set-1:bb' }]);
    expect(progressUpdates[0]).toEqual({ done: 0, total: 2 });
    expect(progressUpdates.at(-1)).toEqual({ done: 2, total: 2 });
    expect(counts).toEqual({ queued: 2, running: 1, failed: 0, succeeded: 5 });
  });
});
