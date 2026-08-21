import type { FileChunkRepository, JobQueue } from '@brainstrike/db';
import {
  type ApiKeyValidationUnavailableReason,
  checkApiKeyAvailability,
} from '@brainstrike/embeddings';
import {
  buildEmbeddingJobInputHashes,
  buildEmbedJobDedupeKey,
  canonicalizeEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';

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
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

export interface VectorQueueServiceDependencies {
  chunkRepository: Pick<FileChunkRepository, 'getCoverageForSet' | 'clearEmbeddingsForSet'>;
  db: VectorQueueDatabase;
  jobQueue: Pick<
    JobQueue,
    'clear' | 'enqueueBatch' | 'getQueueStats' | 'repairUnclaimableQueued' | 'requeueFailed'
  >;
}

export type BackfillProgressHandler = (done: number, total: number) => void;

export interface BackfillOptions {
  onProgress: BackfillProgressHandler;
  queueCapacityTimeoutMs?: number;
  signal?: AbortSignal;
}

export const EMBEDDINGS_QUEUE = 'embeddings';

interface EmbeddingSetJobMetadata {
  expectedDimension: number;
  modelKey: string;
}

const logger = createLogger('VectorQueueService');
const BACKFILL_ENQUEUE_BATCH_SIZE = 32;
const BACKFILL_MAX_QUEUE_DEPTH = 64;
const BACKFILL_BACKLOG_POLL_MS = 100;
const BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS = 30_000;
const BACKFILL_DRAIN_TIMEOUT_MS = 300_000;
const BACKFILL_QUEUE_RECOVERY_LIMIT = 5000;

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal, message = 'Embedding backfill was aborted.'): void {
  if (signal?.aborted) {
    throw createAbortError(message);
  }
}

function cooperativeYield(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(createAbortError('Embedding backfill was aborted.'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function getEmbeddingSetQueueCounts(
  db: VectorQueueDatabase,
  embeddingSetId: string
): Promise<QueueCounts> {
  const result = await db.query<QueueCounts>(
    `SELECT
       COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
       COUNT(*) FILTER (WHERE state = 'running')::int AS running,
       COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE state = 'succeeded')::int AS succeeded
     FROM job_queue
     WHERE queue = $1
       AND job_type = 'embed_chunk'
       AND embedding_set_id = $2`,
    [EMBEDDINGS_QUEUE, embeddingSetId]
  );
  const row = result.rows[0];
  if (!row) {
    return {
      failed: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
    };
  }
  return {
    failed: Number(row.failed ?? 0),
    queued: Number(row.queued ?? 0),
    running: Number(row.running ?? 0),
    succeeded: Number(row.succeeded ?? 0),
  };
}

async function waitForEmbeddingSetDrain(
  db: VectorQueueDatabase,
  embeddingSetId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<QueueCounts> {
  const startedAt = Date.now();
  while (true) {
    throwIfAborted(signal);
    const counts = await getEmbeddingSetQueueCounts(db, embeddingSetId);
    if (counts.queued === 0 && counts.running === 0) {
      return counts;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Backfill timed out while waiting for embedding set '${embeddingSetId}' to drain.`
      );
    }
    await sleep(BACKFILL_BACKLOG_POLL_MS, signal);
  }
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
  backlogPollMs: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<number> {
  const startedAt = Date.now();
  while (true) {
    throwIfAborted(signal);
    const backlog = await getEmbeddingQueueBacklog(jobQueue);
    const capacity = maxQueueDepth - backlog;
    if (capacity > 0) {
      return capacity;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Backfill timed out while waiting for queue capacity below ${maxQueueDepth} jobs.`
      );
    }
    await sleep(backlogPollMs, signal);
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
export type ApiKeyValidationFailureReason = ApiKeyValidationUnavailableReason | 'validation-error';
export type ApiKeyValidation =
  | { valid: true }
  | { valid: false; reason: ApiKeyValidationFailureReason; message: string };

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
  backfill: (activeSetId: string, options: BackfillOptions) => Promise<QueueCounts>;
  clearQueue: (states?: Array<'queued' | 'running' | 'failed' | 'succeeded'>) => Promise<void>;
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
  reembedSet: (
    embeddingSetId: string,
    onProgress: BackfillProgressHandler
  ) => Promise<ReembedResult>;
  refresh: (activeSetId: string | null) => Promise<VectorQueueSnapshot>;
  retryFailed: (limit: number) => Promise<void>;
  /**
   * Validates that the API key is available for the embedding set's model.
   * Call this before backfill to prevent enqueueing jobs that will fail.
   */
  validateApiKeyForSet: (embeddingSetId: string) => Promise<ApiKeyValidation>;
  wipeQueue: () => Promise<void>;
}

export function createVectorQueueService(
  dependencies: VectorQueueServiceDependencies
): VectorQueueService {
  const { db, jobQueue, chunkRepository } = dependencies;

  const defaultCounts: QueueCounts = {
    failed: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
  };

  const defaultLatency: LatencyStats = { avgMs: 0, p50Ms: 0, p95Ms: 0 };

  return {
    async backfill(activeSetId, options) {
      const { onProgress, signal } = options;
      const queueCapacityTimeoutMs =
        options.queueCapacityTimeoutMs ?? BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS;
      if (!Number.isInteger(queueCapacityTimeoutMs) || queueCapacityTimeoutMs <= 0) {
        throw new Error('queueCapacityTimeoutMs must be a positive integer when configured.');
      }
      logger.info('Backfill requested', { embeddingSetId: activeSetId });
      throwIfAborted(signal);
      const setMetadata = await resolveEmbeddingSetJobMetadata(db, activeSetId);
      throwIfAborted(signal);
      await recoverBackfillQueueState(jobQueue, activeSetId);
      throwIfAborted(signal);
      const total = await countBackfillCandidates(db, activeSetId);
      logger.info('Embedding set metadata resolved for backfill', {
        candidates: total,
        embeddingSetId: activeSetId,
        expectedDimension: setMetadata.expectedDimension,
        modelKey: setMetadata.modelKey,
      });
      if (total === 0) {
        const diagnostics = await loadBackfillCandidateDiagnostics(db, activeSetId);
        // An already-current incremental pass legitimately has no candidates;
        // diagnostics remain attached for investigation without surfacing a warning.
        logger.info('Backfill found no eligible chunks', {
          diagnostics,
          embeddingSetId: activeSetId,
        });
      }
      const failedBeforeBackfill = (await getEmbeddingSetQueueCounts(db, activeSetId)).failed;

      let done = 0;
      let cursor: string | null = null;
      onProgress(done, total);

      while (done < total) {
        throwIfAborted(signal);
        const availableCapacity = await waitForQueueCapacity(
          jobQueue,
          BACKFILL_MAX_QUEUE_DEPTH,
          BACKFILL_BACKLOG_POLL_MS,
          queueCapacityTimeoutMs,
          signal
        );
        const batchLimit = Math.min(BACKFILL_ENQUEUE_BATCH_SIZE, total - done, availableCapacity);
        const batch = await loadBackfillCandidateBatch(db, activeSetId, cursor, batchLimit);
        throwIfAborted(signal);
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
          batchSize: batch.length,
          embeddingSetId: activeSetId,
          inserted,
        });
        done = Math.min(total, done + inserted);
        onProgress(done, total);
        if (selected === batchLimit && done < total) {
          await cooperativeYield(signal);
        }
      }

      if (done < total) {
        onProgress(total, total);
      }

      const drainedCounts = await waitForEmbeddingSetDrain(
        db,
        activeSetId,
        BACKFILL_DRAIN_TIMEOUT_MS,
        signal
      );
      const failedDuringBackfill = Math.max(0, drainedCounts.failed - failedBeforeBackfill);
      if (failedDuringBackfill > 0) {
        throw new Error(
          `Backfill failed for embedding set '${activeSetId}': ${failedDuringBackfill} job(s) failed.`
        );
      }
      logger.info('Backfill complete', {
        embeddingSetId: activeSetId,
        enqueued: done,
        queueCounts: drainedCounts,
        total,
      });
      return drainedCounts;
    },

    async clearQueue(states) {
      await jobQueue.clear(EMBEDDINGS_QUEUE, states);
    },

    async reembedSet(embeddingSetId, onProgress) {
      logger.info('Re-embed workflow started', { embeddingSetId });

      // Step 1: Clear existing embeddings for this set
      const clearedCount = await chunkRepository.clearEmbeddingsForSet(embeddingSetId);
      logger.info('Cleared existing embeddings', { clearedCount, embeddingSetId });

      // Step 2: Trigger backfill to regenerate embeddings
      const queueCounts = await this.backfill(embeddingSetId, { onProgress });

      logger.info('Re-embed workflow complete', {
        clearedCount,
        embeddingSetId,
        queueCounts,
      });

      return { clearedCount, queueCounts };
    },
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
          : Promise.resolve({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 }),
      ]);

      const stats = queueStats[0];
      const queueCounts: QueueCounts = stats
        ? {
            failed: stats.failed,
            queued: stats.queued,
            running: stats.running,
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
        lastError,
        latency,
        queueCounts,
        throughput,
      };
    },

    async retryFailed(limit) {
      const repairedQueued = await jobQueue.repairUnclaimableQueued(EMBEDDINGS_QUEUE, limit);
      const requeuedFailed = await jobQueue.requeueFailed(EMBEDDINGS_QUEUE, limit);
      if (repairedQueued > 0 || requeuedFailed > 0) {
        logger.warn('Retry recovered embedding queue jobs', {
          limit,
          repairedQueued,
          requeuedFailed,
        });
      }
    },

    async validateApiKeyForSet(embeddingSetId): Promise<ApiKeyValidation> {
      try {
        const setMetadata = await resolveEmbeddingSetJobMetadata(db, embeddingSetId);
        const validation = await checkApiKeyAvailability(setMetadata.modelKey);
        if (validation.available) {
          return { valid: true };
        }
        return { message: validation.message, reason: validation.reason, valid: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to validate API key';
        return { message, reason: 'validation-error', valid: false };
      }
    },

    async wipeQueue() {
      await jobQueue.clear(EMBEDDINGS_QUEUE);
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

interface BackfillCandidateDiagnostics {
  chunkCount: number;
  embeddedChunkCount: number;
  failedJobs: number;
  fileCount: number;
  pendingChunkCount: number;
  queuedOrRunningJobs: number;
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

async function loadBackfillCandidateDiagnostics(
  db: VectorQueueDatabase,
  embeddingSetId: string
): Promise<BackfillCandidateDiagnostics> {
  const result = await db.query<{
    chunkCount: number | string | null;
    embeddedChunkCount: number | string | null;
    failedJobs: number | string | null;
    fileCount: number | string | null;
    pendingChunkCount: number | string | null;
    queuedOrRunningJobs: number | string | null;
  }>(
    `WITH backfill_candidate_diagnostics AS (
       SELECT $1::text AS embedding_set_id
     ),
     scoped_chunks AS (
       SELECT c.id, c.embedding
         FROM file_chunks c
         JOIN file_records fr ON fr.id = c.file_record_id
         JOIN backfill_candidate_diagnostics target ON (
              c.embedding_set_id::text = target.embedding_set_id
              OR (c.embedding_set_id IS NULL AND fr.embedding_set_id::text = target.embedding_set_id)
            )
     )
     SELECT
       (
         SELECT COUNT(*)::int
           FROM file_records fr
           JOIN backfill_candidate_diagnostics target
             ON fr.embedding_set_id::text = target.embedding_set_id
       ) AS "fileCount",
       (SELECT COUNT(*)::int FROM scoped_chunks) AS "chunkCount",
       (
         SELECT COUNT(*)::int
           FROM scoped_chunks
          WHERE embedding IS NULL
       ) AS "pendingChunkCount",
       (
         SELECT COUNT(*)::int
           FROM scoped_chunks
          WHERE embedding IS NOT NULL
       ) AS "embeddedChunkCount",
       (
         SELECT COUNT(*)::int
           FROM job_queue j
           JOIN backfill_candidate_diagnostics target
             ON j.embedding_set_id = target.embedding_set_id
          WHERE j.queue = $2
            AND j.state IN ('queued','running')
       ) AS "queuedOrRunningJobs",
       (
         SELECT COUNT(*)::int
           FROM job_queue j
           JOIN backfill_candidate_diagnostics target
             ON j.embedding_set_id = target.embedding_set_id
          WHERE j.queue = $2
            AND j.state = 'failed'
       ) AS "failedJobs"`,
    [embeddingSetId, EMBEDDINGS_QUEUE]
  );
  const row = result.rows[0];
  return {
    chunkCount: Number(row?.chunkCount ?? 0),
    embeddedChunkCount: Number(row?.embeddedChunkCount ?? 0),
    failedJobs: Number(row?.failedJobs ?? 0),
    fileCount: Number(row?.fileCount ?? 0),
    pendingChunkCount: Number(row?.pendingChunkCount ?? 0),
    queuedOrRunningJobs: Number(row?.queuedOrRunningJobs ?? 0),
  };
}

async function recoverBackfillQueueState(
  jobQueue: Pick<JobQueue, 'repairUnclaimableQueued' | 'requeueFailed'>,
  embeddingSetId: string
): Promise<void> {
  const repairedQueued =
    (await jobQueue.repairUnclaimableQueued(EMBEDDINGS_QUEUE, BACKFILL_QUEUE_RECOVERY_LIMIT, {
      embeddingSetId,
    })) ?? 0;
  const requeuedFailed =
    (await jobQueue.requeueFailed(EMBEDDINGS_QUEUE, BACKFILL_QUEUE_RECOVERY_LIMIT, {
      embeddingSetId,
    })) ?? 0;

  if (repairedQueued === 0 && requeuedFailed === 0) {
    return;
  }

  logger.warn('Backfill recovered blocked embedding jobs', {
    embeddingSetId,
    mayHaveRemainingBlockedJobs:
      repairedQueued >= BACKFILL_QUEUE_RECOVERY_LIMIT ||
      requeuedFailed >= BACKFILL_QUEUE_RECOVERY_LIMIT,
    recoveryLimit: BACKFILL_QUEUE_RECOVERY_LIMIT,
    repairedQueued,
    requeuedFailed,
  });
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

  const canonical = canonicalizeEmbeddingProviderModelKey(rawKey);
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
      dimensions: row.dimensions,
      embeddingSetId,
    });
    throw new Error(`Embedding set ${embeddingSetId} is missing dimension metadata`);
  }

  return {
    expectedDimension,
    modelKey: canonical.composite,
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

  const embeddingInputHashes = await buildEmbeddingJobInputHashes(
    batch.map(({ contentHash }) => contentHash),
    metadata.modelKey
  );
  const jobs = await jobQueue.enqueueBatch(
    batch.map((row, index) => {
      const embeddingInputHash = embeddingInputHashes[index];
      if (!embeddingInputHash) {
        throw new Error(`Missing embedding input hash for chunk '${row.id}'.`);
      }
      return {
        dedupeKey: buildEmbedJobDedupeKey(row.id, embeddingSetId, row.contentHash),
        jobType: 'embed_chunk' as const,
        maxAttempts: 5,
        payload: {
          chunkId: String(row.id),
          embeddingInputHash,
          embeddingSetId,
          expectedDimension: metadata.expectedDimension,
          fileRecordId: String(row.fileRecordId),
          modelKey: metadata.modelKey,
          sourceContentHash: row.contentHash,
        },
        queue: EMBEDDINGS_QUEUE,
      };
    })
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
