import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EnqueueEmbeddingBackfillOptions,
  enqueueEmbeddingBackfill,
} from '../../embedding-backfill';

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

  it('uses injected time for queue capacity timeouts', async () => {
    vi.useFakeTimers();
    let currentTime = 0;
    let statsCalls = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => {
        statsCalls += 1;
        if (statsCalls > 1) {
          currentTime = 11;
        }
        return [{ queue: 'embeddings', queued: 1, running: 0, failed: 0, succeeded: 0 }];
      }),
    };

    const backfill = expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 1,
        now: () => currentTime,
        queueCapacityTimeoutMs: 10,
      })
    ).rejects.toThrow('Backfill timed out while waiting for queue capacity below 1 jobs');
    await vi.advanceTimersByTimeAsync(1);

    await backfill;
  });

  it('uses injected time for embedding set drain timeouts', async () => {
    vi.useFakeTimers();
    let currentTime = 0;
    let pendingCountCalls = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ queued: 0, running: 1, failed: 0, succeeded: 0 }],
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          pendingCountCalls += 1;
          if (pendingCountCalls > 1) {
            currentTime = 11;
          }
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 0 }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
    };

    const backfill = expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        backlogPollMs: 1,
        drainTimeoutMs: 10,
        now: () => currentTime,
      })
    ).rejects.toThrow("Backfill timed out while waiting for embedding set 'set-123' to drain.");
    await vi.advanceTimersByTimeAsync(1);

    await backfill;
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
      {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        progressIntervalBatches: 1,
        progressIntervalMs: 1,
      }
    );

    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(jobQueue.enqueueBatch).mock.calls.map(([jobs]) => jobs.length)).toEqual([
      32, 32, 32,
    ]);
    expect(progressUpdates[0]).toEqual({ done: 0, total: 96 });
    expect(progressUpdates.at(-1)).toEqual({ done: 96, total: 96 });
    expect(progressUpdates.length).toBeLessThanOrEqual(4);
    expect(counts).toEqual({ queued: 0, running: 0, failed: 0, succeeded: 96 });
  });

  it('preserves the full provider model suffix when model keys contain additional separators', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::model::variant', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 1 }],
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: [{ id: '1', fileRecordId: '101', contentHash: 'hash-1' }],
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
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 1 },
      ]),
    };

    await enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
    });

    expect(jobQueue.enqueueBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        payload: expect.objectContaining({
          modelKey: 'local::model::variant',
        }),
      }),
    ]);
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

    await expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        queueCapacityTimeoutMs: 0,
      })
    ).rejects.toThrow('queueCapacityTimeoutMs must be a positive integer when configured.');

    await expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        drainTimeoutMs: 0,
      })
    ).rejects.toThrow('drainTimeoutMs must be a positive integer when configured.');

    await expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        progressIntervalMs: 0,
      })
    ).rejects.toThrow('progressIntervalMs must be a positive integer when configured.');
  });

  it('does not report 100% progress before deduplicated work has drained', async () => {
    let pendingCountCalls = 0;
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
        if (sql.includes("payload->>'embeddingSetId'")) {
          pendingCountCalls += 1;
          return { rows: [{ count: pendingCountCalls === 1 ? 4 : 0 }] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
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
              fileRecordId: String(index + 101),
              contentHash: `hash-${index + 1}`,
            })),
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const jobQueue = {
      enqueueBatch: vi.fn(async () => []),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
    };

    const progressUpdates: Array<{ done: number; total: number }> = [];
    await enqueueEmbeddingBackfill(
      db,
      jobQueue,
      'set-123',
      (done, total) => {
        progressUpdates.push({ done, total });
      },
      {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        progressIntervalBatches: 1,
        progressIntervalMs: 1,
      }
    );

    expect(progressUpdates).toEqual([
      { done: 0, total: 4 },
      { done: 4, total: 4 },
    ]);
  });

  it('throttles intermediate progress updates while still flushing completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T00:00:00.000Z'));
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

    const jobQueue = {
      enqueueBatch: vi.fn(async (jobs: Record<string, unknown>[]) =>
        jobs.map((job, index) => ({
          id: `job-${index}`,
          ...job,
        }))
      ),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
    };

    const progressUpdates: Array<{ done: number; total: number }> = [];
    const backfillPromise = enqueueEmbeddingBackfill(
      db,
      jobQueue,
      'set-123',
      (done, total) => {
        progressUpdates.push({ done, total });
      },
      {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        progressIntervalBatches: 1,
        progressIntervalMs: 250,
      }
    );

    await vi.runAllTimersAsync();
    await backfillPromise;

    expect(progressUpdates).toEqual([
      { done: 0, total: 96 },
      { done: 96, total: 96 },
    ]);
  });

  it('reuses known queue capacity across fully deduplicated batches', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 2 }],
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 64 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          const limit = Number(params?.[3] ?? 32);
          const start = afterChunkId ? Number(afterChunkId) : 0;
          return {
            rows: Array.from({ length: Math.max(0, Math.min(limit, 64 - start)) }, (_, index) => {
              const id = start + index + 1;
              return {
                id: String(id),
                fileRecordId: String(id + 100),
                contentHash: `hash-${id}`,
              };
            }),
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const jobQueue = {
      enqueueBatch: vi.fn(async () => []),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
    };

    await enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
      progressIntervalBatches: 1,
      progressIntervalMs: 1,
    });

    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(2);
    expect(jobQueue.getQueueStats).toHaveBeenCalledTimes(1);
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

    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(2);
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

  it('treats an already-drained queue as complete before failing host-health checks', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 2 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && !sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 2 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 2 }, (_, index) => ({
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
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 2 },
      ]),
    };

    await expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        assertCanContinue: () => {
          if (vi.mocked(jobQueue.enqueueBatch).mock.calls.length >= 1) {
            throw new Error('Embedding host stopped while backfill was in progress.');
          }
        },
        backlogPollMs: 1,
        maxQueueDepth: 64,
      })
    ).resolves.toEqual({ queued: 0, running: 0, failed: 0, succeeded: 2 });
  });

  it('reports only succeeded deltas to drain maintenance callbacks', async () => {
    const pendingCounts = [3, 2, 1, 0];
    const succeededCounts = [1, 1, 3];
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [
              {
                queued: 0,
                running: pendingCounts[0] ?? 0,
                failed: 0,
                succeeded: succeededCounts.shift() ?? 3,
              },
            ],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && !sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 3 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 3 }, (_, index) => ({
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
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 3 },
      ]),
    };

    const drainTicks: number[] = [];
    await enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
      onDrainTick: async (completedSinceLastTick) => {
        drainTicks.push(completedSinceLastTick);
      },
    });

    expect(drainTicks).toEqual([1, 2]);
  });

  it('keeps drain maintenance failures non-fatal', async () => {
    const pendingCounts = [2, 1, 0];
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ queued: 0, running: pendingCounts[0] ?? 0, failed: 0, succeeded: 1 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && !sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 2 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 2 }, (_, index) => ({
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
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 2 },
      ]),
    };

    await expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        onDrainTick: async () => {
          throw new Error('maintenance failed');
        },
      })
    ).resolves.toEqual({ queued: 0, running: 0, failed: 0, succeeded: 1 });
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

  it('ignores historical failed jobs from earlier runs when the current backfill drains cleanly', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
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
        if (sql.includes("payload->>'embeddingSetId'") && !sql.includes('COUNT(*) FILTER')) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          expect(params?.[2]).toEqual(expect.any(String));
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 4 }],
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
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 3, succeeded: 40 },
      ]),
    };

    await expect(
      enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        progressIntervalBatches: 1,
      })
    ).resolves.toEqual({ queued: 0, running: 0, failed: 0, succeeded: 4 });
  });

  it('fails fast when queue capacity never becomes available', async () => {
    vi.useFakeTimers();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] };
        }
        return { rows: [] };
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
        { queue: 'embeddings', queued: 64, running: 0, failed: 0, succeeded: 0 },
      ]),
    };

    const backfillPromise = enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
      queueCapacityTimeoutMs: 50,
    });
    const rejection = expect(backfillPromise).rejects.toThrow(
      'Backfill timed out while waiting for queue capacity below 64 jobs (queued=64, running=0, failed=0, succeeded=0).'
    );

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fails fast when the embedding set never drains', async () => {
    vi.useFakeTimers();
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ queued: 0, running: 1, failed: 0, succeeded: 0 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && !sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: [{ id: '1', fileRecordId: '100', contentHash: 'hash-1' }],
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 1 }] };
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
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
    };

    const backfillPromise = enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
      drainTimeoutMs: 50,
    });
    const rejection = expect(backfillPromise).rejects.toThrow(
      "Backfill timed out while waiting for embedding set 'set-123' to drain."
    );

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('reports drain progress deltas from completed items only at drain checkpoints', async () => {
    let pendingCountCalls = 0;
    let drainSucceededIndex = 0;
    const drainSucceededCounts = [2, 3];

    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          const succeeded =
            drainSucceededCounts[Math.min(drainSucceededIndex, drainSucceededCounts.length - 1)];
          drainSucceededIndex += 1;
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded }],
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          pendingCountCalls += 1;
          if (pendingCountCalls === 1) {
            return { rows: [{ count: 2 }] };
          }
          if (pendingCountCalls === 2) {
            return { rows: [{ count: 1 }] };
          }
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 3 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 3 }, (_, index) => ({
              id: String(index + 1),
              fileRecordId: String(index + 100),
              contentHash: `hash-${index + 1}`,
            })),
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
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
    };

    const drainDeltas: number[] = [];
    const result = await enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
      onDrainTick: async (completedSinceLastTick) => {
        drainDeltas.push(completedSinceLastTick);
      },
      progressIntervalBatches: 1,
      progressIntervalMs: 1,
    });

    expect(drainDeltas).toEqual([2, 1]);
    expect(result).toEqual({ queued: 0, running: 0, failed: 0, succeeded: 3 });
  });

  it('reports drain progress while waiting for queue capacity between enqueue passes', async () => {
    let pendingCountCalls = 0;
    let succeededCountCalls = 0;

    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          succeededCountCalls += 1;
          if (succeededCountCalls === 1) {
            return {
              rows: [{ queued: 1, running: 0, failed: 0, succeeded: 1 }],
            };
          }
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 2 }],
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          pendingCountCalls += 1;
          return { rows: [{ count: pendingCountCalls === 1 ? 0 : 0 }] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 2 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId === '1') {
            return {
              rows: [{ id: '2', fileRecordId: '102', contentHash: 'hash-2' }],
            };
          }
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: [{ id: '1', fileRecordId: '101', contentHash: 'hash-1' }],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const queueStats = [
      { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      { queue: 'embeddings', queued: 1, running: 0, failed: 0, succeeded: 0 },
      { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 1 },
    ];
    const jobQueue = {
      enqueueBatch: vi.fn(async (jobs: Record<string, unknown>[]) =>
        jobs.map((job, index) => ({
          id: `job-${index}`,
          ...job,
        }))
      ),
      getQueueStats: vi.fn(async () => [queueStats.shift() ?? queueStats.at(-1)!]),
    };

    const drainDeltas: number[] = [];
    const result = await enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 1,
      onDrainTick: async (completedSinceLastTick) => {
        drainDeltas.push(completedSinceLastTick);
      },
      progressIntervalBatches: 1,
      progressIntervalMs: 1,
    });

    expect(drainDeltas).toEqual([1]);
    expect(result).toEqual({ queued: 0, running: 0, failed: 0, succeeded: 2 });
  });

  it('vacuums backfill tables during enqueue capacity waits before final drain', async () => {
    let currentTime = 0;
    let pendingCountCalls = 0;
    let succeededCountCalls = 0;
    const queryEvents: string[] = [];

    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'VACUUM file_chunks') {
          queryEvents.push('vacuum-file-chunks');
          return { rows: [] };
        }
        if (sql === 'VACUUM job_queue') {
          queryEvents.push('vacuum-job-queue');
          return { rows: [] };
        }
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          succeededCountCalls += 1;
          return {
            rows: [
              {
                queued: succeededCountCalls < 2 ? 1 : 0,
                running: 0,
                failed: 0,
                succeeded: succeededCountCalls,
              },
            ],
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          pendingCountCalls += 1;
          queryEvents.push(`pending-${pendingCountCalls}`);
          return { rows: [{ count: pendingCountCalls < 2 ? 1 : 0 }] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 2 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId === '1') {
            return {
              rows: [{ id: '2', fileRecordId: '102', contentHash: 'hash-2' }],
            };
          }
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: [{ id: '1', fileRecordId: '101', contentHash: 'hash-1' }],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const queueStats = [
      { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      { queue: 'embeddings', queued: 1, running: 0, failed: 0, succeeded: 0 },
      { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 1 },
    ];
    const jobQueue = {
      enqueueBatch: vi.fn(async (jobs: Record<string, unknown>[]) =>
        jobs.map((job, index) => ({
          id: `job-${index}`,
          ...job,
        }))
      ),
      getQueueStats: vi.fn(async () => {
        currentTime += 10;
        return [queueStats.shift() ?? queueStats.at(-1)!];
      }),
    };

    const options = {
      backlogPollMs: 1,
      maxQueueDepth: 1,
      now: () => currentTime,
      progressIntervalBatches: 1,
      progressIntervalMs: 1,
      vacuumIntervalMs: 5,
    } satisfies EnqueueEmbeddingBackfillOptions;

    await enqueueEmbeddingBackfill(db, jobQueue, 'set-123', () => undefined, options);

    const firstVacuumIndex = queryEvents.indexOf('vacuum-file-chunks');
    const finalPendingIndex = queryEvents.lastIndexOf(`pending-${pendingCountCalls}`);
    expect(firstVacuumIndex).toBeGreaterThanOrEqual(0);
    expect(firstVacuumIndex).toBeLessThan(finalPendingIndex);
  });

  it('keeps 20k-candidate active backfill vacuum cadence bounded', async () => {
    const candidateCount = 20_000;
    let currentTime = 0;
    let queueStatsCalls = 0;
    let vacuumFileChunksCount = 0;

    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'VACUUM file_chunks') {
          vacuumFileChunksCount += 1;
          return { rows: [] };
        }
        if (sql === 'VACUUM job_queue') {
          return { rows: [] };
        }
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 384 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [
              {
                queued: 0,
                running: 0,
                failed: 0,
                succeeded: candidateCount,
              },
            ],
          };
        }
        if (sql.includes("payload->>'embeddingSetId'")) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: candidateCount }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? Number(params[2]) : 0;
          const limit = Number(params?.[3] ?? 32);
          return {
            rows: Array.from(
              { length: Math.max(0, Math.min(limit, candidateCount - afterChunkId)) },
              (_, index) => {
                const id = afterChunkId + index + 1;
                return {
                  id: String(id),
                  fileRecordId: String(id + 100_000),
                  contentHash: `hash-${id}`,
                };
              }
            ),
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const jobQueue = {
      enqueueBatch: vi.fn(async (jobs: Record<string, unknown>[]) =>
        jobs.map((job, index) => ({
          id: `job-${queueStatsCalls}-${index}`,
          ...job,
        }))
      ),
      getQueueStats: vi.fn(async () => {
        queueStatsCalls += 1;
        currentTime += 250;
        if (queueStatsCalls % 2 === 1) {
          return [{ queue: 'embeddings', queued: 32, running: 0, failed: 0, succeeded: 0 }];
        }
        return [{ queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 }];
      }),
    };

    const options = {
      backlogPollMs: 1,
      maxQueueDepth: 32,
      now: () => currentTime,
      progressIntervalBatches: 64,
      progressIntervalMs: 1,
      vacuumIntervalMs: 1000,
    } satisfies EnqueueEmbeddingBackfillOptions;

    await enqueueEmbeddingBackfill(db, jobQueue, 'set-20k', () => undefined, options);

    const enqueueBatchCount = vi.mocked(jobQueue.enqueueBatch).mock.calls.length;
    expect(enqueueBatchCount).toBe(Math.ceil(candidateCount / 32));
    expect(vacuumFileChunksCount).toBeGreaterThan(1);
    expect(vacuumFileChunksCount).toBeLessThan(enqueueBatchCount);
  }, 60_000);
});
