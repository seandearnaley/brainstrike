import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EnqueueEmbeddingBackfillOptions,
  enqueueEmbeddingBackfill,
} from '../../embedding-backfill';
import { EMBEDDING_BACKFILL_CANCELED_MESSAGE } from '../../embedding-host-shared';

interface MockQueueStatsRow {
  failed: number;
  nextRunnableAt?: string | null;
  queue: string;
  queued: number;
  running: number;
  succeeded: number;
}

type QueueRepairFunction = (
  queue?: string,
  limit?: number,
  options?: { embeddingSetId?: string }
) => Promise<number>;

interface RepairableMockQueue {
  repairUnclaimableQueued: QueueRepairFunction;
  requeueFailed: QueueRepairFunction;
}

type EmbeddingBackfillJobQueue = Parameters<typeof enqueueEmbeddingBackfill>[1];

function withQueueRepair<T extends object>(
  jobQueue: T
): T & RepairableMockQueue & EmbeddingBackfillJobQueue {
  const repairableQueue = jobQueue as Partial<RepairableMockQueue>;
  return {
    ...jobQueue,
    repairUnclaimableQueued: repairableQueue.repairUnclaimableQueued ?? vi.fn(async () => 0),
    requeueFailed: repairableQueue.requeueFailed ?? vi.fn(async () => 0),
  } as unknown as T & RepairableMockQueue & EmbeddingBackfillJobQueue;
}

function isBackfillCandidateCountQuery(sql: string): boolean {
  return sql.includes('COUNT(*)::int AS count') && sql.includes('FROM file_chunks');
}

function isDirectEmbeddingSetPendingCountQuery(sql: string): boolean {
  return (
    sql.includes('FROM job_queue') &&
    !sql.includes('FROM file_chunks') &&
    sql.includes("state IN ('queued', 'running')") &&
    sql.includes('embedding_set_id')
  );
}

function isEmbeddingSetCapacityQuery(sql: string): boolean {
  return (
    sql.includes('COUNT(*) FILTER') &&
    sql.includes('embedding_set_id') &&
    !sql.includes("state = 'failed'")
  );
}

function isDimensionIndexMaintenanceQuery(sql: string): boolean {
  return (
    sql.includes('embedding_dimension_index_suspensions') ||
    sql.includes('DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_') ||
    sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_')
  );
}

type EmbeddingBackfillDatabase = Parameters<typeof enqueueEmbeddingBackfill>[0];

function withMaintenanceExec<T extends object>(
  db: T
): T &
  EmbeddingBackfillDatabase & {
    maintenance: { exec: (sql: string, params?: readonly unknown[]) => Promise<unknown> };
  } {
  const query = (
    db as unknown as {
      query: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
    }
  ).query;
  return {
    ...db,
    maintenance: {
      exec: vi.fn((sql: string, params?: readonly unknown[]) => query(sql, params)),
    },
  } as unknown as T &
    EmbeddingBackfillDatabase & {
      maintenance: { exec: (sql: string, params?: readonly unknown[]) => Promise<unknown> };
    };
}

function enqueueTestEmbeddingBackfill(
  db: object,
  jobQueue: Parameters<typeof enqueueEmbeddingBackfill>[1],
  embeddingSetId: string,
  onProgress: (done: number, total: number) => void,
  options?: EnqueueEmbeddingBackfillOptions
) {
  return enqueueEmbeddingBackfill(
    withMaintenanceExec(db),
    jobQueue,
    embeddingSetId,
    onProgress,
    options
  );
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
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          return { rows: [{ count: 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          return { rows: [{ count: 1 }] };
        }
        if (isEmbeddingSetCapacityQuery(sql)) {
          statsCalls += 1;
          if (statsCalls > 1) {
            currentTime = 11;
          }
          return { rows: [{ queued: 1, running: 0 }] };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 1, running: 0, succeeded: 0 }],
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(),
    };

    const backfill = expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
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
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 1, succeeded: 0 }],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          pendingCountCalls += 1;
          if (pendingCountCalls > 1) {
            currentTime = 11;
          }
          return { rows: [{ count: pendingCountCalls > 2 ? 0 : 1 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      ]),
    };

    const backfill = expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
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
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 96 }],
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
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
                contentHash: `hash-${id}`,
                fileRecordId: String(id + 1000),
                id: String(id),
              };
            }),
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };

    const statsSequence: MockQueueStatsRow[] = [
      { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      { failed: 0, queue: 'embeddings', queued: 32, running: 0, succeeded: 0 },
      { failed: 0, queue: 'embeddings', queued: 64, running: 0, succeeded: 0 },
      { failed: 0, queue: 'embeddings', queued: 24, running: 8, succeeded: 0 },
    ];
    const finalStats = { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 96 };

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
    const counts = await enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
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
    expect(counts).toEqual({ failed: 0, queued: 0, running: 0, succeeded: 96 });
  });

  it('drains existing scoped jobs before running global candidate scans', async () => {
    const queryOrder: string[] = [];
    let pendingCountCalls = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          queryOrder.push('metadata');
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (
          sql.includes("state IN ('queued', 'running')") &&
          sql.includes('embedding_set_id = $2')
        ) {
          queryOrder.push('pending');
          pendingCountCalls += 1;
          return { rows: [{ count: pendingCountCalls === 1 ? 64 : 0 }] };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          queryOrder.push('final-counts');
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 64 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          queryOrder.push('candidate-count');
          return { rows: [{ count: 0 }] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        { failed: 0, queue: 'embeddings', queued: 64, running: 0, succeeded: 0 },
      ]),
    };

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        backlogPollMs: 1,
      })
    ).resolves.toEqual({ failed: 0, queued: 0, running: 0, succeeded: 64 });

    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
    expect(queryOrder).toEqual([
      'metadata',
      'pending',
      'pending',
      'final-counts',
      'candidate-count',
    ]);
  });

  it('continues scanning and enqueuing candidates after existing scoped jobs drain', async () => {
    const queryOrder: string[] = [];
    let pendingCountCalls = 0;
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          queryOrder.push('metadata');
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          queryOrder.push('pending');
          pendingCountCalls += 1;
          return { rows: [{ count: pendingCountCalls === 1 ? 2 : 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          queryOrder.push('candidate-count');
          return { rows: [{ count: 2 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          queryOrder.push('candidate-batch');
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: [
              { contentHash: 'hash-10', fileRecordId: '110', id: '10' },
              { contentHash: 'hash-11', fileRecordId: '111', id: '11' },
            ],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          queryOrder.push(isEmbeddingSetCapacityQuery(sql) ? 'capacity-counts' : 'final-counts');
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 4 }],
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(async (jobs: Record<string, unknown>[]) =>
        jobs.map((job, index) => ({
          id: `job-after-drain-${index}`,
          ...job,
        }))
      ),
      getQueueStats: vi.fn(async () => [
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      ]),
    };
    const progressUpdates: Array<{ done: number; total: number }> = [];

    const counts = await enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
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

    expect(jobQueue.enqueueBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        dedupeKey: '10:set-123:hash-10',
        payload: expect.objectContaining({ chunkId: '10', embeddingSetId: 'set-123' }),
      }),
      expect.objectContaining({
        dedupeKey: '11:set-123:hash-11',
        payload: expect.objectContaining({ chunkId: '11', embeddingSetId: 'set-123' }),
      }),
    ]);
    expect(progressUpdates).toEqual([
      { done: 0, total: 2 },
      { done: 2, total: 4 },
      { done: 4, total: 4 },
    ]);
    expect(queryOrder).toEqual([
      'metadata',
      'pending',
      'pending',
      'final-counts',
      'candidate-count',
      'capacity-counts',
      'candidate-batch',
      'pending',
      'final-counts',
    ]);
    expect(counts).toEqual({ failed: 0, queued: 0, running: 0, succeeded: 4 });
  });

  it('suspends dimension HNSW maintenance during scoped backfill and rebuilds after drain', async () => {
    const queryOrder: string[] = [];
    let pendingCountCalls = 0;
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          queryOrder.push('metadata');
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('INSERT INTO embedding_dimension_index_suspensions')) {
          queryOrder.push('suspend-index');
          expect(params).toEqual([384, 'embedding-backfill:set-123', expect.any(String)]);
          return { rows: [] };
        }
        if (sql.includes('DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('drop-index');
          return { rows: [] };
        }
        if (sql.includes('FROM file_chunks WHERE embedding IS NOT NULL')) {
          // Benchmark-scale row count so the rebuild engages the
          // maintenance_work_mem tuning path around the CREATE INDEX.
          queryOrder.push('estimate-embedded-rows');
          return { rows: [{ count: '200000' }] };
        }
        // Order matters: 'RESET maintenance_work_mem' contains the substring
        // 'SET maintenance_work_mem'.
        if (sql.includes('RESET maintenance_work_mem')) {
          queryOrder.push('reset-index-memory');
          return { rows: [] };
        }
        if (sql.includes('SET maintenance_work_mem')) {
          queryOrder.push('tune-index-memory');
          return { rows: [] };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          queryOrder.push('pending');
          pendingCountCalls += 1;
          return { rows: [{ count: pendingCountCalls === 1 ? 0 : 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          queryOrder.push('candidate-count');
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          queryOrder.push('candidate-batch');
          return {
            rows: [{ contentHash: 'hash-10', fileRecordId: '110', id: '10' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          queryOrder.push(isEmbeddingSetCapacityQuery(sql) ? 'capacity-counts' : 'final-counts');
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 1 }],
          };
        }
        if (sql.startsWith('VACUUM')) {
          queryOrder.push(sql.includes('file_chunks') ? 'vacuum-chunks' : 'vacuum-jobs');
          return { rows: [] };
        }
        if (sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('rebuild-index');
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM embedding_dimension_index_suspensions')) {
          queryOrder.push('resume-index');
          expect(params).toEqual([384]);
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      ]),
    };

    const maintenanceDb = withMaintenanceExec(db);

    await expect(
      enqueueEmbeddingBackfill(
        maintenanceDb,
        withQueueRepair(jobQueue),
        'set-123',
        () => undefined,
        {
          backlogPollMs: 1,
          maxQueueDepth: 64,
        }
      )
    ).resolves.toEqual({ failed: 0, queued: 0, running: 0, succeeded: 1 });

    expect(queryOrder).toEqual([
      'metadata',
      'suspend-index',
      'drop-index',
      'pending',
      'candidate-count',
      'capacity-counts',
      'candidate-batch',
      'pending',
      'final-counts',
      'estimate-embedded-rows',
      'tune-index-memory',
      'rebuild-index',
      'reset-index-memory',
      'resume-index',
    ]);
    // maintenance_work_mem is session-local: the SET/RESET around the build
    // MUST ride the same maintenance channel as the CREATE INDEX, or a future
    // dedicated maintenance connection would silently run the build untuned.
    const maintenanceStatements = vi
      .mocked(maintenanceDb.maintenance.exec)
      .mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
    expect(maintenanceStatements).toEqual([
      expect.stringContaining("SET maintenance_work_mem = '"),
      expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384'),
      'RESET maintenance_work_mem',
    ]);
  });

  it('can leave dimension HNSW rebuild suspended after a background indexing drain', async () => {
    const queryOrder: string[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          queryOrder.push('metadata');
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('INSERT INTO embedding_dimension_index_suspensions')) {
          queryOrder.push('suspend-index');
          expect(params).toEqual([384, 'embedding-backfill:set-123', expect.any(String)]);
          return { rows: [] };
        }
        if (sql.includes('DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('drop-index');
          return { rows: [] };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          queryOrder.push('pending');
          return { rows: [{ count: 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          queryOrder.push('candidate-count');
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          queryOrder.push('candidate-batch');
          return {
            rows: [{ contentHash: 'hash-10', fileRecordId: '110', id: '10' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          queryOrder.push(isEmbeddingSetCapacityQuery(sql) ? 'capacity-counts' : 'final-counts');
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 1 }],
          };
        }
        if (sql.startsWith('VACUUM')) {
          queryOrder.push(sql.includes('file_chunks') ? 'vacuum-chunks' : 'vacuum-jobs');
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO embedding_dimension_index_maintenance')) {
          queryOrder.push('request-maintenance');
          expect(params).toEqual([
            384,
            'embedding-backfill:set-123',
            'regular',
            expect.any(String),
          ]);
          return { rows: [] };
        }
        if (sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('rebuild-index');
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM embedding_dimension_index_suspensions')) {
          queryOrder.push('resume-index');
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      ]),
    };

    const maintenanceDb = withMaintenanceExec(db);

    await expect(
      enqueueEmbeddingBackfill(
        maintenanceDb,
        withQueueRepair(jobQueue),
        'set-123',
        () => undefined,
        {
          backlogPollMs: 1,
          dimensionIndexMaintenanceStrategy: 'regular',
          maxQueueDepth: 64,
          rebuildDimensionIndexOnCompletion: false,
        }
      )
    ).resolves.toEqual({ failed: 0, queued: 0, running: 0, succeeded: 1 });

    expect(queryOrder).toEqual([
      'metadata',
      'suspend-index',
      'drop-index',
      'pending',
      'candidate-count',
      'capacity-counts',
      'candidate-batch',
      'pending',
      'final-counts',
      'request-maintenance',
    ]);
    expect(maintenanceDb.maintenance.exec).not.toHaveBeenCalledWith(
      expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384'),
      undefined
    );
  });

  it('restores dimension HNSW maintenance when a suspended backfill is canceled', async () => {
    const queryOrder: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          queryOrder.push('metadata');
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('INSERT INTO embedding_dimension_index_suspensions')) {
          queryOrder.push('suspend-index');
          return { rows: [] };
        }
        if (sql.includes('DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('drop-index');
          return { rows: [] };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          queryOrder.push('pending');
          return { rows: [{ count: 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          queryOrder.push('candidate-count');
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('rebuild-index');
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM embedding_dimension_index_suspensions')) {
          queryOrder.push('resume-index');
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO embedding_dimension_index_maintenance')) {
          queryOrder.push('request-maintenance');
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(),
    };

    const maintenanceDb = withMaintenanceExec(db);

    await expect(
      enqueueEmbeddingBackfill(
        maintenanceDb,
        withQueueRepair(jobQueue),
        'set-123',
        () => undefined,
        {
          assertCanContinue: () => {
            throw new Error(EMBEDDING_BACKFILL_CANCELED_MESSAGE);
          },
          backlogPollMs: 1,
          maxQueueDepth: 64,
        }
      )
    ).rejects.toThrow(EMBEDDING_BACKFILL_CANCELED_MESSAGE);

    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
    expect(queryOrder).toEqual([
      'metadata',
      'suspend-index',
      'drop-index',
      'pending',
      'candidate-count',
      'pending',
      'rebuild-index',
      'resume-index',
    ]);
    expect(maintenanceDb.maintenance.exec).toHaveBeenCalledWith(
      expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384'),
      undefined
    );
  });

  it('defers the dimension HNSW rebuild until canceled backfill scoped jobs drain', async () => {
    const queryOrder: string[] = [];
    let pendingJobs = 2;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          queryOrder.push('metadata');
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('INSERT INTO embedding_dimension_index_suspensions')) {
          queryOrder.push('suspend-index');
          return { rows: [] };
        }
        if (sql.includes('DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('drop-index');
          return { rows: [] };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          queryOrder.push('pending');
          return { rows: [{ count: pendingJobs }] };
        }
        if (sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('rebuild-index');
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM embedding_dimension_index_suspensions')) {
          queryOrder.push('resume-index');
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO embedding_dimension_index_maintenance')) {
          queryOrder.push('request-maintenance');
          return { rows: [] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql) || sql.includes('COUNT(*) FILTER')) {
          return { rows: [{ failed: 0, queued: 2, running: 0, succeeded: 0 }] };
        }

        throw new Error('Unexpected query: ');
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(),
    };

    const maintenanceDb = withMaintenanceExec(db);

    await expect(
      enqueueEmbeddingBackfill(
        maintenanceDb,
        withQueueRepair(jobQueue),
        'set-123',
        () => undefined,
        {
          assertCanContinue: () => {
            throw new Error(EMBEDDING_BACKFILL_CANCELED_MESSAGE);
          },
          backlogPollMs: 1,
          dimensionIndexMaintenanceStrategy: 'regular',
          drainTimeoutMs: 10,
          maxQueueDepth: 64,
        }
      )
    ).rejects.toThrow(EMBEDDING_BACKFILL_CANCELED_MESSAGE);

    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
    expect(queryOrder).toEqual([
      'metadata',
      'suspend-index',
      'drop-index',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);

    pendingJobs = 0;
    await vi.waitFor(() => {
      expect(queryOrder).toContain('resume-index');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(queryOrder).toContain('rebuild-index');
    expect(queryOrder).toContain('resume-index');
    expect(maintenanceDb.maintenance.exec).toHaveBeenCalledWith(
      expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384'),
      undefined
    );
  });

  it('leaves deferred canceled background indexing HNSW rebuild suspended after scoped jobs drain', async () => {
    const queryOrder: string[] = [];
    let pendingJobs = 2;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          queryOrder.push('metadata');
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('INSERT INTO embedding_dimension_index_suspensions')) {
          queryOrder.push('suspend-index');
          return { rows: [] };
        }
        if (sql.includes('DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('drop-index');
          return { rows: [] };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          queryOrder.push('pending');
          return { rows: [{ count: pendingJobs }] };
        }
        if (sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('rebuild-index');
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM embedding_dimension_index_suspensions')) {
          queryOrder.push('resume-index');
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO embedding_dimension_index_maintenance')) {
          queryOrder.push('request-maintenance');
          return { rows: [] };
        }
        if (sql.startsWith('VACUUM')) {
          queryOrder.push(sql.includes('file_chunks') ? 'vacuum-chunks' : 'vacuum-jobs');
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql) || sql.includes('COUNT(*) FILTER')) {
          return { rows: [{ failed: 0, queued: 2, running: 0, succeeded: 0 }] };
        }

        throw new Error('Unexpected query: ');
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(),
    };

    const maintenanceDb = withMaintenanceExec(db);

    await expect(
      enqueueEmbeddingBackfill(
        maintenanceDb,
        withQueueRepair(jobQueue),
        'set-123',
        () => undefined,
        {
          assertCanContinue: () => {
            throw new Error(EMBEDDING_BACKFILL_CANCELED_MESSAGE);
          },
          backlogPollMs: 1,
          dimensionIndexMaintenanceStrategy: 'regular',
          drainTimeoutMs: 10,
          maxQueueDepth: 64,
          rebuildDimensionIndexOnCompletion: false,
        }
      )
    ).rejects.toThrow(EMBEDDING_BACKFILL_CANCELED_MESSAGE);

    const pendingChecksBeforeDrain = queryOrder.filter((event) => event === 'pending').length;
    pendingJobs = 0;
    await vi.waitFor(() => {
      expect(queryOrder).toContain('request-maintenance');
    });
    expect(queryOrder.filter((event) => event === 'pending')).toHaveLength(
      pendingChecksBeforeDrain + 1
    );
    expect(queryOrder).not.toContain('vacuum-chunks');
    expect(queryOrder).not.toContain('vacuum-jobs');
    expect(queryOrder).not.toContain('rebuild-index');
    expect(queryOrder).not.toContain('resume-index');
    expect(maintenanceDb.maintenance.exec).not.toHaveBeenCalledWith(
      expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384'),
      undefined
    );
  });

  it('runs drain maintenance while draining existing scoped jobs before candidate scans', async () => {
    const pendingCounts = [2, 1, 0];
    const succeededCounts = [1, 3];
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          return { rows: [{ count: pendingCounts.shift() ?? 0 }] };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [
              {
                failed: 0,
                queued: 0,
                running: 0,
                succeeded: succeededCounts.shift() ?? 3,
              },
            ],
          };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        { failed: 0, queue: 'embeddings', queued: 2, running: 0, succeeded: 0 },
      ]),
    };
    const drainTicks: number[] = [];

    await enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
      backlogPollMs: 1,
      onDrainTick: async (completedSinceLastTick) => {
        drainTicks.push(completedSinceLastTick);
      },
    });

    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
    expect(drainTicks).toEqual([1, 2]);
  });

  it('repairs scoped queued jobs before counting candidates without requeueing terminal failures', async () => {
    let repairedBeforeCandidateCount = false;
    let queuedRepaired = false;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && sql.includes('FROM file_chunks')) {
          repairedBeforeCandidateCount = queuedRepaired;
          return { rows: [{ count: 0 }] };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 0 }],
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };

    const jobQueue = {
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => [
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      ]),
      repairUnclaimableQueued: vi.fn(async () => {
        queuedRepaired = true;
        return 1;
      }),
      requeueFailed: vi.fn(async () => 2),
    };

    await enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
    });

    expect(jobQueue.repairUnclaimableQueued).toHaveBeenCalledWith('embeddings', 1000, {
      embeddingSetId: 'set-123',
    });
    expect(jobQueue.requeueFailed).not.toHaveBeenCalled();
    expect(repairedBeforeCandidateCount).toBe(true);
  });

  it('preserves the full provider model suffix when model keys contain additional separators', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::model::variant' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 1 }],
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
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
            rows: [{ contentHash: 'hash-1', fileRecordId: '101', id: '1' }],
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 1 },
      ]),
    };

    await enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
    });

    expect(jobQueue.enqueueBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        payload: expect.objectContaining({
          embeddingInputHash: 'bb103e93e8a03ee38185fef46f8b8b8736de603d16296c91c9e20fc27eddef88',
          modelKey: 'local::model::variant',
          sourceContentHash: 'hash-1',
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
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        maxQueueDepth: 0,
      })
    ).rejects.toThrow('maxQueueDepth must be a positive integer when configured.');

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        backlogPollMs: 0,
      })
    ).rejects.toThrow('backlogPollMs must be a positive integer when configured.');

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        queueCapacityTimeoutMs: 0,
      })
    ).rejects.toThrow('queueCapacityTimeoutMs must be a positive integer when configured.');

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        drainTimeoutMs: 0,
      })
    ).rejects.toThrow('drainTimeoutMs must be a positive integer when configured.');

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        progressIntervalMs: 0,
      })
    ).rejects.toThrow('progressIntervalMs must be a positive integer when configured.');
  });

  it('does not report 100% progress before deduplicated work has drained', async () => {
    let pendingCountCalls = 0;
    const progressUpdates: Array<{ done: number; total: number }> = [];
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 4 }],
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
          pendingCountCalls += 1;
          if (pendingCountCalls === 2) {
            expect(progressUpdates).not.toContainEqual({ done: 4, total: 4 });
          }
          return { rows: [{ count: pendingCountCalls === 2 ? 4 : 0 }] };
        }
        if (sql.includes('COUNT(*)::int AS count')) {
          return { rows: [{ count: sql.includes('FROM file_chunks') ? 4 : 0 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 4 }, (_, index) => ({
              contentHash: `hash-${index + 1}`,
              fileRecordId: String(index + 101),
              id: String(index + 1),
            })),
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };

    const jobQueue = {
      enqueueBatch: vi.fn(async (jobs: unknown[]) => jobs),
      getQueueStats: vi.fn(async () => [
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      ]),
    };

    await enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
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
    expect(pendingCountCalls).toBeGreaterThanOrEqual(2);
  });

  it('throttles intermediate progress updates while still flushing completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T00:00:00.000Z'));
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 96 }],
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
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
                contentHash: `hash-${id}`,
                fileRecordId: String(id + 1000),
                id: String(id),
              };
            }),
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      ]),
    };

    const progressUpdates: Array<{ done: number; total: number }> = [];
    const backfillPromise = enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
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

    await vi.waitFor(() => {
      expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(3);
    });
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
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 2 }],
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
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
                contentHash: `hash-${id}`,
                fileRecordId: String(id + 100),
                id: String(id),
              };
            }),
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };

    const jobQueue = {
      enqueueBatch: vi.fn(async () => []),
      getQueueStats: vi.fn(async () => [
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      ]),
    };

    await enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
      progressIntervalBatches: 1,
      progressIntervalMs: 1,
    });

    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(2);
    const capacityQueries = vi
      .mocked(db.query)
      .mock.calls.filter(([sql]) => isEmbeddingSetCapacityQuery(sql));
    expect(capacityQueries).toHaveLength(1);
    expect(jobQueue.getQueueStats).not.toHaveBeenCalled();
  });

  it('aborts backfill when the embedding host can no longer accept queued work', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (isEmbeddingSetCapacityQuery(sql)) {
          return {
            rows: [{ queued: 0, running: 0 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 64, running: 0, succeeded: 0 }],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          return { rows: [{ count: 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
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
                contentHash: `hash-${id}`,
                fileRecordId: String(id + 1000),
                id: String(id),
              };
            }),
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
          { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
        ])
        .mockResolvedValue([
          { failed: 0, queue: 'embeddings', queued: 64, running: 0, succeeded: 0 },
        ]),
    };

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        assertCanContinue: () => {
          if (vi.mocked(jobQueue.enqueueBatch).mock.calls.length >= 1) {
            throw new Error('Embedding host entered an error state during backfill.');
          }
        },
        backlogPollMs: 1,
        maxQueueDepth: 64,
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
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 4 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && sql.includes('FROM file_chunks')) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 4 }, (_, index) => ({
              contentHash: `hash-${index + 1}`,
              fileRecordId: String(index + 100),
              id: String(index + 1),
            })),
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
          return { rows: [{ count: pendingCounts.shift() ?? 0 }] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 4 },
      ]),
    };

    await enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
      backlogPollMs: 1,
      maxQueueDepth: 64,
      progressIntervalBatches: 1,
    });

    expect(
      vi
        .mocked(db.query)
        .mock.calls.filter(
          ([sql]) =>
            String(sql).includes('FROM job_queue') &&
            !String(sql).includes('FROM file_chunks') &&
            String(sql).includes('embedding_set_id') &&
            !String(sql).includes('COUNT(*) FILTER')
        ).length
    ).toBe(3);
  });

  it('treats an already-drained queue as complete before failing host-health checks', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 2 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && sql.includes('FROM file_chunks')) {
          return { rows: [{ count: 2 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 2 }, (_, index) => ({
              contentHash: `hash-${index + 1}`,
              fileRecordId: String(index + 100),
              id: String(index + 1),
            })),
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 2 },
      ]),
    };

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        assertCanContinue: () => {
          if (vi.mocked(jobQueue.enqueueBatch).mock.calls.length >= 1) {
            throw new Error('Embedding host stopped while backfill was in progress.');
          }
        },
        backlogPollMs: 1,
        maxQueueDepth: 64,
      })
    ).resolves.toEqual({ failed: 0, queued: 0, running: 0, succeeded: 2 });
  });

  it('reports only succeeded deltas to drain maintenance callbacks', async () => {
    const pendingCounts = [3, 2, 1, 0];
    const succeededCounts = [1, 1, 3];
    let pendingCountCalls = 0;
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [
              {
                failed: 0,
                queued: 0,
                running: pendingCounts[0] ?? 0,
                succeeded: succeededCounts.shift() ?? 3,
              },
            ],
          };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          return { rows: [{ count: 3 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 3 }, (_, index) => ({
              contentHash: `hash-${index + 1}`,
              fileRecordId: String(index + 100),
              id: String(index + 1),
            })),
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          pendingCountCalls += 1;
          if (pendingCountCalls === 1) {
            return { rows: [{ count: 0 }] };
          }
          return { rows: [{ count: pendingCounts.shift() ?? 0 }] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 3 },
      ]),
    };

    const drainTicks: number[] = [];
    await enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
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
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: pendingCounts[0] ?? 0, succeeded: 1 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && sql.includes('FROM file_chunks')) {
          return { rows: [{ count: 2 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 2 }, (_, index) => ({
              contentHash: `hash-${index + 1}`,
              fileRecordId: String(index + 100),
              id: String(index + 1),
            })),
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
          return { rows: [{ count: pendingCounts.shift() ?? 0 }] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 2 },
      ]),
    };

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        onDrainTick: async () => {
          throw new Error('maintenance failed');
        },
      })
    ).resolves.toEqual({ failed: 0, queued: 0, running: 0, succeeded: 1 });
  });

  it('fails when the embedding set drain completes with failed jobs', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 2, queued: 0, running: 0, succeeded: 2 }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && sql.includes('FROM file_chunks')) {
          return { rows: [{ count: 4 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 4 }, (_, index) => ({
              contentHash: `hash-${index + 1}`,
              fileRecordId: String(index + 100),
              id: String(index + 1),
            })),
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 4 },
      ]),
    };

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
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
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*)::int AS count') && sql.includes('FROM file_chunks')) {
          return { rows: [{ count: 4 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 4 }, (_, index) => ({
              contentHash: `hash-${index + 1}`,
              fileRecordId: String(index + 100),
              id: String(index + 1),
            })),
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id') &&
          !sql.includes('COUNT(*) FILTER')
        ) {
          return { rows: [{ count: 0 }] };
        }
        if (isEmbeddingSetCapacityQuery(sql)) {
          return {
            rows: [{ queued: 0, running: 0 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          expect(params?.[2]).toEqual(expect.any(String));
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 4 }],
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 3, queue: 'embeddings', queued: 0, running: 0, succeeded: 40 },
      ]),
    };

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        progressIntervalBatches: 1,
      })
    ).resolves.toEqual({ failed: 0, queued: 0, running: 0, succeeded: 4 });
  });

  it('fails fast when queue capacity never becomes available', async () => {
    vi.useFakeTimers();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          return { rows: [{ count: 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 64, running: 0, succeeded: 0 }],
          };
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
        { failed: 0, queue: 'embeddings', queued: 64, running: 0, succeeded: 0 },
      ]),
    };

    const backfillPromise = enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
      'set-123',
      () => undefined,
      {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        queueCapacityTimeoutMs: 50,
      }
    );
    const rejection = expect(backfillPromise).rejects.toThrow(
      'Backfill timed out while waiting for queue capacity below 64 jobs (queued=64, running=0, failed=0, succeeded=0).'
    );

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(jobQueue.enqueueBatch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Regression: the capacity deadline used to be plain wall-clock, so a large
  // collection failed purely because the embedding worker — the ONLY thing that
  // can lower queue depth, and something this loop neither owns nor paces — took
  // longer than the budget. The deadline now measures consumer liveness: every
  // completed job restarts it, and it only expires when the worker has completed
  // nothing at all, which is the one condition waiting longer cannot resolve.
  it('keeps waiting for queue capacity while the embedding worker keeps completing jobs', async () => {
    let capacityCalls = 0;
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return { rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }] };
        }
        if (isEmbeddingSetCapacityQuery(sql)) {
          capacityCalls += 1;
          // Depth stays pinned for the first five polls while `succeeded` keeps
          // advancing — a slow but demonstrably live consumer.
          return {
            rows: [
              {
                queued: capacityCalls <= 5 ? 1 : 0,
                running: 0,
                succeeded: capacityCalls,
              },
            ],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return { rows: [{ failed: 0, queued: 0, running: 0, succeeded: 1 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return { rows: [{ contentHash: 'hash-1', fileRecordId: '101', id: '1' }] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(async (jobs: Record<string, unknown>[]) =>
        jobs.map((job, index) => ({ id: `job-${index}`, ...job }))
      ),
    };

    const result = await enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
      'set-123',
      () => undefined,
      {
        backlogPollMs: 1,
        maxQueueDepth: 1,
        // Deliberately shorter than the total wait this test forces: a wall-clock
        // budget would have thrown before capacity ever freed.
        queueCapacityTimeoutMs: 5,
      }
    );

    expect(capacityCalls).toBeGreaterThan(5);
    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ failed: 0, queued: 0, running: 0, succeeded: 1 });
  });

  it('names the stalled consumer when the queue capacity deadline expires', async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return { rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }] };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          return { rows: [{ count: 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          // `succeeded` never advances: the consumer is not running at all.
          return { rows: [{ failed: 0, queued: 64, running: 0, succeeded: 0 }] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair({}), 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        queueCapacityTimeoutMs: 5,
      })
    ).rejects.toThrow(/The embedding worker completed no jobs for 5ms/u);
  });

  it('admits a scoped backfill while unrelated embedding sets fill the shared queue', async () => {
    let pendingCountCalls = 0;
    const queryOrder: string[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          queryOrder.push('metadata');
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          pendingCountCalls += 1;
          queryOrder.push('pending');
          return { rows: [{ count: 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          queryOrder.push('candidate-count');
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          queryOrder.push('candidate-batch');
          return {
            rows: [{ contentHash: 'hash-1', fileRecordId: '100', id: '1' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          expect(params?.[1]).toBe('set-123');
          const updatedAfter = params?.[2];
          queryOrder.push(updatedAfter ? 'final-counts' : 'capacity-counts');
          return {
            rows: [
              updatedAfter
                ? { failed: 0, queued: 0, running: 0, succeeded: 1 }
                : { failed: 0, queued: 0, running: 0, succeeded: 0 },
            ],
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
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
        { failed: 0, queue: 'embeddings', queued: 103, running: 2, succeeded: 22 },
      ]),
    };

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        queueCapacityTimeoutMs: 10,
      })
    ).resolves.toEqual({ failed: 0, queued: 0, running: 0, succeeded: 1 });

    expect(pendingCountCalls).toBeGreaterThanOrEqual(2);
    expect(jobQueue.getQueueStats).not.toHaveBeenCalled();
    expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(1);
    expect(jobQueue.enqueueBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        runAt: new Date(0).toISOString(),
      }),
    ]);
    expect(queryOrder).toEqual(
      expect.arrayContaining([
        'metadata',
        'candidate-count',
        'capacity-counts',
        'candidate-batch',
        'final-counts',
      ])
    );
  });

  it('restores the dimension HNSW index before surfacing a post-suspension enqueue failure', async () => {
    const queryOrder: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          queryOrder.push('metadata');
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('INSERT INTO embedding_dimension_index_suspensions')) {
          queryOrder.push('suspend-index');
          return { rows: [] };
        }
        if (sql.includes('DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('drop-index');
          return { rows: [] };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          queryOrder.push('pending');
          return { rows: [{ count: 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          queryOrder.push('candidate-count');
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 0 }],
          };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          queryOrder.push('candidate-batch');
          return {
            rows: [{ contentHash: 'hash-1', fileRecordId: '100', id: '1' }],
          };
        }
        if (sql.includes('FROM file_chunks WHERE embedding IS NOT NULL')) {
          return { rows: [{ count: '0' }] };
        }
        if (sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')) {
          queryOrder.push('rebuild-index');
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM embedding_dimension_index_suspensions')) {
          queryOrder.push('resume-index');
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(async () => {
        throw new Error('producer fault');
      }),
      getQueueStats: vi.fn(),
    };

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 64,
      })
    ).rejects.toThrow('producer fault');

    expect(queryOrder).toEqual([
      'metadata',
      'suspend-index',
      'drop-index',
      'pending',
      'candidate-count',
      'candidate-batch',
      'pending',
      'rebuild-index',
      'resume-index',
    ]);
  });

  it('preserves the original backfill failure when dimension index recovery also fails', async () => {
    let pendingCountCalls = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          pendingCountCalls += 1;
          if (pendingCountCalls > 1) {
            throw new Error('recovery database fault');
          }
          return { rows: [{ count: 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 0 }],
          };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          return {
            rows: [{ contentHash: 'hash-1', fileRecordId: '100', id: '1' }],
          };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const jobQueue = {
      enqueueBatch: vi.fn(async () => {
        throw new Error('producer fault');
      }),
      getQueueStats: vi.fn(),
    };

    await expect(
      enqueueTestEmbeddingBackfill(db, withQueueRepair(jobQueue), 'set-123', () => undefined, {
        backlogPollMs: 1,
        maxQueueDepth: 64,
      })
    ).rejects.toThrow('producer fault');

    expect(pendingCountCalls).toBe(2);
  });

  it('fails fast when the embedding set never drains', async () => {
    vi.useFakeTimers();
    let pendingCountCalls = 0;
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [{ failed: 0, queued: 0, running: 1, succeeded: 0 }],
          };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: [{ contentHash: 'hash-1', fileRecordId: '100', id: '1' }],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          pendingCountCalls += 1;
          return { rows: [{ count: pendingCountCalls === 1 ? 0 : 1 }] };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      ]),
    };

    const backfillPromise = enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
      'set-123',
      () => undefined,
      {
        backlogPollMs: 1,
        drainTimeoutMs: 50,
        maxQueueDepth: 64,
      }
    );
    const rejection = expect(backfillPromise).rejects.toThrow(
      "Backfill timed out while waiting for embedding set 'set-123' to drain."
    );

    await vi.waitFor(() => {
      expect(jobQueue.enqueueBatch).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
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
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (isEmbeddingSetCapacityQuery(sql)) {
          return {
            rows: [{ queued: 0, running: 0 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          const succeeded =
            drainSucceededCounts[Math.min(drainSucceededIndex, drainSucceededCounts.length - 1)];
          drainSucceededIndex += 1;
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded }],
          };
        }
        if (isDirectEmbeddingSetPendingCountQuery(sql)) {
          pendingCountCalls += 1;
          if (pendingCountCalls === 1) {
            return { rows: [{ count: 0 }] };
          }
          if (pendingCountCalls === 2) {
            return { rows: [{ count: 2 }] };
          }
          if (pendingCountCalls === 3) {
            return { rows: [{ count: 1 }] };
          }
          return { rows: [{ count: 0 }] };
        }
        if (isBackfillCandidateCountQuery(sql)) {
          return { rows: [{ count: 3 }] };
        }
        if (sql.includes('ORDER BY c.id::text ASC')) {
          const afterChunkId = typeof params?.[2] === 'string' ? params[2] : null;
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: Array.from({ length: 3 }, (_, index) => ({
              contentHash: `hash-${index + 1}`,
              fileRecordId: String(index + 100),
              id: String(index + 1),
            })),
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
        { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      ]),
    };

    const drainDeltas: number[] = [];
    const result = await enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
      'set-123',
      () => undefined,
      {
        backlogPollMs: 1,
        maxQueueDepth: 64,
        onDrainTick: async (completedSinceLastTick) => {
          drainDeltas.push(completedSinceLastTick);
        },
        progressIntervalBatches: 1,
        progressIntervalMs: 1,
      }
    );

    expect(drainDeltas).toEqual([2, 1]);
    expect(result).toEqual({ failed: 0, queued: 0, running: 0, succeeded: 3 });
  });

  it('reports drain progress while waiting for queue capacity between enqueue passes', async () => {
    let capacityCountCalls = 0;
    let pendingCountCalls = 0;
    let succeededCountCalls = 0;

    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (isEmbeddingSetCapacityQuery(sql)) {
          capacityCountCalls += 1;
          return {
            rows: [{ queued: capacityCountCalls === 2 ? 1 : 0, running: 0 }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          succeededCountCalls += 1;
          if (succeededCountCalls === 1) {
            return {
              rows: [{ failed: 0, queued: 1, running: 0, succeeded: 1 }],
            };
          }
          return {
            rows: [{ failed: 0, queued: 0, running: 0, succeeded: 2 }],
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
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
              rows: [{ contentHash: 'hash-2', fileRecordId: '102', id: '2' }],
            };
          }
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: [{ contentHash: 'hash-1', fileRecordId: '101', id: '1' }],
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };

    const queueStats = [
      { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      { failed: 0, queue: 'embeddings', queued: 1, running: 0, succeeded: 0 },
      { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 1 },
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
    const result = await enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
      'set-123',
      () => undefined,
      {
        backlogPollMs: 1,
        maxQueueDepth: 1,
        onDrainTick: async (completedSinceLastTick) => {
          drainDeltas.push(completedSinceLastTick);
        },
        progressIntervalBatches: 1,
        progressIntervalMs: 1,
      }
    );

    expect(drainDeltas).toEqual([1, 1]);
    expect(result).toEqual({ failed: 0, queued: 0, running: 0, succeeded: 2 });
  });

  it('leaves table vacuuming to the idle database maintenance scheduler', async () => {
    let currentTime = 0;
    let pendingCountCalls = 0;
    let succeededCountCalls = 0;
    const queryEvents: string[] = [];

    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'VACUUM (ANALYZE) file_chunks') {
          queryEvents.push('vacuum-file-chunks');
          return { rows: [] };
        }
        if (sql === 'VACUUM (ANALYZE) job_queue') {
          queryEvents.push('vacuum-job-queue');
          return { rows: [] };
        }
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          succeededCountCalls += 1;
          return {
            rows: [
              {
                failed: 0,
                queued: succeededCountCalls < 2 ? 1 : 0,
                running: 0,
                succeeded: succeededCountCalls,
              },
            ],
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
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
              rows: [{ contentHash: 'hash-2', fileRecordId: '102', id: '2' }],
            };
          }
          if (afterChunkId) {
            return { rows: [] };
          }
          return {
            rows: [{ contentHash: 'hash-1', fileRecordId: '101', id: '1' }],
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
      }),
    };

    const queueStats = [
      { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 },
      { failed: 0, queue: 'embeddings', queued: 1, running: 0, succeeded: 0 },
      { failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 1 },
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
    } satisfies EnqueueEmbeddingBackfillOptions;

    await enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
      'set-123',
      () => undefined,
      options
    );

    const finalPendingIndex = queryEvents.lastIndexOf(`pending-${pendingCountCalls}`);
    expect(finalPendingIndex).toBeGreaterThanOrEqual(0);
    expect(queryEvents).not.toContain('vacuum-file-chunks');
    expect(queryEvents).not.toContain('vacuum-job-queue');
  });

  it('does not synchronously vacuum after a 20k-candidate backfill', async () => {
    const candidateCount = 20_000;
    let currentTime = 0;
    let queueStatsCalls = 0;
    let vacuumFileChunksCount = 0;

    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'VACUUM (ANALYZE) file_chunks') {
          vacuumFileChunksCount += 1;
          return { rows: [] };
        }
        if (sql === 'VACUUM (ANALYZE) job_queue') {
          return { rows: [] };
        }
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [{ dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' }],
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return {
            rows: [
              {
                failed: 0,
                queued: 0,
                running: 0,
                succeeded: candidateCount,
              },
            ],
          };
        }
        if (
          sql.includes('FROM job_queue') &&
          !sql.includes('FROM file_chunks') &&
          sql.includes('embedding_set_id')
        ) {
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
                  contentHash: `hash-${id}`,
                  fileRecordId: String(id + 100_000),
                  id: String(id),
                };
              }
            ),
          };
        }
        if (sql.startsWith('VACUUM')) {
          return { rows: [] };
        }
        if (isDimensionIndexMaintenanceQuery(sql)) {
          return { rows: [] };
        }

        throw new Error('Unexpected query: ');
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
          return [{ failed: 0, queue: 'embeddings', queued: 32, running: 0, succeeded: 0 }];
        }
        return [{ failed: 0, queue: 'embeddings', queued: 0, running: 0, succeeded: 0 }];
      }),
    };

    const options = {
      backlogPollMs: 1,
      maxQueueDepth: 32,
      now: () => currentTime,
      progressIntervalBatches: 64,
      progressIntervalMs: 1,
    } satisfies EnqueueEmbeddingBackfillOptions;

    await enqueueTestEmbeddingBackfill(
      db,
      withQueueRepair(jobQueue),
      'set-20k',
      () => undefined,
      options
    );

    const enqueueBatchCount = vi.mocked(jobQueue.enqueueBatch).mock.calls.length;
    expect(enqueueBatchCount).toBe(Math.ceil(candidateCount / 32));
    expect(vacuumFileChunksCount).toBe(0);
  }, 60_000);
});
