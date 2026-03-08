import type { IDatabase, JobQueue } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils';

export interface EmbeddingBackfillQueueCounts {
  failed: number;
  queued: number;
  running: number;
  succeeded: number;
}

export interface EnqueueEmbeddingBackfillOptions {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs?: number;
  drainTimeoutMs?: number;
  maxQueueDepth?: number;
  progressIntervalBatches?: number;
  queueCapacityTimeoutMs?: number;
}

interface ResolvedEnqueueEmbeddingBackfillOptions {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs: number;
  drainTimeoutMs: number;
  maxQueueDepth: number;
  progressIntervalBatches: number;
  queueCapacityTimeoutMs: number;
}

interface EmbeddingSetJobMetadata {
  expectedDimension: number;
  modelKey: string;
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

const logger = createLogger('DesktopEmbeddingBackfill');
const EMBEDDINGS_QUEUE = 'embeddings';
const EMBEDDING_BACKFILL_ENQUEUE_BATCH_SIZE = 32;
const EMBEDDING_BACKFILL_MAX_QUEUE_DEPTH = 64;
const EMBEDDING_BACKFILL_BACKLOG_POLL_MS = 100;
const EMBEDDING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS = 30_000;
const EMBEDDING_BACKFILL_DRAIN_TIMEOUT_MS = 300_000;
const PROVIDER_SEPARATOR = '::';
const LEGACY_SEPARATOR = ':';

function canonicalizeProviderModelKey(
  modelKey: string | null | undefined
): { composite: string } | null {
  if (!modelKey) {
    return null;
  }

  const trimmed = modelKey.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes(PROVIDER_SEPARATOR)) {
    const [provider, modelId] = trimmed.split(PROVIDER_SEPARATOR);
    if (!(provider && modelId)) {
      return null;
    }
    return { composite: `${provider}${PROVIDER_SEPARATOR}${modelId.trim()}` };
  }

  const legacyIndex = trimmed.indexOf(LEGACY_SEPARATOR);
  if (legacyIndex > 0 && legacyIndex < trimmed.length - 1) {
    const provider = trimmed.slice(0, legacyIndex);
    const modelId = trimmed.slice(legacyIndex + 1).trim();
    if (!(provider && modelId)) {
      return null;
    }
    return { composite: `${provider}${PROVIDER_SEPARATOR}${modelId}` };
  }

  return { composite: `local${PROVIDER_SEPARATOR}${trimmed}` };
}

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
  backlogPollMs: number,
  timeoutMs: number,
  assertCanContinue?: () => void | Promise<void>
): Promise<number> {
  const startedAt = Date.now();
  while (true) {
    await assertCanContinue?.();
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
    await sleep(backlogPollMs);
  }
}

function resolveEnqueueEmbeddingBackfillOptions(
  options: EnqueueEmbeddingBackfillOptions | undefined
): ResolvedEnqueueEmbeddingBackfillOptions {
  const maxQueueDepth = options?.maxQueueDepth ?? EMBEDDING_BACKFILL_MAX_QUEUE_DEPTH;
  if (!Number.isInteger(maxQueueDepth) || maxQueueDepth <= 0) {
    throw new Error('maxQueueDepth must be a positive integer when configured.');
  }

  const backlogPollMs = options?.backlogPollMs ?? EMBEDDING_BACKFILL_BACKLOG_POLL_MS;
  if (!Number.isInteger(backlogPollMs) || backlogPollMs <= 0) {
    throw new Error('backlogPollMs must be a positive integer when configured.');
  }

  const queueCapacityTimeoutMs =
    options?.queueCapacityTimeoutMs ?? EMBEDDING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS;
  if (!Number.isInteger(queueCapacityTimeoutMs) || queueCapacityTimeoutMs <= 0) {
    throw new Error('queueCapacityTimeoutMs must be a positive integer when configured.');
  }

  const drainTimeoutMs = options?.drainTimeoutMs ?? EMBEDDING_BACKFILL_DRAIN_TIMEOUT_MS;
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs <= 0) {
    throw new Error('drainTimeoutMs must be a positive integer when configured.');
  }

  const progressIntervalBatches = options?.progressIntervalBatches ?? 1;
  if (!Number.isInteger(progressIntervalBatches) || progressIntervalBatches <= 0) {
    throw new Error('progressIntervalBatches must be a positive integer when configured.');
  }

  return {
    backlogPollMs,
    drainTimeoutMs,
    maxQueueDepth,
    progressIntervalBatches,
    queueCapacityTimeoutMs,
    ...(options?.assertCanContinue ? { assertCanContinue: options.assertCanContinue } : {}),
  };
}

async function getEmbeddingSetQueueCounts(
  db: Pick<IDatabase, 'query'>,
  embeddingSetId: string
): Promise<EmbeddingBackfillQueueCounts> {
  const result = await db.query<{
    failed: number | string | null;
    queued: number | string | null;
    running: number | string | null;
    succeeded: number | string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
       COUNT(*) FILTER (WHERE state = 'running')::int AS running,
       COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE state = 'succeeded')::int AS succeeded
     FROM job_queue
     WHERE queue = $1
       AND job_type = 'embed_chunk'
       AND payload->>'embeddingSetId' = $2`,
    [EMBEDDINGS_QUEUE, embeddingSetId]
  );

  const row = result.rows[0];
  if (!row) {
    return {
      queued: 0,
      running: 0,
      failed: 0,
      succeeded: 0,
    };
  }

  return {
    queued: Number(row.queued ?? 0),
    running: Number(row.running ?? 0),
    failed: Number(row.failed ?? 0),
    succeeded: Number(row.succeeded ?? 0),
  };
}

function finalizeBackfillCounts(
  embeddingSetId: string,
  total: number,
  done: number,
  queueCounts: EmbeddingBackfillQueueCounts
): EmbeddingBackfillQueueCounts {
  logger.info('Backfill complete', {
    embeddingSetId,
    total,
    enqueued: done,
    queueCounts,
  });
  return queueCounts;
}

async function countPendingEmbeddingSetJobs(
  db: Pick<IDatabase, 'query'>,
  embeddingSetId: string
): Promise<number> {
  const result = await db.query<{ count: number | string | null }>(
    `SELECT COUNT(*)::int AS count
       FROM job_queue
      WHERE queue = $1
        AND state IN ('queued', 'running')
        AND payload->>'embeddingSetId' = $2`,
    [EMBEDDINGS_QUEUE, embeddingSetId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function waitForEmbeddingSetDrain(
  db: Pick<IDatabase, 'query'>,
  embeddingSetId: string,
  backlogPollMs: number,
  timeoutMs: number,
  assertCanContinue?: () => void | Promise<void>
): Promise<EmbeddingBackfillQueueCounts> {
  const startedAt = Date.now();
  while (true) {
    await assertCanContinue?.();
    const pending = await countPendingEmbeddingSetJobs(db, embeddingSetId);
    if (pending === 0) {
      return await getEmbeddingSetQueueCounts(db, embeddingSetId);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Backfill timed out while waiting for embedding set '${embeddingSetId}' to drain.`
      );
    }
    await sleep(backlogPollMs);
  }
}

async function resolveEmbeddingSetJobMetadata(
  db: Pick<IDatabase, 'query'>,
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

async function countBackfillCandidates(
  db: Pick<IDatabase, 'query'>,
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
  db: Pick<IDatabase, 'query'>,
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

export async function enqueueEmbeddingBackfill(
  db: Pick<IDatabase, 'query'>,
  jobQueue: Pick<JobQueue, 'enqueueBatch' | 'getQueueStats'>,
  embeddingSetId: string,
  onProgress: (done: number, total: number) => void,
  options?: EnqueueEmbeddingBackfillOptions
): Promise<EmbeddingBackfillQueueCounts> {
  if (typeof embeddingSetId !== 'string' || embeddingSetId.trim().length === 0) {
    throw new Error('Embedding backfill requires a non-empty embeddingSetId.');
  }

  const {
    assertCanContinue,
    backlogPollMs,
    drainTimeoutMs,
    maxQueueDepth,
    progressIntervalBatches,
    queueCapacityTimeoutMs,
  } = resolveEnqueueEmbeddingBackfillOptions(options);

  logger.info('Backfill requested', { embeddingSetId });
  const metadata = await resolveEmbeddingSetJobMetadata(db, embeddingSetId);
  const total = await countBackfillCandidates(db, embeddingSetId);
  logger.info('Embedding set metadata resolved for backfill', {
    embeddingSetId,
    modelKey: metadata.modelKey,
    expectedDimension: metadata.expectedDimension,
    candidates: total,
  });

  let done = 0;
  let cursor: string | null = null;
  let batchesSinceProgress = 0;
  let lastReportedDone = -1;

  const reportProgress = (nextDone: number, nextTotal: number): void => {
    if (lastReportedDone === nextDone) {
      return;
    }
    lastReportedDone = nextDone;
    onProgress(nextDone, nextTotal);
  };

  reportProgress(done, total);

  while (done < total) {
    const availableCapacity = await waitForQueueCapacity(
      jobQueue,
      maxQueueDepth,
      backlogPollMs,
      queueCapacityTimeoutMs,
      assertCanContinue
    );
    const batchLimit = Math.min(
      EMBEDDING_BACKFILL_ENQUEUE_BATCH_SIZE,
      total - done,
      availableCapacity
    );
    const batch = await loadBackfillCandidateBatch(db, embeddingSetId, cursor, batchLimit);
    if (batch.length === 0) {
      break;
    }
    cursor = batch.at(-1)?.id ?? cursor;
    const { inserted, selected } = await enqueueEmbeddingChunkJobsBatch(
      jobQueue,
      batch,
      embeddingSetId,
      metadata
    );
    logger.trace('Embedded batch enqueued', {
      embeddingSetId,
      batchSize: batch.length,
      inserted,
    });
    done = Math.min(total, done + inserted);
    batchesSinceProgress += 1;
    if (done >= total || batchesSinceProgress >= progressIntervalBatches) {
      reportProgress(done, total);
      batchesSinceProgress = 0;
    }
    if (selected === batchLimit && done < total) {
      await cooperativeYield();
    }
  }

  reportProgress(total, total);
  const drainedCounts = await waitForEmbeddingSetDrain(
    db,
    embeddingSetId,
    backlogPollMs,
    drainTimeoutMs,
    assertCanContinue
  );
  if (drainedCounts.failed > 0) {
    throw new Error(
      `Backfill failed for embedding set '${embeddingSetId}': ${drainedCounts.failed} job(s) failed.`
    );
  }
  return finalizeBackfillCounts(embeddingSetId, total, done, drainedCounts);
}
