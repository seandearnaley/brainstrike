import type { Job } from '@brainstrike/db';
import { checkApiKeyAvailability } from '@brainstrike/embeddings';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateLatency,
  createVectorQueueService,
  createVectorQueueServiceForRuntime,
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
    id: `job-${index}`,
    queue: 'embeddings',
    jobType: 'embed_chunk',
    payload: job.payload,
    state: 'queued',
    runAt: new Date(0).toISOString(),
    attempts: 0,
    max_attempts: 5,
    backoff_ms: 0,
    lease_token: null,
    leasedUntil: null,
    worker_id: null,
    dedupe_key: job.dedupeKey ?? null,
    error: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  }));
}

function createMinimalDependencies(db: VectorQueueDatabase): VectorQueueServiceDependencies {
  return {
    db,
    jobQueue: {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => []),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    },
    chunkRepository: {
      getCoverageForSet: vi.fn(async () => ({
        totalChunks: 0,
        chunksWithEmbeddingsForSet: 0,
      })),
      clearEmbeddingsForSet: vi.fn(async () => 0),
    },
  };
}

describe('vector-queue-service', () => {
  beforeEach(() => {
    vi.mocked(checkApiKeyAvailability).mockReset();
    vi.mocked(checkApiKeyAvailability).mockResolvedValue({ available: true });
  });

  it('creates the legacy vector queue service only for the pglite runtime', async () => {
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => ({ rows: [] })) as VectorQueueDatabase['query'],
    };
    const dependencies = createMinimalDependencies(db);
    const createPGliteJobQueue = vi.fn(() => dependencies.jobQueue);

    const result = createVectorQueueServiceForRuntime({
      chunkRepository: dependencies.chunkRepository,
      createPGliteJobQueue,
      db,
      runtimeEngine: 'pglite',
    });

    expect(result).toMatchObject({ available: true, reason: null });
    expect(result.service).not.toBeNull();
    expect(createPGliteJobQueue).toHaveBeenCalledWith(db);
    await result.service?.refresh(null);
    expect(dependencies.jobQueue.getQueueStats).toHaveBeenCalledWith('embeddings');
  });

  it('keeps turso runtime out of the pglite-shaped vector queue service', () => {
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => ({ rows: [] })) as VectorQueueDatabase['query'],
    };
    const dependencies = createMinimalDependencies(db);
    const createPGliteJobQueue = vi.fn(() => dependencies.jobQueue);

    const result = createVectorQueueServiceForRuntime({
      chunkRepository: dependencies.chunkRepository,
      createPGliteJobQueue,
      db,
      runtimeEngine: 'turso',
    });

    expect(result).toEqual({
      available: false,
      reason: 'turso-vector-backfill-not-migrated',
      service: null,
    });
    expect(createPGliteJobQueue).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(dependencies.jobQueue.enqueueBatch).not.toHaveBeenCalled();
  });

  it('refresh aggregates queue metrics and latency', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 1, running: 2, failed: 3, succeeded: 4 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
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

  it('refresh can load queue metrics without raw database queries', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 2, running: 1, failed: 0, succeeded: 8 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => {
        throw new Error('refresh must not query the raw database when metrics are injected');
      }) as VectorQueueDatabase['query'],
    };
    const now = Date.now();
    const queueMetricsRepository = {
      loadQueueMetrics: vi.fn(async () => ({
        lastError: 'latest failure',
        latencyRows: [
          {
            runAt: new Date(now - 1500).toISOString(),
            updatedAt: new Date(now).toISOString(),
          },
        ],
        throughput: 6,
      })),
    };
    const backfillRepository: VectorQueueServiceDependencies['backfillRepository'] = {
      countBackfillCandidates: vi.fn(async () => 0),
      getEmbeddingSetQueueCounts: vi.fn(async () => ({
        failed: 4,
        queued: 3,
        running: 2,
        succeeded: 1,
      })),
      loadBackfillCandidateBatch: vi.fn(async () => []),
      loadBackfillCandidateDiagnostics: vi.fn(async () => ({
        chunkCount: 0,
        embeddedChunkCount: 0,
        failedJobs: 0,
        fileCount: 0,
        pendingChunkCount: 0,
        queuedOrRunningJobs: 0,
      })),
      resolveEmbeddingSetJobMetadata: vi.fn(async () => ({
        expectedDimension: 384,
        modelKey: 'local::test-model',
      })),
    };
    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      getCoverageForSet: vi.fn(async () => ({
        totalChunks: 9,
        chunksWithEmbeddingsForSet: 4,
      })),
      clearEmbeddingsForSet: vi.fn(async () => 0),
    };

    const service = createVectorQueueService({
      db,
      jobQueue,
      backfillRepository,
      chunkRepository,
      queueMetricsRepository,
    });

    const snapshot = await service.refresh('set-1');

    expect(queueMetricsRepository.loadQueueMetrics).toHaveBeenCalledWith({
      latencyLimit: 200,
      queue: 'embeddings',
      since: expect.any(String),
    });
    expect(db.query).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      activeSetQueueCounts: { queued: 3, running: 2, failed: 4, succeeded: 1 },
      coverage: { total: 9, withSet: 4 },
      lastError: 'latest failure',
      queueCounts: { queued: 2, running: 1, failed: 0, succeeded: 8 },
      throughput: 6,
    });
    expect(snapshot.latency.p50Ms).toBe(1500);
  });

  it('backfill enqueues chunks with dedupe keys', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 2, running: 1, failed: 0, succeeded: 5 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
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
            rows: [
              {
                modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
                modelId: 'jinaai/jina-embeddings-v2-base-code',
                dimensions: 768,
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
              { id: '1', fileRecordId: '10', contentHash: 'aa' },
              { id: '2', fileRecordId: '11', contentHash: 'bb' },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 2 }],
          } as { rows: unknown[] };
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
        modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
        expectedDimension: 768,
      });
    }
    expect(enqueuedJobs?.map((job) => job.dedupeKey)).toEqual(['1:set-1:aa', '2:set-1:bb']);
    expect(progressUpdates).toEqual([
      { done: 0, total: 2 },
      { done: 2, total: 2 },
    ]);
    expect(counts).toEqual({ queued: 0, running: 0, failed: 0, succeeded: 2 });
  });

  it('backfill can run through an injected storage-neutral repository without raw DB queries', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => {
        throw new Error('raw db query should not be used by backfill repository path');
      }) as VectorQueueDatabase['query'],
    };
    const backfillRepository = {
      countBackfillCandidates: vi.fn(async () => 2),
      getEmbeddingSetQueueCounts: vi
        .fn()
        .mockResolvedValueOnce({ queued: 0, running: 0, failed: 0, succeeded: 0 })
        .mockResolvedValueOnce({ queued: 0, running: 0, failed: 0, succeeded: 2 }),
      loadBackfillCandidateBatch: vi.fn(async () => [
        { id: 'chunk-a', fileRecordId: 'file-a', contentHash: 'hash-a' },
        { id: 'chunk-b', fileRecordId: 'file-b', contentHash: 'hash-b' },
      ]),
      loadBackfillCandidateDiagnostics: vi.fn(async () => ({
        fileCount: 1,
        chunkCount: 2,
        pendingChunkCount: 2,
        embeddedChunkCount: 0,
        queuedOrRunningJobs: 0,
        failedJobs: 0,
      })),
      resolveEmbeddingSetJobMetadata: vi.fn(async () => ({
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        expectedDimension: 384,
      })),
    };
    const service = createVectorQueueService({
      db,
      jobQueue,
      chunkRepository: {
        getCoverageForSet: vi.fn(async () => ({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 })),
        clearEmbeddingsForSet: vi.fn(async () => 0),
      },
      backfillRepository,
    });

    const progressUpdates: Array<{ done: number; total: number }> = [];
    await expect(
      service.backfill('set-1', {
        onProgress: (done, total) => progressUpdates.push({ done, total }),
      })
    ).resolves.toEqual({ queued: 0, running: 0, failed: 0, succeeded: 2 });

    expect(db.query).not.toHaveBeenCalled();
    expect(backfillRepository.resolveEmbeddingSetJobMetadata).toHaveBeenCalledWith('set-1');
    expect(backfillRepository.countBackfillCandidates).toHaveBeenCalledWith('set-1');
    expect(backfillRepository.loadBackfillCandidateBatch).toHaveBeenCalledWith({
      afterChunkId: null,
      embeddingSetId: 'set-1',
      limit: 2,
    });
    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(1);
    expect(progressUpdates).toEqual([
      { done: 0, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  it('loads candidate diagnostics when backfill has no eligible chunks', async () => {
    const capturedLogs: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => {
      if (record.scope === 'VectorQueueService') {
        capturedLogs.push(record);
      }
    });
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    const queries: string[] = [];
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                dimensions: 384,
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
                fileCount: 1,
                chunkCount: 0,
                pendingChunkCount: 0,
                embeddedChunkCount: 0,
                queuedOrRunningJobs: 0,
                failedJobs: 0,
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 0 }],
          } as { rows: unknown[] };
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
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 13 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(async () => 13),
      repairUnclaimableQueued: vi.fn(async () => 13),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                dimensions: 384,
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
                fileCount: 8,
                chunkCount: 13,
                pendingChunkCount: 13,
                embeddedChunkCount: 0,
                queuedOrRunningJobs: 13,
                failedJobs: 13,
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 13 }],
          } as { rows: unknown[] };
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

    await expect(service.backfill('set-1', { onProgress: vi.fn() })).resolves.toEqual({
      queued: 0,
      running: 0,
      failed: 0,
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
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 13, running: 0, failed: 13, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(async () => 13),
      repairUnclaimableQueued: vi.fn(async () => 13),
    };
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => ({ rows: [] })) as VectorQueueDatabase['query'],
    };
    const chunkRepository: VectorQueueServiceDependencies['chunkRepository'] = {
      getCoverageForSet: vi.fn(async () => ({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 })),
      clearEmbeddingsForSet: vi.fn(async () => 0),
    };
    const service = createVectorQueueService({ db, jobQueue, chunkRepository });

    await service.retryFailed(100);

    expect(jobQueue.repairUnclaimableQueued).toHaveBeenCalledWith('embeddings', 100);
    expect(jobQueue.requeueFailed).toHaveBeenCalledWith('embeddings', 100);
  });

  it('backfill splits large enqueue work into cooperative batches', async () => {
    const queueStatsSequence = [
      { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      { queue: 'embeddings', queued: 32, running: 0, failed: 0, succeeded: 0 },
      { queue: 'embeddings', queued: 64, running: 0, failed: 0, succeeded: 0 },
      { queue: 'embeddings', queued: 24, running: 8, failed: 0, succeeded: 0 },
    ];
    const finalQueueStats = {
      queue: 'embeddings',
      queued: 56,
      running: 8,
      failed: 0,
      succeeded: 0,
    };
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [queueStatsSequence.shift() ?? finalQueueStats]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
                modelId: 'jinaai/jina-embeddings-v2-base-code',
                dimensions: 768,
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
                id: `${id}`,
                fileRecordId: `${id + 1000}`,
                contentHash: `hash-${id}`,
              };
            }),
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 96 }],
          } as { rows: unknown[] };
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
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 1, running: 0, failed: 0, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    let setQueueCountCalls = 0;
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                dimensions: 384,
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          return {
            rows: [{ id: '1', fileRecordId: '10', contentHash: 'hash-1' }],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          setQueueCountCalls += 1;
          return {
            rows: [
              setQueueCountCalls === 1
                ? { queued: 0, running: 0, failed: 0, succeeded: 0 }
                : { queued: 0, running: 0, failed: 1, succeeded: 0 },
            ],
          } as { rows: unknown[] };
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

    await expect(service.backfill('set-1', { onProgress: vi.fn() })).rejects.toThrow(
      "Backfill failed for embedding set 'set-1': 1 job(s) failed."
    );
  });

  it('does not fail a new backfill because of historical failed jobs for the same set', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 1, running: 0, failed: 1, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                dimensions: 384,
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          return {
            rows: [{ id: '1', fileRecordId: '10', contentHash: 'hash-1' }],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 1, succeeded: 1 }],
          } as { rows: unknown[] };
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

    await expect(service.backfill('set-1', { onProgress: vi.fn() })).resolves.toEqual({
      queued: 0,
      running: 0,
      failed: 1,
      succeeded: 1,
    });
  });

  it('backfill fails fast when queue capacity never becomes available', async () => {
    vi.useFakeTimers();
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 64, running: 0, failed: 0, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                dimensions: 384,
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
      getCoverageForSet: vi.fn(async () => ({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 })),
      clearEmbeddingsForSet: vi.fn(async () => 0),
    };

    const service = createVectorQueueService({
      db,
      jobQueue,
      chunkRepository,
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
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 64, running: 0, failed: 0, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                dimensions: 384,
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
      getCoverageForSet: vi.fn(async () => ({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 })),
      clearEmbeddingsForSet: vi.fn(async () => 0),
    };

    const service = createVectorQueueService({
      db,
      jobQueue,
      chunkRepository,
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
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 64, running: 0, failed: 0, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                dimensions: 384,
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
      getCoverageForSet: vi.fn(async () => ({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 })),
      clearEmbeddingsForSet: vi.fn(async () => 0),
    };

    const service = createVectorQueueService({
      db,
      jobQueue,
      chunkRepository,
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
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                dimensions: 384,
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          return {
            rows: [{ id: '1', fileRecordId: '10', contentHash: 'hash-1' }],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ queued: 0, running: 1, failed: 0, succeeded: 0 }],
          } as { rows: unknown[] };
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
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                modelKey: 'local::Xenova/all-MiniLM-L6-v2',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                dimensions: 384,
              },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          return {
            rows: [{ id: '1', fileRecordId: '10', contentHash: 'hash-1' }],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ queued: 0, running: 1, failed: 0, succeeded: 0 }],
          } as { rows: unknown[] };
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
      enqueueBatch: vi.fn(async (jobs: MockEnqueueJob[]) => createMockEnqueuedJobs(jobs)),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 3, running: 0, failed: 0, succeeded: 10 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'openai::text-embedding-3-small', modelId: null, dimensions: 1536 }],
          } as { rows: unknown[] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: 3 }] } as { rows: unknown[] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          // Return 3 chunks that need re-embedding
          return {
            rows: [
              { id: '1', fileRecordId: '10', contentHash: 'hash1' },
              { id: '2', fileRecordId: '11', contentHash: 'hash2' },
              { id: '3', fileRecordId: '12', contentHash: 'hash3' },
            ],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 3 }],
          } as { rows: unknown[] };
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
    expect(result.queueCounts).toEqual({ queued: 0, running: 0, failed: 0, succeeded: 3 });

    // Verify progress callbacks were invoked during backfill
    expect(progressUpdates).toEqual([
      { done: 0, total: 3 },
      { done: 3, total: 3 },
    ]);
  });

  it('reembedSet returns zero cleared when no embeddings exist', async () => {
    const jobQueue: VectorQueueServiceDependencies['jobQueue'] = {
      enqueueBatch: vi.fn(async () => []),
      getQueueStats: vi.fn(async () => [
        { queue: 'embeddings', queued: 0, running: 0, failed: 0, succeeded: 0 },
      ]),
      clear: vi.fn(),
      requeueFailed: vi.fn(),
      repairUnclaimableQueued: vi.fn(),
    };

    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'local::test-model', modelId: 'test-model', dimensions: 384 }],
          } as { rows: unknown[] };
        }
        if (sql.includes('embedding_set_id = $2')) {
          return {
            rows: [{ queued: 0, running: 0, failed: 0, succeeded: 0 }],
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

  it('validates API keys through canonical embedding set metadata', async () => {
    vi.mocked(checkApiKeyAvailability).mockResolvedValue({ available: true });
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'openai::text-embedding-3-small', dimensions: '1536' }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };
    const service = createVectorQueueService(createMinimalDependencies(db));

    await expect(service.validateApiKeyForSet('set-1')).resolves.toEqual({ valid: true });

    expect(checkApiKeyAvailability).toHaveBeenCalledWith('openai::text-embedding-3-small');
  });

  it('validates API keys through injected backfill repository metadata without raw DB queries', async () => {
    vi.mocked(checkApiKeyAvailability).mockResolvedValue({ available: true });
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => {
        throw new Error('raw db query should not be used by API key validation repository path');
      }) as VectorQueueDatabase['query'],
    };
    const backfillRepository = {
      countBackfillCandidates: vi.fn(),
      getEmbeddingSetQueueCounts: vi.fn(),
      loadBackfillCandidateBatch: vi.fn(),
      loadBackfillCandidateDiagnostics: vi.fn(),
      resolveEmbeddingSetJobMetadata: vi.fn(async () => ({
        modelKey: 'openai::text-embedding-3-small',
        expectedDimension: 1536,
      })),
    };
    const service = createVectorQueueService({
      ...createMinimalDependencies(db),
      backfillRepository,
    });

    await expect(service.validateApiKeyForSet('set-1')).resolves.toEqual({ valid: true });

    expect(db.query).not.toHaveBeenCalled();
    expect(backfillRepository.resolveEmbeddingSetJobMetadata).toHaveBeenCalledWith('set-1');
    expect(checkApiKeyAvailability).toHaveBeenCalledWith('openai::text-embedding-3-small');
  });

  it('returns unavailable API key validation details from the provider check', async () => {
    vi.mocked(checkApiKeyAvailability).mockResolvedValue({
      available: false,
      provider: 'openai',
      reason: 'missing-provider-key',
      message: 'OpenAI key is missing',
    });
    const db: VectorQueueDatabase = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ modelKey: 'openai::text-embedding-3-small', dimensions: 1536 }],
          } as { rows: unknown[] };
        }
        return { rows: [] } as { rows: unknown[] };
      }) as VectorQueueDatabase['query'],
    };
    const service = createVectorQueueService(createMinimalDependencies(db));

    await expect(service.validateApiKeyForSet('set-1')).resolves.toEqual({
      valid: false,
      reason: 'missing-provider-key',
      message: 'OpenAI key is missing',
    });
  });

  it.each([
    {
      name: 'missing row',
      rows: [],
      message: 'Embedding set set-1 not found',
    },
    {
      name: 'missing model key',
      rows: [{ modelKey: '   ', dimensions: 384 }],
      message: 'Embedding set set-1 is missing model_key metadata',
    },
    {
      name: 'invalid dimensions',
      rows: [{ modelKey: 'local::Xenova/all-MiniLM-L6-v2', dimensions: 0 }],
      message: 'Embedding set set-1 is missing dimension metadata',
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
      valid: false,
      reason: 'validation-error',
      message,
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
