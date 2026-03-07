import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueEmbeddingBackfill } from '../../embedding-backfill';

interface MockQueueStatsRow {
  failed: number;
  nextRunnableAt?: string | null;
  queue: string;
  queued: number;
  running: number;
  succeeded: number;
}

describe('embedding-backfill', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('keeps the queued backlog bounded while draining a large backfill', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 96 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          const start = afterChunkId ? Number(afterChunkId) : 0;
          const limit = Number(params?.[3] ?? 32);
          return {
            rows: Array.from({ length: Math.max(0, Math.min(limit, 96 - start)) }, (_, index) => {
              const id = start + index + 1;
              return {
                id: String(id),
                fileRecordId: String(id + 1000),
                contentHash: `hash-${id}`,
              };
            }),
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const statsSequence: MockQueueStatsRow[] = [
      { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      { queue: 'embeddings', queued: 32, running: 0, failed: 0, succeeded: 0 },
      { queue: 'embeddings', queued: 64, running: 0, failed: 0, succeeded: 0 },
      { queue: 'embeddings', queued: 24, running: 8, failed: 0, succeeded: 0 },
    ];
    const finalStats = { queue: 'embeddings', queued: 56, running: 8, failed: 0, succeeded: 0 };

    const jobQueue = {
      enqueueBatch: vi.fn(async (jobs: Record<string, unknown>[]) =>
        jobs.map((job, index) => ({
          id: `job-${index}`,
          ...job,
        }))
      ),
      getQueueStats: vi.fn(async () => {
        const next = statsSequence.shift();
        if (next) {
          return [next];
        }
        return [finalStats];
      }),
    };

    const progressUpdates: Array<{ done: number; total: number }> = [];
    const counts = await enqueueEmbeddingBackfill(
      db,
      jobQueue,
      'set-123',
      (done, total) => {
        progressUpdates.push({ done, total });
      },
      { backlogPollMs: 1, maxQueueDepth: 64, progressIntervalBatches: 1 }
    );

    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(jobQueue.enqueueBatch).mock.calls.map(([jobs]) => jobs.length)).toEqual([
      32, 32, 32,
    ]);
    expect(progressUpdates).toEqual([
      { done: 0, total: 96 },
      { done: 32, total: 96 },
      { done: 64, total: 96 },
      { done: 96, total: 96 },
    ]);
    expect(counts).toEqual({ queued: 56, running: 8, failed: 0, succeeded: 0 });
  });

  it('fails fast when backlog pacing options are invalid', async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => []),
    };

    await expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        maxQueueDepth: 0,
      })
    ).rejects.toThrow('maxQueueDepth must be a positive integer when configured.');

    await expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        backlogPollMs: 0,
      })
    ).rejects.toThrow('backlogPollMs must be a positive integer when configured.');
  });

  it('aborts backfill when the embedding host can no longer accept queued work', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 96 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          const start = afterChunkId ? Number(afterChunkId) : 0;
          const limit = Number(params?.[3] ?? 32);
          return {
            rows: Array.from({ length: Math.max(0, Math.min(limit, 96 - start)) }, (_, index) => {
              const id = start + index + 1;
              return {
                id: String(id),
                fileRecordId: String(id + 1000),
                contentHash: `hash-${id}`,
              };
            }),
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const jobQueue = {
      enqueueBatch: vi.fn(async (jobs: Record<string, unknown>[]) =>
        jobs.map((job, index) => ({
          id: `job-${index}`,
          ...job,
        }))
      ),
      getQueueStats: vi
        .fn()
        .mockResolvedValueOnce([
          { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
        ])
        .mockResolvedValue([
          { queue: 'embeddings', queued: 64, running: 0, failed: 0, succeeded: 0 },
        ]),
    };

    await expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        assertCanContinue: () => {
          if (vi.mocked(jobQueue.enqueueBatch).mock.calls.length >= 1) {
            throw new Error('Embedding host entered an error state during backfill.');
          }
        },
      })
    ).rejects.toThrow('Embedding host entered an error state during backfill.');

    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(1);
  });
});
