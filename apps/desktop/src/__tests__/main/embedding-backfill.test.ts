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
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 96 }],
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 0 }] };
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
    const finalStats = { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 96 };

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
    expect(counts).toEqual({ queued: 0, running: 0, failed: 0, succeeded: 96 });
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
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ queued: 64, running: 0, failed: 0, succeeded: 0 }],
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 64 }] };
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

  it('waits for the active embedding set queue to drain before reporting completion', async () => {
    const pendingCounts = [8, 4, 0];
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 4 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && !sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 4 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 4 }, (_, index) => ({
              id: String(index + 1),
              fileRecordId: String(index + 100),
              contentHash: `hash-${index + 1}`,
            })),
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: pendingCounts.shift() ?? 0 }] };
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
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 4 },
      ]),
    };

    await enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
      progressIntervalBatches: 1,
    });

    expect(
      vi
        .mocked(db.query)
        .mock.calls.filter(
          ([sql]) =>
            String(sql).includes("payload->>'embeddingSetId'") &&
            !String(sql).includes('COUNT(*) FILTER')
        ).length
    ).toBe(3);
  });

  it('fails when the embedding set drain completes with failed jobs', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 2, succeeded: 2 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && !sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 4 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 4 }, (_, index) => ({
              id: String(index + 1),
              fileRecordId: String(index + 100),
              contentHash: `hash-${index + 1}`,
            })),
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 0 }] };
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
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 4 },
      ]),
    };

    await expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        progressIntervalBatches: 1,
      })
    ).rejects.toThrow("Backfill failed for embedding set 'set-123': 2 job(s) failed.");
  });
});
