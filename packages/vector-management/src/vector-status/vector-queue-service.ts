import type { FileChunkRepository, JobQueue } from '@brainstrike/db';
import { canonicalizeProviderModelKey, checkApiKeyAvailability } from '@brainstrike/embeddings';
import { createLogger } from '@brainstrike/utils';

/**
 * Snapshot of embedding coverage statistics for a specific embedding set.
 */
export interface CoverageSnapshot {
  /** Total number of file chunks in the database */
  total: number;
  /** Number of chunks that have embeddings for the active set */
  withSet: number;
}

/**
 * Current counts for embedding jobs across all queue states.
 * Used to track job queue activity and determine UI state (e.g., button disabled states).
 */
export interface QueueCounts {
  /** Number of jobs that encountered errors and failed */
  failed: number;
  /** Number of jobs waiting to be processed */
  queued: number;
  /** Number of jobs currently being processed by workers */
  running: number;
  /** Number of jobs that completed successfully */
  succeeded: number;
}

/**
 * Performance statistics tracking job processing latency.
 */
export interface LatencyStats {
  /** Average latency in milliseconds across all recent jobs */
  avgMs: number;
  /** Median (50th percentile) latency in milliseconds */
  p50Ms: number;
  /** 95th percentile latency in milliseconds */
  p95Ms: number;
}

/**
 * Complete snapshot of the vector queue state at a point in time.
 * Returned by service.refresh() to update UI with current queue activity.
 */
export interface VectorQueueSnapshot {
  /** Coverage statistics for the active embedding set, null if no active set */
  coverage: CoverageSnapshot | null;
  /** Most recent error message, null if no errors */
  lastError: string | null;
  /** Latency performance statistics */
  latency: LatencyStats;
  /** Current job counts across all queue states */
  queueCounts: QueueCounts;
  /** Jobs processed per minute (throughput rate) */
  throughput: number;
}

export interface VectorQueueDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface VectorQueueServiceDependencies {
  chunkRepository: Pick<FileChunkRepository, 'getCoverageForSet' | 'clearEmbeddingsForSet'>;
  db: VectorQueueDatabase;
  jobQueue: Pick<JobQueue, 'clear' | 'enqueueBatch' | 'getQueueStats' | 'requeueFailed'>;
}

export type BackfillProgressHandler = (done: number, total: number) => void;

export const EMBEDDINGS_QUEUE = 'embeddings';

interface EmbeddingSetJobMetadata {
  expectedDimension: number;
  modelKey: string;
}

const logger = createLogger('VectorQueueService');
const BACKFILL_ENQUEUE_BATCH_SIZE = 32;
const BACKFILL_MAX_QUEUE_DEPTH = 64;
const BACKFILL_BACKLOG_POLL_MS = 100;

function cooperativeYield(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getEmbeddingQueueBacklog(
  jobQueue: Pick<JobQueue, 'getQueueStats'>
): Promise<number> {
  const snapshot = (await jobQueue.getQueueStats(EMBEDDINGS_QUEUE))[0];
  if (!snapshot) {
    return 0;
  }
  return Math.max(0, snapshot.queued + snapshot.running);
}

async function waitForQueueCapacity(
  jobQueue: Pick<JobQueue, 'getQueueStats'>,
  maxQueueDepth: number,
  backlogPollMs: number
): Promise<number> {
  while (true) {
    const backlog = await getEmbeddingQueueBacklog(jobQueue);
    const capacity = maxQueueDepth - backlog;
    if (capacity > 0) {
      return capacity;
    }
    await sleep(backlogPollMs);
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

/**
 * Result of API key validation for an embedding set
 */
export type ApiKeyValidation = { valid: true } | { valid: false; message: string };

/**
 * Result of a re-embed operation
 */
export interface ReembedResult {
  /** Number of chunks that had embeddings cleared */
  clearedCount: number;
  /** Queue counts after backfill was triggered */
  queueCounts: QueueCounts;
}

export interface VectorQueueService {
  backfill(activeSetId: string, onProgress: BackfillProgressHandler): Promise<QueueCounts>;
  clearQueue(states?: Array<'queued' | 'running' | 'failed' | 'succeeded'>): Promise<void>;
  /**
   * Re-embed workflow: clears existing embeddings and triggers backfill.
   * Use this when switching models or when embeddings need to be regenerated.
   *
   * ## Atomicity & Recovery
   *
   * **Not atomic**: The clear and backfill steps are not transactional.
   * If backfill fails after clear completes:
   * 1. Embeddings will be cleared (lost) for this set
   * 2. Chunks remain intact with `embedding_set_id` preserved
   * 3. Simply call `backfill(embeddingSetId)` again to retry
   *
   * **Recovery steps** if backfill fails mid-way:
   * - Check `queueCounts.failed` for failed jobs
   * - Use `retryFailed()` to requeue failed jobs
   * - Or call `backfill()` directly - it skips already-queued chunks
   *
   * **Why not transactional**: Backfill enqueues jobs asynchronously
   * and embedding generation happens in workers. True atomicity would
   * require blocking until all embeddings complete, which is impractical
   * for large sets (thousands of chunks).
   *
   * @param embeddingSetId - The embedding set to re-embed
   * @param onProgress - Progress callback for the backfill phase
   * @returns Result with cleared count and final queue counts
   */
  reembedSet(embeddingSetId: string, onProgress: BackfillProgressHandler): Promise<ReembedResult>;
  refresh(activeSetId: string | null): Promise<VectorQueueSnapshot>;
  retryFailed(limit: number): Promise<void>;
  /**
   * Validates that the API key is available for the embedding set's model.
   * Call this before backfill to prevent enqueueing jobs that will fail.
   */
  validateApiKeyForSet(embeddingSetId: string): Promise<ApiKeyValidation>;
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

    async validateApiKeyForSet(embeddingSetId): Promise<ApiKeyValidation> {
      try {
        const setMetadata = await resolveEmbeddingSetJobMetadata(db, embeddingSetId);
        const validation = await checkApiKeyAvailability(setMetadata.modelKey);
        if (validation.available) {
          return { valid: true };
        }
        return { valid: false, message: validation.message };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to validate API key';
        return { valid: false, message };
      }
    },

    async backfill(activeSetId, onProgress) {
      logger.info('Backfill requested', { embeddingSetId: activeSetId });
      const setMetadata = await resolveEmbeddingSetJobMetadata(db, activeSetId);
      const total = await countBackfillCandidates(db, activeSetId);
      logger.info('Embedding set metadata resolved for backfill', {
        embeddingSetId: activeSetId,
        modelKey: setMetadata.modelKey,
        expectedDimension: setMetadata.expectedDimension,
        candidates: total,
      });

      let done = 0;
      let cursor: string | null = null;
      onProgress(done, total);

      while (done < total) {
        const availableCapacity = await waitForQueueCapacity(
          jobQueue,
          BACKFILL_MAX_QUEUE_DEPTH,
          BACKFILL_BACKLOG_POLL_MS
        );
        const batchLimit = Math.min(BACKFILL_ENQUEUE_BATCH_SIZE, total - done, availableCapacity);
        const batch = await loadBackfillCandidateBatch(db, activeSetId, cursor, batchLimit);
        if (batch.length === 0) {
          break;
        }
        cursor = batch.at(-1)?.id ?? cursor;
        const { inserted, selected } = await enqueueEmbeddingChunkJobsBatch(
          jobQueue,
          batch,
          activeSetId,
          setMetadata
        );
        logger.debug('Embedded batch enqueued', {
          embeddingSetId: activeSetId,
          batchSize: batch.length,
          inserted,
        });
        done = Math.min(total, done + inserted);
        onProgress(done, total);
        if (selected === batchLimit && done < total) {
          await cooperativeYield();
        }
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
      const snapshot = stats[0];
      return snapshot
        ? {
            queued: snapshot.queued,
            running: snapshot.running,
            failed: snapshot.failed,
            succeeded: snapshot.succeeded,
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

    async reembedSet(embeddingSetId, onProgress) {
      logger.info('Re-embed workflow started', { embeddingSetId });

      // Step 1: Clear existing embeddings for this set
      const clearedCount = await chunkRepository.clearEmbeddingsForSet(embeddingSetId);
      logger.info('Cleared existing embeddings', { embeddingSetId, clearedCount });

      // Step 2: Trigger backfill to regenerate embeddings
      const queueCounts = await this.backfill(embeddingSetId, onProgress);

      logger.info('Re-embed workflow complete', {
        embeddingSetId,
        clearedCount,
        queueCounts,
      });

      return { clearedCount, queueCounts };
    },
  };
}

interface BackfillCandidate {
  contentHash: string;
  fileRecordId: string;
  id: string;
}

interface BackfillBatchResult {
  inserted: number;
  selected: number;
}

async function countBackfillCandidates(
  db: VectorQueueDatabase,
  embeddingSetId: string
): Promise<number> {
  const result = await db.query<{ count: number | string | null }>(
    `SELECT COUNT(*)::int AS count
       FROM file_chunks c
       JOIN file_records fr ON fr.id = c.file_record_id
      WHERE (
              c.embedding_set_id = $1
              OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = $1)
            )
        AND c.embedding IS NULL
        AND NOT EXISTS (
              SELECT 1
                FROM job_queue j
               WHERE j.queue = $2
                 AND j.state IN ('queued','running')
                 AND j.dedupe_key = (c.id::text || ':' || $1 || ':' || c.content_hash)
            )`,
    [embeddingSetId, EMBEDDINGS_QUEUE]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function loadBackfillCandidateBatch(
  db: VectorQueueDatabase,
  embeddingSetId: string,
  afterChunkId: string | null,
  limit: number
): Promise<BackfillCandidate[]> {
  const result = await db.query<BackfillCandidate>(
    `SELECT c.id::text            AS id,
            c.file_record_id::text AS "fileRecordId",
            c.content_hash         AS "contentHash"
       FROM file_chunks c
       JOIN file_records fr ON fr.id = c.file_record_id
      WHERE (
              c.embedding_set_id = $1
              OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = $1)
            )
        AND c.embedding IS NULL
        AND ($3::text IS NULL OR c.id::text > $3)
        AND NOT EXISTS (
              SELECT 1
                FROM job_queue j
               WHERE j.queue = $2
                 AND j.state IN ('queued','running')
                 AND j.dedupe_key = (c.id::text || ':' || $1 || ':' || c.content_hash)
            )
      ORDER BY c.id::text ASC
      LIMIT $4`,
    [embeddingSetId, EMBEDDINGS_QUEUE, afterChunkId, limit]
  );
  return result.rows;
}

async function resolveEmbeddingSetJobMetadata(
  db: VectorQueueDatabase,
  embeddingSetId: string
): Promise<EmbeddingSetJobMetadata> {
  const result = await db.query<{
    modelKey: string | null;
    dimensions: number | string | null;
  }>(
    `SELECT model_key AS "modelKey", dimensions
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

  const rawKey = row.modelKey?.trim();
  if (!rawKey) {
    logger.error('Failed to resolve embedding set metadata (missing model_key)', {
      embeddingSetId,
    });
    throw new Error(`Embedding set ${embeddingSetId} is missing model_key metadata`);
  }

  const canonical = canonicalizeProviderModelKey(rawKey);
  if (!canonical) {
    logger.error('Failed to resolve embedding set metadata (invalid model_key)', {
      embeddingSetId,
      modelKey: row.modelKey,
    });
    throw new Error(`Embedding set ${embeddingSetId} has invalid model_key metadata`);
  }

  const expectedDimension = Number(row.dimensions ?? Number.NaN);
  if (!Number.isFinite(expectedDimension) || expectedDimension <= 0) {
    logger.error('Failed to resolve embedding set metadata (invalid dimension)', {
      embeddingSetId,
      dimensions: row.dimensions,
    });
    throw new Error(`Embedding set ${embeddingSetId} is missing dimension metadata`);
  }

  return {
    modelKey: canonical.composite,
    expectedDimension,
  };
}

async function enqueueEmbeddingChunkJobsBatch(
  jobQueue: Pick<JobQueue, 'enqueueBatch'>,
  batch: BackfillCandidate[],
  embeddingSetId: string,
  metadata: EmbeddingSetJobMetadata
): Promise<BackfillBatchResult> {
  if (!batch.length) {
    return { inserted: 0, selected: 0 };
  }

  const jobs = await jobQueue.enqueueBatch(
    batch.map((row) => ({
      queue: EMBEDDINGS_QUEUE,
      jobType: 'embed_chunk' as const,
      payload: {
        chunkId: String(row.id),
        fileRecordId: String(row.fileRecordId),
        embeddingSetId,
        modelKey: metadata.modelKey,
        expectedDimension: metadata.expectedDimension,
      },
      dedupeKey: `${row.id}:${embeddingSetId}:${row.contentHash}`,
      maxAttempts: 5,
    }))
  );

  return {
    inserted: jobs.length,
    selected: batch.length,
  };
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
      if (!(Number.isFinite(startedAt) && Number.isFinite(finishedAt))) {
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
