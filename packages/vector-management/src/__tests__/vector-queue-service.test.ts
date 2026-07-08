import type { Job } from '@brainstrike/db';
import { checkApiKeyAvailability } from '@brainstrike/embeddings';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateLatency,
  createVectorQueueService,
  type VectorQueueDatabase,
  type VectorQueueServiceDependencies,
} from '../vector-status/vector-queue-service';

vi.mock('@brainstrike/embeddings', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/embeddings')>();
  return {
    ...original,
    checkApiKeyAvailability: vi.fn(),
  };
});

interface MockEnqueueJob {
  dedupeKey?: string;
  payload: unknown;
}

function createMockEnqueuedJobs(jobs: MockEnqueueJob[]): Job[] {
  return jobs.map((job, index) => ({
    attempts: 0,
    backoff_ms: 0,
    created_at: new Date(0).toISOString(),
    dedupe_key: job.dedupeKey ?? null,
    error: null,
    id: `job-${index}`,
    jobType: 'embed_chunk',
    lease_token: null,
    leasedUntil: null,
    max_attempts: 5,
    payload: job.payload,
    queue: 'embeddings',
    runAt: new Date(0).toISOString(),
    state: 'queued',
    updated_at: new Date(0).toISOString(),
    worker_id: null,
  }));
}

function createMinimalDependencies(db: VectorQueueDatabase): VectorQueueServiceDependencies {
  return {
    chunkRepository: {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({
        chunksWithEmbeddingsForSet: 0,
        totalChunks: 0,
      })),
    },
    db,
    jobQueue: {
      clear: vi.fn(),
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => []),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    },
  };
}

describe('vector-queue-service', () => {
  beforeEach(() => {
    vi.mocked(checkApiKeyAvailability).mockReset();
    vi.mocked(checkApiKeyAvailability).mockResolvedValue({ available: true });
  });

  it('refresh aggregates queue metrics and latency', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        {
          failed: 3,
          queue: 'embeddings',
          queued: 1,
          running: 2,
          succeeded: 4,
          succeededLifetime: 4,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
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
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({
        chunksWithEmbeddingsForSet: 7,
        totalChunks: 12,
      })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    const snapshot = await service.refresh('set-1');

    expect(jobQueue.getQueueStats).toHaveBeenCalledWith('embeddings');
    expect(chunkRepository.getCoverageForSet).toHaveBeenCalledWith('set-1');
    expect(snapshot.coverage).toEqual({ total: 12, withSet: 7 });
    expect(snapshot.queueCounts).toEqual({ failed: 3, queued: 1, running: 2, succeeded: 4 });
    expect(snapshot.throughput).toBe(3);
    expect(snapshot.lastError).toBe('failure');
    expect(snapshot.latency.p50Ms).toBeGreaterThan(0);
  });

  it('backfill enqueues chunks with dedupe keys', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 2,
          running: 1,
          succeeded: 5,
          succeededLifetime: 5,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (typeof params === 'undefined') {
          queries.push({ sql });
        } else {
          queries.push({ params, sql });
        }
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 768,
                modelId: 'jinaai/jina-embeddings-v2-base-code',
                modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 2 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          return {
            rows: [
              { contentHash: 'aa', fileRecordId: '10', id: '1' },
              { contentHash: 'bb', fileRecordId: '11', id: '2' },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 2 }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    const progressUpdates: Array<{ done: number; total: number }> = [];
    const counts = await service.backfill('set-1', {
      onProgress: (done: number, total: number) => {
        progressUpdates.push({ done, total });
      },
    });

    const metadataQuery = queries.find((entry) => entry.sql.includes('FROM embedding_sets'));
    const countQuery = queries.find((entry) => entry.sql.includes('COUNT(*)::int AS count'));
    const selectQuery = queries.find((entry) => entry.sql.includes('ORDER BY c.id::text ASC'));

    if (!(metadataQuery && countQuery && selectQuery)) {
      throw new Error('Expected metadata, count, and select queries');
    }

    expect(metadataQuery.sql).toContain('FROM embedding_sets');
    expect(countQuery.sql).toContain('COUNT(*)::int AS count');
    expect(selectQuery.sql).toContain('FROM file_chunks');

    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(1);
    const enqueuedJobs = vi.mocked(jobQueue.enqueueBatch).mock.calls[0]?.[0];
    expect(enqueuedJobs).toBeDefined();
    expect(enqueuedJobs).toHaveLength(2);

    const payloads = enqueuedJobs?.map((job) => job.payload as Record<string, unknown>) ?? [];
    for (const payload of payloads) {
      expect(payload).toMatchObject({
        expectedDimension: 768,
        modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
      });
    }
    expect(enqueuedJobs?.map((job) => job.dedupeKey)).toEqual(['1:set-1:aa', '2:set-1:bb']);
    expect(progressUpdates).toEqual([
      { done: 0, total: 2 },
      { done: 2, total: 2 },
    ]);
    expect(counts).toEqual({ failed: 0, queued: 0, running: 0, succeeded: 2 });
  });

  it('loads candidate diagnostics when backfill has no eligible chunks', async () => {
    const capturedLogs: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => {
      if (record.scope === 'VectorQueueService') {
        capturedLogs.push(record);
      }
    });
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 0,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const queries: string[] = [];
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 384,
                modelId: 'Xenova/all-MiniLM-L6-v2',
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 0 }] } as { rows: unknown[] };
        }
        if (sql.includes('backfill_candidate_diagnostics')) {
          return {
            rows: [
              {
                chunkCount: 0,
                embeddedChunkCount: 0,
                failedJobs: 0,
                fileCount: 1,
                pendingChunkCount: 0,
                queuedOrRunningJobs: 0,
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 0 }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    try {
      await service.backfill('set-1', {
        onProgress: vi.fn(),
      });
    } finally {
      removeLogListener();
    }

    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
    expect(queries.some((sql) => sql.includes('backfill_candidate_diagnostics'))).toBe(true);
    expect(
      capturedLogs.filter(
        (record) =>
          record.level === LogLevel.WARN && record.message === 'Backfill found no eligible chunks'
      )
    ).toEqual([]);
    expect(capturedLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: LogLevel.INFO,
          message: 'Backfill found no eligible chunks',
        }),
      ])
    );
  });

  it('recovers active-set failed and unclaimable queued jobs before waiting for drain', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 0,
          running: 0,
          succeeded: 13,
          succeededLifetime: 13,
        },
      ]),
      repairUnclaimableQueued: vi.fn(async () => 13),
      requeueFailed: vi.fn(async () => 13),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 384,
                modelId: 'Xenova/all-MiniLM-L6-v2',
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 0 }] } as { rows: unknown[] };
        }
        if (sql.includes('backfill_candidate_diagnostics')) {
          return {
            rows: [
              {
                chunkCount: 13,
                embeddedChunkCount: 0,
                failedJobs: 13,
                fileCount: 8,
                pendingChunkCount: 13,
                queuedOrRunningJobs: 13,
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 13 }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    await expect(service.backfill('set-1', { onProgress: vi.fn() })).resolves.toEqual({
      failed: 0,
      queued: 0,
      running: 0,
      succeeded: 13,
    });

    expect(jobQueue.repairUnclaimableQueued).toHaveBeenCalledWith('embeddings', 5000, {
      embeddingSetId: 'set-1',
    });
    expect(jobQueue.requeueFailed).toHaveBeenCalledWith('embeddings', 5000, {
      embeddingSetId: 'set-1',
    });
    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
  });

  it('retryFailed also repairs queued jobs that cannot be claimed', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        {
          failed: 13,
          queue: 'embeddings',
          queued: 13,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      ]),
      repairUnclaimableQueued: vi.fn(async () => 13),
      requeueFailed: vi.fn(async () => 13),
    };
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => ({ rows: [] })) as VectorQueueDatabase['query'],
    };
    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };
    const service = createVectorQueueService({ chunkRepository, db, jobQueue });

    await service.retryFailed(100);

    expect(jobQueue.repairUnclaimableQueued).toHaveBeenCalledWith('embeddings', 100);
    expect(jobQueue.requeueFailed).toHaveBeenCalledWith('embeddings', 100);
  });

  it('backfill splits large enqueue work into cooperative batches', async () => {
    const queueStatsSequence = [
      { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0, succeededLifetime: 0 },
      {
        failed: 0,
        queue: 'embeddings',
        queued: 32,
        running: 0,
        succeeded: 0,
        succeededLifetime: 0,
      },
      {
        failed: 0,
        queue: 'embeddings',
        queued: 64,
        running: 0,
        succeeded: 0,
        succeededLifetime: 0,
      },
      {
        failed: 0,
        queue: 'embeddings',
        queued: 24,
        running: 8,
        succeeded: 0,
        succeededLifetime: 0,
      },
    ];
    const finalQueueStats = {
      failed: 0,
      queue: 'embeddings',
      queued: 56,
      running: 8,
      succeeded: 0,
      succeededLifetime: 0,
    };
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [queueStatsSequence.shift() ?? finalQueueStats]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 768,
                modelId: 'jinaai/jina-embeddings-v2-base-code',
                modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 96 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          const start = afterChunkId ? Number(afterChunkId) : 0;
          const limit = Number(params?.[3] ?? 32);
          return {
            rows: Array.from({ length: Math.max(0, Math.min(limit, 96 - start)) }, (_, index) => {
              const id = start + index + 1;
              return {
                contentHash: `hash-${id}`,
                fileRecordId: `${id + 1000}`,
                id: `${id}`,
              };
            }),
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 96 }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    const progressUpdates: Array<{ done: number; total: number }> = [];
    await service.backfill('set-1', {
      onProgress: (done: number, total: number) => {
        progressUpdates.push({ done, total });
      },
    });

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
  });

  it('backfill throws when the embedding set drains with failed jobs', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 1,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    let setQueueCountCalls = 0;
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 384,
                modelId: 'Xenova/all-MiniLM-L6-v2',
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          return {
            rows: [{ contentHash: 'hash-1', fileRecordId: '10', id: '1' }],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          setQueueCountCalls += 1;
          return {
            rows: [
              setQueueCountCalls === 1
                ? { failed: 0, queued: 0, running: 0, succeeded: 0 }
                : { failed: 1, queued: 0, running: 0, succeeded: 0 },
            ],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    await expect(service.backfill('set-1', { onProgress: vi.fn() })).rejects.toThrow(
      "Backfill failed for embedding set 'set-1': 1 job(s) failed."
    );
  });

  it('does not fail a new backfill because of historical failed jobs for the same set', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        {
          failed: 1,
          queue: 'embeddings',
          queued: 1,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 384,
                modelId: 'Xenova/all-MiniLM-L6-v2',
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          return {
            rows: [{ contentHash: 'hash-1', fileRecordId: '10', id: '1' }],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ failed: 1, queued: 0, running: 0, succeeded: 1 }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    await expect(service.backfill('set-1', { onProgress: vi.fn() })).resolves.toEqual({
      failed: 1,
      queued: 0,
      running: 0,
      succeeded: 1,
    });
  });

  it('backfill fails fast when queue capacity never becomes available', async () => {
    vi.useFakeTimers();
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 64,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 384,
                modelId: 'Xenova/all-MiniLM-L6-v2',
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    const backfillPromise = service.backfill('set-1', { onProgress: vi.fn() });
    const rejection = expect(backfillPromise).rejects.toThrow(
      'Backfill timed out while waiting for queue capacity below 64 jobs.'
    );
    await vi.advanceTimersByTimeAsync(30_500);

    await rejection;
    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('honors a configured queue capacity timeout', async () => {
    vi.useFakeTimers();
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 64,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 384,
                modelId: 'Xenova/all-MiniLM-L6-v2',
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    const backfillPromise = service.backfill('set-1', {
      onProgress: vi.fn(),
      queueCapacityTimeoutMs: 50,
    });
    const rejection = expect(backfillPromise).rejects.toThrow(
      'Backfill timed out while waiting for queue capacity below 64 jobs.'
    );
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('backfill aborts cleanly while waiting for queue capacity', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 64,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 384,
                modelId: 'Xenova/all-MiniLM-L6-v2',
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    const backfillPromise = service.backfill('set-1', {
      onProgress: vi.fn(),
      signal: abortController.signal,
    });
    abortController.abort();

    await expect(backfillPromise).rejects.toThrow('Embedding backfill was aborted.');
    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('backfill fails fast when the embedding set never drains', async () => {
    vi.useFakeTimers();
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 0,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 384,
                modelId: 'Xenova/all-MiniLM-L6-v2',
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          return {
            rows: [{ contentHash: 'hash-1', fileRecordId: '10', id: '1' }],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 1, succeeded: 0 }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    const backfillPromise = service.backfill('set-1', { onProgress: vi.fn() });
    const rejection = expect(backfillPromise).rejects.toThrow(
      "Backfill timed out while waiting for embedding set 'set-1' to drain."
    );
    await vi.advanceTimersByTimeAsync(300_500);

    await rejection;
    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('backfill aborts cleanly while waiting for drain', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 0,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                dimensions: 384,
                modelId: 'Xenova/all-MiniLM-L6-v2',
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          return {
            rows: [{ contentHash: 'hash-1', fileRecordId: '10', id: '1' }],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 1, succeeded: 0 }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0),
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    const backfillPromise = service.backfill('set-1', {
      onProgress: vi.fn(),
      signal: abortController.signal,
    });
    await vi.advanceTimersByTimeAsync(50);
    abortController.abort();

    await expect(backfillPromise).rejects.toThrow('Embedding backfill was aborted.');
    vi.useRealTimers();
  });

  it('reembedSet clears embeddings then triggers backfill', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 3,
          running: 0,
          succeeded: 10,
          succeededLifetime: 10,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 1536, modelId: null, modelKey: 'openai::text-embedding-3-small' }],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 3 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          // Return 3 chunks that need re-embedding
          return {
            rows: [
              { contentHash: 'hash1', fileRecordId: '10', id: '1' },
              { contentHash: 'hash2', fileRecordId: '11', id: '2' },
              { contentHash: 'hash3', fileRecordId: '12', id: '3' },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 3 }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 5), // Cleared 5 embeddings
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 5 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
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
    expect(result.queueCounts).toEqual({ failed: 0, queued: 0, running: 0, succeeded: 3 });

    // Verify progress callbacks were invoked during backfill
    expect(progressUpdates).toEqual([
      { done: 0, total: 3 },
      { done: 3, total: 3 },
    ]);
  });

  it('reembedSet returns zero cleared when no embeddings exist', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      clear: vi.fn(),
      enqueueBatch: vi.fn(async () => []),
      getQueueStats: vi.fn(async () => [
        {
          failed: 0,
          queue: 'embeddings',
          queued: 0,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      ]),
      repairUnclaimableQueued: vi.fn(),
      requeueFailed: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelId: 'test-model', modelKey: 'local::test-model' }],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 0 }],
          } as { rows: unknown[] };
        }
        // No chunks to backfill
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };

    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      clearEmbeddingsForSet: vi.fn(async () => 0), // Nothing to clear
      getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })),
    };

    const service = createVectorQueueService({
      chunkRepository,
      db,
      jobQueue,
    });

    const result = await service.reembedSet('empty-set', vi.fn());

    expect(chunkRepository.clearEmbeddingsForSet).toHaveBeenCalledWith('empty-set');
    expect(result.clearedCount).toBe(0);
    expect(result.queueCounts).toEqual({ failed: 0, queued: 0, running: 0, succeeded: 0 });
  });

  it('validates API keys through canonical embedding set metadata', async () => {
    vi.mocked(checkApiKeyAvailability).mockResolvedValue({ available: true });
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: '1536', modelKey: 'openai::text-embedding-3-small' }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };
    const service = createVectorQueueService(createMinimalDependencies(db));

    await expect(service.validateApiKeyForSet('set-1')).resolves.toEqual({ valid: true });

    expect(checkApiKeyAvailability).toHaveBeenCalledWith('openai::text-embedding-3-small');
  });

  it('returns unavailable API key validation details from the provider check', async () => {
    vi.mocked(checkApiKeyAvailability).mockResolvedValue({
      available: false,
      message: 'OpenAI key is missing',
      provider: 'openai',
      reason: 'missing-provider-key',
    });
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 1536, modelKey: 'openai::text-embedding-3-small' }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };
    const service = createVectorQueueService(createMinimalDependencies(db));

    await expect(service.validateApiKeyForSet('set-1')).resolves.toEqual({
      message: 'OpenAI key is missing',
      reason: 'missing-provider-key',
      valid: false,
    });
  });

  it.each([
    {
      message: 'Embedding set set-1 not found',
      name: 'missing row',
      rows: [],
    },
    {
      message: 'Embedding set set-1 is missing model_key metadata',
      name: 'missing model key',
      rows: [{ dimensions: 384, modelKey: '   ' }],
    },
    {
      message: 'Embedding set set-1 is missing dimension metadata',
      name: 'invalid dimensions',
      rows: [{ dimensions: 0, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
    },
  ])('reports validation errors for $name metadata', async ({ rows, message }) => {
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return { rows } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };
    const service = createVectorQueueService(createMinimalDependencies(db));

    await expect(service.validateApiKeyForSet('set-1')).resolves.toEqual({
      message,
      reason: 'validation-error',
      valid: false,
    });
    expect(checkApiKeyAvailability).not.toHaveBeenCalled();
  });

  it('rejects invalid queue capacity timeout values before querying metadata', async () => {
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => ({ rows: [] })) as VectorQueueDatabase['query'],
    };
    const service = createVectorQueueService(createMinimalDependencies(db));

    await expect(
      service.backfill('set-1', {
        onProgress: vi.fn(),
        queueCapacityTimeoutMs: 0,
      })
    ).rejects.toThrow('queueCapacityTimeoutMs must be a positive integer when configured.');

    expect(db.query).not.toHaveBeenCalled();
  });

  it('delegates queue clearing to the embeddings queue with optional states', async () => {
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => ({ rows: [] })) as VectorQueueDatabase['query'],
    };
    const dependencies = createMinimalDependencies(db);
    const service = createVectorQueueService(dependencies);

    await service.clearQueue(['failed', 'queued']);
    await service.wipeQueue();

    expect(dependencies.jobQueue.clear).toHaveBeenNthCalledWith(1, 'embeddings', [
      'failed',
      'queued',
    ]);
    expect(dependencies.jobQueue.clear).toHaveBeenNthCalledWith(2, 'embeddings');
  });

  it('calculates latency with invalid timestamps clamped to zero milliseconds', () => {
    expect(calculateLatency([])).toBeNull();

    const latency = calculateLatency([
      { runAt: 'not-a-date', updatedAt: 'also-not-a-date' },
      {
        runAt: new Date('2026-06-09T12:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-06-09T12:00:02.000Z').toISOString(),
      },
    ]);

    expect(latency).toEqual({
      avgMs: 1000,
      p50Ms: 2000,
      p95Ms: 2000,
    });
  });
});
