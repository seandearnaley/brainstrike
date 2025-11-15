import type { FileChunkRepository, JobQueue } from '@brainstrike/db';
import { canonicalizeProviderModelKey, formatProviderModelKey } from '@brainstrike/embeddings';
import { createLogger } from '@brainstrike/utils';

/**
 * Snapshot of embedding coverage statistics for a specific embedding set.
 */
export type CoverageSnapshot = {
  /** Total number of file chunks in the database */
  total: number;
  /** Number of chunks that have embeddings for the active set */
  withSet: number;
};

/**
 * Current counts for embedding jobs across all queue states.
 * Used to track job queue activity and determine UI state (e.g., button disabled states).
 */
export type QueueCounts = {
  /** Number of jobs waiting to be processed */
  queued: number;
  /** Number of jobs currently being processed by workers */
  running: number;
  /** Number of jobs that encountered errors and failed */
  failed: number;
  /** Number of jobs that completed successfully */
  succeeded: number;
};

/**
 * Performance statistics tracking job processing latency.
 */
export type LatencyStats = {
  /** Average latency in milliseconds across all recent jobs */
  avgMs: number;
  /** Median (50th percentile) latency in milliseconds */
  p50Ms: number;
  /** 95th percentile latency in milliseconds */
  p95Ms: number;
};

/**
 * Complete snapshot of the vector queue state at a point in time.
 * Returned by service.refresh() to update UI with current queue activity.
 */
export type VectorQueueSnapshot = {
  /** Coverage statistics for the active embedding set, null if no active set */
  coverage: CoverageSnapshot | null;
  /** Current job counts across all queue states */
  queueCounts: QueueCounts;
  /** Jobs processed per minute (throughput rate) */
  throughput: number;
  /** Most recent error message, null if no errors */
  lastError: string | null;
  /** Latency performance statistics */
  latency: LatencyStats;
};

export interface VectorQueueDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface VectorQueueServiceDependencies {
  db: VectorQueueDatabase;
  jobQueue: Pick<JobQueue, 'getQueueStats' | 'clear' | 'requeueFailed'>;
  chunkRepository: Pick<FileChunkRepository, 'getCoverageForSet'>;
}

export type BackfillProgressHandler = (done: number, total: number) => void;

export const EMBEDDINGS_QUEUE = 'embeddings';

type EmbeddingSetJobMetadata = {
  modelKey: string;
  expectedDimension: number;
};

const logger = createLogger('VectorQueueService');

function* chunkArray<T>(items: T[], size: number): Generator<T[]> {
  const step = Math.max(1, size);
  for (let i = 0; i < items.length; i += step) {
    yield items.slice(i, i + step);
  }
}

export async function withTransaction(
  db: VectorQueueDatabase,
  body: () => Promise<void>
): Promise<void> {
  await db.query('BEGIN');
  try {
    await body();
    await db.query('COMMIT');
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      // ignore rollback failures to preserve the original error
    }
    throw error;
  }
}

export interface VectorQueueService {
  refresh(activeSetId: string | null): Promise<VectorQueueSnapshot>;
  backfill(activeSetId: string, onProgress: BackfillProgressHandler): Promise<QueueCounts>;
  retryFailed(limit: number): Promise<void>;
  clearQueue(states?: Array<'queued' | 'running' | 'failed' | 'succeeded'>): Promise<void>;
  wipeQueue(): Promise<void>;
}

export function createVectorQueueService(
  dependencies: VectorQueueServiceDependencies
): VectorQueueService {
  const { db, jobQueue, chunkRepository } = dependencies;

  const defaultCounts: QueueCounts = {
    queued: 0,
    running: 0,
    failed: 0,
    succeeded: 0,
  };

  const defaultLatency: LatencyStats = { avgMs: 0, p50Ms: 0, p95Ms: 0 };

  return {
    async refresh(activeSetId) {
      const since = new Date(Date.now() - 60_000).toISOString();
      const [queueStats, throughputRows, lastErrorRows, latencyRows, coverage] = await Promise.all([
        jobQueue.getQueueStats(EMBEDDINGS_QUEUE),
        db.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM job_queue
            WHERE queue = $1 AND state = 'succeeded' AND updated_at >= $2`,
          [EMBEDDINGS_QUEUE, since]
        ),
        db.query<{ error: string | null }>(
          `SELECT error
             FROM job_queue
            WHERE state = 'failed'
              AND queue = $1
         ORDER BY updated_at DESC
            LIMIT 1`,
          [EMBEDDINGS_QUEUE]
        ),
        db.query<{ runAt: string; updatedAt: string }>(
          `SELECT run_at AS "runAt", updated_at AS "updatedAt"
             FROM job_queue
            WHERE queue = $1
              AND state = 'succeeded'
              AND updated_at >= $2
         ORDER BY updated_at DESC
            LIMIT 200`,
          [EMBEDDINGS_QUEUE, since]
        ),
        activeSetId
          ? chunkRepository.getCoverageForSet(activeSetId)
          : Promise.resolve({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 }),
      ]);

      const stats = queueStats[0];
      const queueCounts: QueueCounts = stats
        ? {
            queued: stats.queued,
            running: stats.running,
            failed: stats.failed,
            succeeded: stats.succeeded,
          }
        : defaultCounts;

      const throughput = Number(throughputRows.rows[0]?.count ?? 0);
      const lastError = lastErrorRows.rows[0]?.error ?? null;
      const latency = calculateLatency(latencyRows.rows) ?? defaultLatency;

      const coverageSnapshot: CoverageSnapshot | null = activeSetId
        ? {
            total: coverage.totalChunks,
            withSet: coverage.chunksWithEmbeddingsForSet,
          }
        : null;

      return {
        coverage: coverageSnapshot,
        queueCounts,
        throughput,
        lastError,
        latency,
      };
    },

    async backfill(activeSetId, onProgress) {
      logger.info('Backfill requested', { embeddingSetId: activeSetId });
      const candidates = await db.query<{
        id: string;
        fileRecordId: string;
        contentHash: string;
      }>(
        `SELECT c.id,
                c.file_record_id AS "fileRecordId",
                c.content_hash   AS "contentHash"
           FROM file_chunks c
          WHERE c.embedding_set_id = $1
            AND c.embedding IS NULL
            AND NOT EXISTS (
                  SELECT 1
                    FROM job_queue j
                   WHERE j.queue = $2
                     AND j.state IN ('queued','running')
                     AND j.dedupe_key = (c.id || ':' || $1 || ':' || c.content_hash)
                )`,
        [activeSetId, EMBEDDINGS_QUEUE]
      );

      const setMetadata = await resolveEmbeddingSetJobMetadata(db, activeSetId);
      logger.info('Embedding set metadata resolved for backfill', {
        embeddingSetId: activeSetId,
        modelKey: setMetadata.modelKey,
        expectedDimension: setMetadata.expectedDimension,
        candidates: candidates.rows.length,
      });

      const total = candidates.rows.length;
      let done = 0;
      onProgress(done, total);

      for (const batch of chunkArray(candidates.rows, 500)) {
        const inserted = await enqueueEmbeddingChunkJobsBatch(db, batch, activeSetId, setMetadata);
        logger.debug('Embedded batch enqueued', {
          embeddingSetId: activeSetId,
          batchSize: batch.length,
          inserted,
        });
        done = Math.min(total, done + inserted);
        onProgress(done, total);
      }

      if (done < total) {
        onProgress(total, total);
      }

      const stats = await jobQueue.getQueueStats(EMBEDDINGS_QUEUE);
      logger.info('Backfill complete', {
        embeddingSetId: activeSetId,
        total,
        enqueued: done,
        queueCounts: stats[0] ?? null,
      });
      const s = stats[0];
      return s
        ? {
            queued: s.queued,
            running: s.running,
            failed: s.failed,
            succeeded: s.succeeded,
          }
        : defaultCounts;
    },

    async retryFailed(limit) {
      await jobQueue.requeueFailed(EMBEDDINGS_QUEUE, limit);
    },

    async clearQueue(states) {
      await jobQueue.clear(EMBEDDINGS_QUEUE, states);
    },

    async wipeQueue() {
      await jobQueue.clear(EMBEDDINGS_QUEUE);
    },
  };
}

type BackfillCandidate = {
  id: string;
  fileRecordId: string;
  contentHash: string;
};

async function resolveEmbeddingSetJobMetadata(
  db: VectorQueueDatabase,
  embeddingSetId: string
): Promise<EmbeddingSetJobMetadata> {
  const result = await db.query<{
    modelKey: string | null;
    modelId: string | null;
    dimensions: number | string | null;
  }>(
    `SELECT model_key AS "modelKey", model_id AS "modelId", dimensions
       FROM embedding_sets
      WHERE id = $1
      LIMIT 1`,
    [embeddingSetId]
  );

  const row = result.rows[0];
  if (!row) {
    logger.error('Failed to resolve embedding set metadata (missing row)', { embeddingSetId });
    throw new Error(`Embedding set ${embeddingSetId} not found`);
  }

  const canonicalKey = (() => {
    const rawKey = row.modelKey?.trim();
    if (rawKey) {
      const canonical = canonicalizeProviderModelKey(rawKey);
      if (canonical) {
        return canonical.composite;
      }
      if (rawKey.includes('::')) {
        return rawKey;
      }
    }
    if (row.modelId) {
      return formatProviderModelKey('local', row.modelId);
    }
    if (rawKey) {
      return rawKey;
    }
    logger.error('Failed to resolve embedding set metadata (missing model info)', {
      embeddingSetId,
      modelKey: row.modelKey,
      modelId: row.modelId,
    });
    throw new Error(`Embedding set ${embeddingSetId} is missing model metadata`);
  })();

  const expectedDimension = Number(row.dimensions ?? Number.NaN);
  if (!Number.isFinite(expectedDimension) || expectedDimension <= 0) {
    logger.error('Failed to resolve embedding set metadata (invalid dimension)', {
      embeddingSetId,
      dimensions: row.dimensions,
    });
    throw new Error(`Embedding set ${embeddingSetId} is missing dimension metadata`);
  }

  return {
    modelKey: canonicalKey,
    expectedDimension,
  };
}

async function enqueueEmbeddingChunkJobsBatch(
  db: VectorQueueDatabase,
  batch: BackfillCandidate[],
  embeddingSetId: string,
  metadata: EmbeddingSetJobMetadata
): Promise<number> {
  if (!batch.length) {
    return 0;
  }

  const tuples: string[] = [];
  const params: unknown[] = [];
  batch.forEach((row, index) => {
    const jobId = createJobId();
    const payload = JSON.stringify({
      chunkId: String(row.id),
      fileRecordId: String(row.fileRecordId),
      embeddingSetId,
      modelKey: metadata.modelKey,
      expectedDimension: metadata.expectedDimension,
    });
    const dedupeKey = `${row.id}:${embeddingSetId}:${row.contentHash}`;
    const base = index * 4;
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    params.push(String(row.id), jobId, payload, dedupeKey);
  });

  const timestampParam = params.length + 1;
  params.push(new Date().toISOString());

  const sql = `WITH pending (chunk_id, job_id, payload_json, dedupe_key) AS (
      VALUES ${tuples.join(',')}
    ),
    inserted AS (
      INSERT INTO job_queue (
        id, queue, job_type, payload, state, run_at,
        attempts, max_attempts, backoff_ms,
        lease_token, leased_until, worker_id,
        dedupe_key, error, created_at, updated_at
      )
      SELECT pending.job_id,
             '${EMBEDDINGS_QUEUE}',
             'embed_chunk',
             pending.payload_json::jsonb,
             'queued',
             $${timestampParam},
             0,
             5,
             0,
             NULL,
             NULL,
             NULL,
             pending.dedupe_key,
             NULL,
             $${timestampParam},
             $${timestampParam}
        FROM pending
       WHERE NOT EXISTS (
         SELECT 1
           FROM job_queue j
          WHERE j.dedupe_key = pending.dedupe_key
            AND j.state IN ('queued','running')
       )
      RETURNING 1
    )
    SELECT COUNT(*)::int AS inserted FROM inserted`;

  const result = await db.query<{ inserted: number }>(sql, params);
  return Number(result.rows[0]?.inserted ?? 0);
}

function createJobId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // fall through to fallback
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function calculateLatency(
  rows: Array<{ runAt: string; updatedAt: string }>
): LatencyStats | null {
  if (rows.length === 0) {
    return null;
  }

  const durations = rows
    .map((row) => {
      const startedAt = Date.parse(row.runAt);
      const finishedAt = Date.parse(row.updatedAt);
      if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
        return 0;
      }
      return Math.max(0, finishedAt - startedAt);
    })
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (durations.length === 0) {
    return null;
  }

  const average = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
  const percentile = (q: number): number => {
    const index = Math.min(durations.length - 1, Math.floor(q * durations.length));
    return durations[index] ?? average;
  };

  return {
    avgMs: average,
    p50Ms: Math.round(percentile(0.5)),
    p95Ms: Math.round(percentile(0.95)),
  };
}
