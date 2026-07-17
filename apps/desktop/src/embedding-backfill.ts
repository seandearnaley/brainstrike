import {
  createDimensionIndex,
  type DimensionIndexMaintenanceStrategy,
  dropDimensionIndex,
  hnswParams,
  type IDatabase,
  type JobQueue,
  type RequestDimensionIndexMaintenanceInput,
  requestDimensionIndexMaintenance,
  resumeDimensionIndexBuilds,
  suspendDimensionIndexBuilds,
} from '@brainstrike/db';
import { canonicalizeProviderModelKey } from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import { isExpectedBackfillTeardown } from './desktop-shutdown-state';
import { EMBEDDING_BACKFILL_CANCELED_MESSAGE } from './embedding-host-shared';

export interface EmbeddingBackfillQueueCounts {
  failed: number;
  queued: number;
  running: number;
  succeeded: number;
}

export interface EnqueueEmbeddingBackfillOptions {
  /**
   * Called before queue-capacity waits and drain checkpoints. The caller must
   * throw on unexpected host/runtime failures and may only tolerate stops that
   * are part of planned maintenance coordinated outside the backfill.
   */
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs?: number;
  dimensionIndexMaintenanceStrategy?: DimensionIndexMaintenanceStrategy;
  drainTimeoutMs?: number;
  maxQueueDepth?: number;
  now?: () => number;
  /**
   * Called during drain-safe checkpoints with the number of items completed
   * since the last call. Use this to trigger planned maintenance without
   * interrupting an active batch enqueue loop.
   */
  onDrainTick?: (completedSinceLastTick: number) => void | Promise<void>;
  progressIntervalBatches?: number;
  progressIntervalMs?: number;
  queueCapacityTimeoutMs?: number;
  rebuildDimensionIndexOnCompletion?: boolean;
  requestDimensionIndexMaintenance?: (
    db: EmbeddingBackfillDatabase,
    request: RequestDimensionIndexMaintenanceInput
  ) => Promise<void>;
}

interface ResolvedEnqueueEmbeddingBackfillOptions {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs: number;
  dimensionIndexMaintenanceStrategy?: DimensionIndexMaintenanceStrategy;
  drainTimeoutMs: number;
  maxQueueDepth: number;
  now: () => number;
  progressIntervalBatches: number;
  progressIntervalMs: number;
  queueCapacityTimeoutMs: number;
  rebuildDimensionIndexOnCompletion: boolean;
  requestDimensionIndexMaintenance: (
    db: EmbeddingBackfillDatabase,
    request: RequestDimensionIndexMaintenanceInput
  ) => Promise<void>;
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

interface QueueBacklogSnapshot {
  failed: number;
  queued: number;
  running: number;
  succeeded: number;
}

type EmbeddingBackfillJobQueue = Pick<
  JobQueue,
  'enqueueBatch' | 'getQueueStats' | 'repairUnclaimableQueued'
>;

const logger = createLogger('DesktopEmbeddingBackfill');
const EMBEDDINGS_QUEUE = 'embeddings';
const EMBEDDING_BACKFILL_ENQUEUE_BATCH_SIZE = 32;
const EMBEDDING_BACKFILL_MAX_QUEUE_DEPTH = 64;
const EMBEDDING_BACKFILL_BACKLOG_POLL_MS = 100;
const EMBEDDING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS = 30_000;
const EMBEDDING_BACKFILL_DRAIN_TIMEOUT_MS = 300_000;
const EMBEDDING_BACKFILL_PROGRESS_INTERVAL_MS = 250;
const EMBEDDING_BACKFILL_QUEUE_REPAIR_LIMIT = 1000;

function resolvePositiveIntegerOption(
  value: number | undefined,
  defaultValue: number,
  name: string
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer when configured.`);
  }
  return resolved;
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

async function getEmbeddingQueueBacklogSnapshot(
  jobQueue: Pick<EmbeddingBackfillJobQueue, 'getQueueStats'>
): Promise<QueueBacklogSnapshot> {
  const snapshot = (await jobQueue.getQueueStats(EMBEDDINGS_QUEUE))[0];
  if (!snapshot) {
    return {
      failed: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
    };
  }
  return {
    failed: Math.max(0, Number(snapshot.failed ?? 0)),
    queued: Math.max(0, Number(snapshot.queued ?? 0)),
    running: Math.max(0, Number(snapshot.running ?? 0)),
    succeeded: Math.max(0, Number(snapshot.succeeded ?? 0)),
  };
}

async function waitForQueueCapacity(
  jobQueue: Pick<EmbeddingBackfillJobQueue, 'getQueueStats'>,
  maxQueueDepth: number,
  backlogPollMs: number,
  timeoutMs: number,
  now: () => number,
  assertCanContinue?: () => void | Promise<void>,
  observeMaintenance?: () => void | Promise<void>
): Promise<number> {
  const startedAt = now();
  let pollCount = 0;
  const throwTimeout = (backlog: QueueBacklogSnapshot): never => {
    throw new Error(
      `Backfill timed out while waiting for queue capacity below ${maxQueueDepth} jobs ` +
        `(queued=${backlog.queued}, running=${backlog.running}, failed=${backlog.failed}, succeeded=${backlog.succeeded}).`
    );
  };
  while (true) {
    await assertCanContinue?.();
    const backlog = await getEmbeddingQueueBacklogSnapshot(jobQueue);
    pollCount += 1;
    const capacity = maxQueueDepth - (backlog.queued + backlog.running);
    if (capacity > 0) {
      if (pollCount > 1) {
        logger.info('Backfill queue capacity wait completed', {
          capacity,
          durationMs: now() - startedAt,
          failed: backlog.failed,
          maxQueueDepth,
          pollCount,
          queued: backlog.queued,
          running: backlog.running,
          succeeded: backlog.succeeded,
        });
      }
      return capacity;
    }
    if (now() - startedAt >= timeoutMs) {
      throwTimeout(backlog);
    }
    await observeMaintenance?.();
    if (now() - startedAt >= timeoutMs) {
      throwTimeout(backlog);
    }
    await sleep(backlogPollMs);
  }
}

function resolveEnqueueEmbeddingBackfillOptions(
  options: EnqueueEmbeddingBackfillOptions | undefined
): ResolvedEnqueueEmbeddingBackfillOptions {
  const now = options?.now ?? Date.now;

  return {
    backlogPollMs: resolvePositiveIntegerOption(
      options?.backlogPollMs,
      EMBEDDING_BACKFILL_BACKLOG_POLL_MS,
      'backlogPollMs'
    ),
    drainTimeoutMs: resolvePositiveIntegerOption(
      options?.drainTimeoutMs,
      EMBEDDING_BACKFILL_DRAIN_TIMEOUT_MS,
      'drainTimeoutMs'
    ),
    maxQueueDepth: resolvePositiveIntegerOption(
      options?.maxQueueDepth,
      EMBEDDING_BACKFILL_MAX_QUEUE_DEPTH,
      'maxQueueDepth'
    ),
    now,
    progressIntervalBatches: resolvePositiveIntegerOption(
      options?.progressIntervalBatches,
      1,
      'progressIntervalBatches'
    ),
    progressIntervalMs: resolvePositiveIntegerOption(
      options?.progressIntervalMs,
      EMBEDDING_BACKFILL_PROGRESS_INTERVAL_MS,
      'progressIntervalMs'
    ),
    queueCapacityTimeoutMs: resolvePositiveIntegerOption(
      options?.queueCapacityTimeoutMs,
      EMBEDDING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS,
      'queueCapacityTimeoutMs'
    ),
    ...(options?.dimensionIndexMaintenanceStrategy
      ? { dimensionIndexMaintenanceStrategy: options.dimensionIndexMaintenanceStrategy }
      : {}),
    rebuildDimensionIndexOnCompletion: options?.rebuildDimensionIndexOnCompletion ?? true,
    requestDimensionIndexMaintenance:
      options?.requestDimensionIndexMaintenance ?? requestDimensionIndexMaintenance,
    ...(options?.assertCanContinue ? { assertCanContinue: options.assertCanContinue } : {}),
  };
}

async function getEmbeddingSetQueueCounts(
  db: Pick<IDatabase, 'query'>,
  embeddingSetId: string,
  updatedAfter?: string
): Promise<EmbeddingBackfillQueueCounts> {
  // job_queue timestamps are stored as ISO strings in the current local schema, so
  // lexicographic comparison preserves chronological ordering for run-scoped counts.
  // Cast the optional parameter to text explicitly; PGlite cannot infer $3 from
  // the null-check branch alone. If updated_at stops being ISO text in this schema,
  // this query and its tests must be updated explicitly rather than silently coerced.
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
       AND embedding_set_id = $2
       AND ($3::text IS NULL OR updated_at >= $3::text)`,
    [EMBEDDINGS_QUEUE, embeddingSetId, updatedAfter ?? null]
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

function finalizeBackfillCounts(
  embeddingSetId: string,
  total: number,
  done: number,
  queueCounts: EmbeddingBackfillQueueCounts
): EmbeddingBackfillQueueCounts {
  logger.info('Backfill complete', {
    embeddingSetId,
    enqueued: done,
    queueCounts,
    total,
  });
  return queueCounts;
}

function isEmbeddingBackfillCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message === EMBEDDING_BACKFILL_CANCELED_MESSAGE;
}

// A backfill that fails AFTER suspending the dimension index leaves the
// suspension row in place; scheduled maintenance reconciles + rebuilds it on the
// next idle tick. Distinguish an expected shutdown teardown (quiet) from a real
// failure (warn) so a graceful quit does not surface a scary error.
function logSuspendedDimensionIndexAfterBackfillError(
  error: unknown,
  payload: { dimension: number; embeddingSetId: string; error: string }
): void {
  if (isExpectedBackfillTeardown(error)) {
    logger.debug(
      'Embedding backfill stopped (benign teardown); dimension HNSW index will be rebuilt by scheduled maintenance',
      payload
    );
    return;
  }
  logger.warn('Dimension HNSW index remains suspended after failed embedding backfill', payload);
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
        AND embedding_set_id = $2`,
    [EMBEDDINGS_QUEUE, embeddingSetId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

// PGlite runs PostgreSQL in WASM without autovacuum. Each embedding UPDATE
// creates MVCC dead tuples. Reclaim only after the scoped backfill queue drains:
// VACUUM is table-wide maintenance and must not occupy the DB host while active
// embedding workers need claim/complete queries to stay responsive.
const VACUUM_FAILURE_WARN_EVERY = 10;
const DRAIN_TICK_FAILURE_WARN_EVERY = 10;
const deferredDimensionIndexRebuilds = new Set<string>();

interface VacuumLogState {
  consecutiveVacuumFailures: number;
}

interface DrainTickLogState {
  consecutiveDrainTickFailures: number;
}

interface ExistingScopedBackfillDrainResult {
  counts: EmbeddingBackfillQueueCounts;
  done: number;
}

interface DrainExistingScopedBackfillJobsOptions {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs: number;
  db: EmbeddingBackfillDatabase;
  drainTimeoutMs: number;
  embeddingSetId: string;
  existingPending: number;
  now: () => number;
  observeMaintenance?: () => void | Promise<void>;
  onProgress: (done: number, total: number) => void;
  runStartedAt: string;
}

interface EmbeddingBackfillDatabase {
  readonly maintenance?: {
    readonly exec: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  };
  readonly query: <T = unknown>(sql: string, params?: readonly unknown[]) => Promise<{ rows: T[] }>;
}

function normalizeSqlParams(params: unknown): unknown[] | undefined {
  return Array.isArray(params) ? [...params] : params === undefined ? undefined : [params];
}

function requiresMaintenanceExec(sql: string): boolean {
  // The maintenance_work_mem SET/RESET that createDimensionIndex issues around
  // the build must ride the SAME channel as the CREATE INDEX: the setting is
  // session-local, so if the maintenance route ever moves to a dedicated
  // connection, split routing would silently leave the build untuned.
  return (
    sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_') ||
    sql.includes('maintenance_work_mem')
  );
}

function createDimensionIndexDbAdapter(db: EmbeddingBackfillDatabase) {
  return {
    exec: async (sql: string, params?: unknown): Promise<void> => {
      const normalizedParams = normalizeSqlParams(params);
      if (requiresMaintenanceExec(sql)) {
        if (!db.maintenance?.exec) {
          throw new Error(
            'Embedding backfill dimension HNSW rebuild requires DB maintenance exec support.'
          );
        }
        await db.maintenance.exec(sql, normalizedParams);
        return;
      }
      await db.query(sql, normalizedParams);
    },
    query: db.query.bind(db),
  };
}

async function suspendBackfillDimensionIndex(
  db: EmbeddingBackfillDatabase,
  embeddingSetId: string,
  dimension: number,
  now: () => number
): Promise<void> {
  const startedAt = now();
  await suspendDimensionIndexBuilds(
    db,
    dimension,
    `embedding-backfill:${embeddingSetId}`,
    new Date(startedAt).toISOString()
  );
  await dropDimensionIndex(createDimensionIndexDbAdapter(db), dimension);
  logger.info('Suspended dimension HNSW index for embedding backfill', {
    dimension,
    durationMs: now() - startedAt,
    embeddingSetId,
  });
}

async function rebuildBackfillDimensionIndex(
  db: EmbeddingBackfillDatabase,
  embeddingSetId: string,
  dimension: number,
  now: () => number
): Promise<void> {
  const startedAt = now();
  await createDimensionIndex(createDimensionIndexDbAdapter(db), dimension, hnswParams());
  await resumeDimensionIndexBuilds(db, dimension);
  logger.info('Rebuilt dimension HNSW index after embedding backfill', {
    dimension,
    durationMs: now() - startedAt,
    embeddingSetId,
  });
}

interface CompleteBackfillDimensionIndexMaintenanceOptions {
  readonly dimensionIndexMaintenanceStrategy?: DimensionIndexMaintenanceStrategy;
  readonly rebuildDimensionIndexOnCompletion: boolean;
  readonly requestDimensionIndexMaintenance: (
    db: EmbeddingBackfillDatabase,
    request: RequestDimensionIndexMaintenanceInput
  ) => Promise<void>;
}

function createCompleteBackfillDimensionIndexMaintenanceOptions(input: {
  readonly dimensionIndexMaintenanceStrategy: DimensionIndexMaintenanceStrategy | undefined;
  readonly rebuildDimensionIndexOnCompletion: boolean;
  readonly requestDimensionIndexMaintenance: (
    db: EmbeddingBackfillDatabase,
    request: RequestDimensionIndexMaintenanceInput
  ) => Promise<void>;
}): CompleteBackfillDimensionIndexMaintenanceOptions {
  const base = {
    rebuildDimensionIndexOnCompletion: input.rebuildDimensionIndexOnCompletion,
    requestDimensionIndexMaintenance: input.requestDimensionIndexMaintenance,
  };
  return input.dimensionIndexMaintenanceStrategy
    ? { ...base, dimensionIndexMaintenanceStrategy: input.dimensionIndexMaintenanceStrategy }
    : base;
}

async function completeBackfillDimensionIndexMaintenance(
  db: EmbeddingBackfillDatabase,
  embeddingSetId: string,
  dimension: number,
  now: () => number,
  options: CompleteBackfillDimensionIndexMaintenanceOptions
): Promise<boolean> {
  if (options.rebuildDimensionIndexOnCompletion) {
    await rebuildBackfillDimensionIndex(db, embeddingSetId, dimension, now);
    return false;
  }
  if (!options.dimensionIndexMaintenanceStrategy) {
    throw new Error(
      'Deferred dimension HNSW index maintenance requires an explicit maintenance strategy.'
    );
  }
  await options.requestDimensionIndexMaintenance(db, {
    dimension,
    now: () => new Date(now()),
    reason: `embedding-backfill:${embeddingSetId}`,
    strategy: options.dimensionIndexMaintenanceStrategy,
  });
  logger.info('Dimension HNSW index rebuild requested as durable idle maintenance', {
    dimension,
    embeddingSetId,
    maintenanceStrategy: options.dimensionIndexMaintenanceStrategy,
    reason: 'nonblocking-background-indexing',
  });
  return true;
}

function getDeferredDimensionIndexRebuildKey(embeddingSetId: string, dimension: number): string {
  return `${embeddingSetId}:${dimension}`;
}

function scheduleDeferredBackfillDimensionIndexRebuild(params: {
  backlogPollMs: number;
  db: EmbeddingBackfillDatabase;
  dimension: number;
  drainTimeoutMs: number;
  embeddingSetId: string;
  now: () => number;
  dimensionIndexMaintenanceStrategy: DimensionIndexMaintenanceStrategy | undefined;
  rebuildDimensionIndexOnCompletion: boolean;
  requestDimensionIndexMaintenance: (
    db: EmbeddingBackfillDatabase,
    request: RequestDimensionIndexMaintenanceInput
  ) => Promise<void>;
}): void {
  const {
    backlogPollMs,
    db,
    dimension,
    drainTimeoutMs,
    embeddingSetId,
    now,
    dimensionIndexMaintenanceStrategy,
    rebuildDimensionIndexOnCompletion,
    requestDimensionIndexMaintenance,
  } = params;
  const key = getDeferredDimensionIndexRebuildKey(embeddingSetId, dimension);
  if (deferredDimensionIndexRebuilds.has(key)) {
    logger.debug('Deferred dimension HNSW index rebuild already scheduled', {
      dimension,
      embeddingSetId,
    });
    return;
  }
  deferredDimensionIndexRebuilds.add(key);
  void (async () => {
    try {
      const counts = await waitForEmbeddingSetDrain(
        db,
        embeddingSetId,
        backlogPollMs,
        drainTimeoutMs,
        now
      );
      await vacuumBackfillTables(db, { consecutiveVacuumFailures: 0 }, now);
      await completeBackfillDimensionIndexMaintenance(
        db,
        embeddingSetId,
        dimension,
        now,
        createCompleteBackfillDimensionIndexMaintenanceOptions({
          dimensionIndexMaintenanceStrategy,
          rebuildDimensionIndexOnCompletion,
          requestDimensionIndexMaintenance,
        })
      );
      logger.info('Completed deferred dimension HNSW index rebuild after canceled backfill', {
        counts,
        dimension,
        dimensionIndexMaintenanceStrategy,
        embeddingSetId,
        rebuildDimensionIndexOnCompletion,
      });
    } catch (error) {
      logger.error('Deferred dimension HNSW index rebuild after canceled backfill failed', {
        dimension,
        embeddingSetId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      deferredDimensionIndexRebuilds.delete(key);
    }
  })();
}

async function restoreCanceledBackfillDimensionIndex(
  db: EmbeddingBackfillDatabase,
  embeddingSetId: string,
  dimension: number,
  now: () => number,
  options: {
    backlogPollMs: number;
    dimensionIndexMaintenanceStrategy: DimensionIndexMaintenanceStrategy | undefined;
    drainTimeoutMs: number;
    rebuildDimensionIndexOnCompletion: boolean;
    requestDimensionIndexMaintenance: (
      db: EmbeddingBackfillDatabase,
      request: RequestDimensionIndexMaintenanceInput
    ) => Promise<void>;
  }
): Promise<boolean> {
  const pending = await countPendingEmbeddingSetJobs(db, embeddingSetId);
  if (pending > 0) {
    logger.info('Deferred dimension HNSW index rebuild after canceled embedding backfill', {
      dimension,
      embeddingSetId,
      pending,
    });
    scheduleDeferredBackfillDimensionIndexRebuild({
      backlogPollMs: options.backlogPollMs,
      db,
      dimension,
      dimensionIndexMaintenanceStrategy: options.dimensionIndexMaintenanceStrategy,
      drainTimeoutMs: options.drainTimeoutMs,
      embeddingSetId,
      now,
      rebuildDimensionIndexOnCompletion: options.rebuildDimensionIndexOnCompletion,
      requestDimensionIndexMaintenance: options.requestDimensionIndexMaintenance,
    });
    return false;
  }
  const remainsSuspended = await completeBackfillDimensionIndexMaintenance(
    db,
    embeddingSetId,
    dimension,
    now,
    createCompleteBackfillDimensionIndexMaintenanceOptions({
      dimensionIndexMaintenanceStrategy: options.dimensionIndexMaintenanceStrategy,
      rebuildDimensionIndexOnCompletion: options.rebuildDimensionIndexOnCompletion,
      requestDimensionIndexMaintenance: options.requestDimensionIndexMaintenance,
    })
  );
  logger.info('Restored dimension HNSW index after canceled embedding backfill', {
    dimension,
    embeddingSetId,
    rebuildDimensionIndexOnCompletion: options.rebuildDimensionIndexOnCompletion,
  });
  return !remainsSuspended;
}

async function vacuumBackfillTables(
  db: Pick<IDatabase, 'query'>,
  logState: VacuumLogState,
  now: () => number
): Promise<void> {
  const startedAt = now();
  let vacuumTable: 'file_chunks' | 'job_queue' = 'file_chunks';
  try {
    // VACUUM (ANALYZE): PGlite has no autovacuum launcher, so a 0→100k ingest
    // leaves the planner holding empty-table statistics unless ANALYZE runs
    // here; plain VACUUM does not rebuild column histograms.
    await db.query('VACUUM (ANALYZE) file_chunks');
    vacuumTable = 'job_queue';
    await db.query('VACUUM (ANALYZE) job_queue');
    logState.consecutiveVacuumFailures = 0;
    logger.info('Post-drain VACUUM (ANALYZE) after backfill completed', {
      durationMs: now() - startedAt,
      tables: ['file_chunks', 'job_queue'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logState.consecutiveVacuumFailures += 1;
    const shouldWarn =
      logState.consecutiveVacuumFailures === 1 ||
      logState.consecutiveVacuumFailures % VACUUM_FAILURE_WARN_EVERY === 0;
    const logPayload = {
      consecutiveFailureCount: logState.consecutiveVacuumFailures,
      error: message,
      failedTable: vacuumTable,
    };
    if (shouldWarn) {
      logger.warn('Post-drain VACUUM after backfill failed (non-fatal)', logPayload);
      return;
    }
    logger.debug('Post-drain VACUUM after backfill failed (non-fatal)', logPayload);
  }
}

async function waitForEmbeddingSetDrain(
  db: Pick<IDatabase, 'query'>,
  embeddingSetId: string,
  backlogPollMs: number,
  timeoutMs: number,
  now: () => number,
  assertCanContinue?: () => void | Promise<void>,
  updatedAfter?: string,
  observeMaintenance?: () => void | Promise<void>
): Promise<EmbeddingBackfillQueueCounts> {
  const startedAt = now();
  while (true) {
    const pending = await countPendingEmbeddingSetJobs(db, embeddingSetId);
    if (pending === 0) {
      await observeMaintenance?.();
      return await getEmbeddingSetQueueCounts(db, embeddingSetId, updatedAfter);
    }
    await assertCanContinue?.();
    if (now() - startedAt >= timeoutMs) {
      throw new Error(
        `Backfill timed out while waiting for embedding set '${embeddingSetId}' to drain.`
      );
    }
    await observeMaintenance?.();
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

  const canonical = canonicalizeProviderModelKey(rawKey, { fallbackProvider: 'local' });
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

async function drainExistingScopedBackfillJobs({
  assertCanContinue,
  backlogPollMs,
  db,
  drainTimeoutMs,
  embeddingSetId,
  existingPending,
  now,
  observeMaintenance,
  onProgress,
  runStartedAt,
}: DrainExistingScopedBackfillJobsOptions): Promise<ExistingScopedBackfillDrainResult | null> {
  if (existingPending <= 0) {
    return null;
  }

  logger.info('Backfill found existing active scoped jobs; draining before candidate scan', {
    embeddingSetId,
    pending: existingPending,
  });
  onProgress(0, existingPending);
  const counts = await waitForEmbeddingSetDrain(
    db,
    embeddingSetId,
    backlogPollMs,
    drainTimeoutMs,
    now,
    assertCanContinue,
    runStartedAt,
    observeMaintenance
  );
  if (counts.failed > 0) {
    throw new Error(
      `Backfill failed for embedding set '${embeddingSetId}': ${counts.failed} job(s) failed.`
    );
  }
  return { counts, done: existingPending };
}

async function enqueueEmbeddingChunkJobsBatch(
  jobQueue: Pick<EmbeddingBackfillJobQueue, 'enqueueBatch'>,
  batch: BackfillCandidate[],
  embeddingSetId: string,
  metadata: EmbeddingSetJobMetadata
): Promise<BackfillBatchResult> {
  if (!batch.length) {
    return { inserted: 0, selected: 0 };
  }

  const jobs = await jobQueue.enqueueBatch(
    batch.map((row) => ({
      dedupeKey: `${row.id}:${embeddingSetId}:${row.contentHash}`,
      jobType: 'embed_chunk' as const,
      maxAttempts: 5,
      payload: {
        chunkId: String(row.id),
        embeddingSetId,
        expectedDimension: metadata.expectedDimension,
        fileRecordId: String(row.fileRecordId),
        modelKey: metadata.modelKey,
      },
      queue: EMBEDDINGS_QUEUE,
    }))
  );

  return {
    inserted: jobs.length,
    selected: batch.length,
  };
}

function createDrainProgressObserver(
  db: Pick<IDatabase, 'query'>,
  embeddingSetId: string,
  updatedAfter: string,
  onDrainTick?: (completedSinceLastTick: number) => void | Promise<void>,
  logState?: DrainTickLogState
): (() => Promise<void>) | undefined {
  if (!onDrainTick) {
    return;
  }

  let lastObservedSucceeded = 0;
  return async () => {
    const counts = await getEmbeddingSetQueueCounts(db, embeddingSetId, updatedAfter);
    const nextSucceeded = counts.succeeded;
    if (nextSucceeded <= lastObservedSucceeded) {
      return;
    }

    const completedSinceLastTick = nextSucceeded - lastObservedSucceeded;
    lastObservedSucceeded = nextSucceeded;
    try {
      await onDrainTick(completedSinceLastTick);
      if (logState) {
        logState.consecutiveDrainTickFailures = 0;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!logState) {
        logger.debug('Backfill drain maintenance callback failed (no log state)', {
          completedSinceLastTick,
          error: message,
        });
        return;
      }
      logState.consecutiveDrainTickFailures += 1;
      const shouldWarn =
        logState.consecutiveDrainTickFailures === 1 ||
        logState.consecutiveDrainTickFailures % DRAIN_TICK_FAILURE_WARN_EVERY === 0;
      const logPayload = {
        completedSinceLastTick,
        consecutiveFailureCount: logState.consecutiveDrainTickFailures,
        error: message,
      };
      if (shouldWarn) {
        logger.warn('Backfill drain maintenance callback failed (non-fatal)', logPayload);
        return;
      }
      logger.debug('Backfill drain maintenance callback failed (non-fatal)', logPayload);
    }
  };
}

async function repairScopedEmbeddingBackfillQueue(
  jobQueue: Pick<EmbeddingBackfillJobQueue, 'repairUnclaimableQueued'>,
  embeddingSetId: string
): Promise<void> {
  const repairedQueued = await jobQueue.repairUnclaimableQueued(
    EMBEDDINGS_QUEUE,
    EMBEDDING_BACKFILL_QUEUE_REPAIR_LIMIT,
    { embeddingSetId }
  );

  if (repairedQueued === 0) {
    return;
  }

  logger.warn('Backfill recovered blocked embedding jobs before candidate counting', {
    embeddingSetId,
    repairedQueued,
  });
}

interface EnqueueBackfillCandidateBatchesOptions {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs: number;
  db: EmbeddingBackfillDatabase;
  embeddingSetId: string;
  initialDone: number;
  jobQueue: EmbeddingBackfillJobQueue;
  maxQueueDepth: number;
  metadata: EmbeddingSetJobMetadata;
  now: () => number;
  observeMaintenance: () => Promise<void>;
  onProgress: (done: number, total: number) => void;
  progressIntervalBatches: number;
  progressIntervalMs: number;
  queueCapacityTimeoutMs: number;
  total: number;
}

async function enqueueBackfillCandidateBatches(
  options: EnqueueBackfillCandidateBatchesOptions
): Promise<number> {
  const {
    assertCanContinue,
    backlogPollMs,
    db,
    embeddingSetId,
    initialDone,
    jobQueue,
    maxQueueDepth,
    metadata,
    now,
    observeMaintenance,
    onProgress,
    progressIntervalBatches,
    progressIntervalMs,
    queueCapacityTimeoutMs,
    total,
  } = options;
  let availableCapacity = 0;
  let batchesSinceProgress = 0;
  let cursor: string | null = null;
  let done = initialDone;
  let exhaustedCursor = false;
  let lastReportedAt = Number.NEGATIVE_INFINITY;
  let lastReportedDone = -1;
  const reportProgress = (
    nextDone: number,
    nextTotal: number,
    reportOptions?: { force?: boolean }
  ): void => {
    if (lastReportedDone === nextDone) {
      return;
    }
    const currentTime = now();
    if (!(reportOptions?.force ?? false) && currentTime - lastReportedAt < progressIntervalMs) {
      return;
    }
    lastReportedDone = nextDone;
    lastReportedAt = currentTime;
    onProgress(nextDone, nextTotal);
  };

  reportProgress(done, total, { force: true });

  while (done < total && !exhaustedCursor) {
    // Capacity is only refreshed when the prior pass actually inserted new work. A fully
    // deduplicated batch leaves queue depth unchanged, so reusing the prior capacity snapshot
    // avoids unnecessary queue-stat polling while preserving the same backlog bound.
    if (availableCapacity <= 0) {
      availableCapacity = await waitForQueueCapacity(
        jobQueue,
        maxQueueDepth,
        backlogPollMs,
        queueCapacityTimeoutMs,
        now,
        assertCanContinue,
        observeMaintenance
      );
    }
    const batchLimit = Math.min(
      EMBEDDING_BACKFILL_ENQUEUE_BATCH_SIZE,
      total - done,
      availableCapacity
    );
    const batch = await loadBackfillCandidateBatch(db, embeddingSetId, cursor, batchLimit);
    if (batch.length === 0) {
      exhaustedCursor = true;
      break;
    }
    cursor = batch.at(-1)?.id ?? cursor;
    const enqueueStartedAt = now();
    const { inserted, selected } = await enqueueEmbeddingChunkJobsBatch(
      jobQueue,
      batch,
      embeddingSetId,
      metadata
    );
    logger.trace('Embedded batch enqueued', {
      batchSize: batch.length,
      embeddingSetId,
      inserted,
    });
    logger.info('Backfill enqueue batch completed', {
      batchSize: batch.length,
      durationMs: now() - enqueueStartedAt,
      embeddingSetId,
      inserted,
      selected,
    });
    // Progress tracks jobs durably accepted into job_queue, not just selected candidates.
    // Dedupe can make inserted < selected and that is the value users can rely on.
    // Cursor exhaustion is still the authoritative loop terminator for that case.
    done = Math.min(total, done + inserted);
    availableCapacity = Math.max(0, availableCapacity - inserted);
    batchesSinceProgress += 1;
    if (
      done < total &&
      (batchesSinceProgress >= progressIntervalBatches ||
        now() - lastReportedAt >= progressIntervalMs)
    ) {
      reportProgress(done, total);
      batchesSinceProgress = 0;
    }
    if (selected === batchLimit && done < total) {
      await cooperativeYield();
    }
  }

  return done;
}

export async function enqueueEmbeddingBackfill(
  db: EmbeddingBackfillDatabase,
  jobQueue: EmbeddingBackfillJobQueue,
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
    now,
    progressIntervalBatches,
    progressIntervalMs,
    queueCapacityTimeoutMs,
    dimensionIndexMaintenanceStrategy,
    rebuildDimensionIndexOnCompletion,
    requestDimensionIndexMaintenance: requestDimensionIndexMaintenanceForBackfill,
  } = resolveEnqueueEmbeddingBackfillOptions(options);
  const onDrainTick = options?.onDrainTick;

  const runStartedAt = new Date().toISOString();
  const vacuumLogState: VacuumLogState = { consecutiveVacuumFailures: 0 };
  const drainTickLogState: DrainTickLogState = { consecutiveDrainTickFailures: 0 };
  const observeDrainProgress = createDrainProgressObserver(
    db,
    embeddingSetId,
    runStartedAt,
    onDrainTick,
    drainTickLogState
  );
  const observeMaintenance = async (): Promise<void> => {
    await observeDrainProgress?.();
  };
  logger.info('Backfill requested', { embeddingSetId });
  const metadata = await resolveEmbeddingSetJobMetadata(db, embeddingSetId);
  let dimensionIndexSuspended = false;

  try {
    await suspendBackfillDimensionIndex(db, embeddingSetId, metadata.expectedDimension, now);
    dimensionIndexSuspended = true;
    await repairScopedEmbeddingBackfillQueue(jobQueue, embeddingSetId);
    const existingPending = await countPendingEmbeddingSetJobs(db, embeddingSetId);
    const drainedExisting = await drainExistingScopedBackfillJobs({
      ...(assertCanContinue ? { assertCanContinue } : {}),
      backlogPollMs,
      db,
      drainTimeoutMs,
      embeddingSetId,
      existingPending,
      now,
      observeMaintenance,
      onProgress,
      runStartedAt,
    });
    let done = drainedExisting?.done ?? 0;
    const candidates = await countBackfillCandidates(db, embeddingSetId);
    const total = done + candidates;
    logger.info('Embedding set metadata resolved for backfill', {
      candidates,
      embeddingSetId,
      expectedDimension: metadata.expectedDimension,
      modelKey: metadata.modelKey,
      preExistingDrained: done,
      total,
    });
    if (candidates === 0 && drainedExisting) {
      await vacuumBackfillTables(db, vacuumLogState, now);
      dimensionIndexSuspended = await completeBackfillDimensionIndexMaintenance(
        db,
        embeddingSetId,
        metadata.expectedDimension,
        now,
        createCompleteBackfillDimensionIndexMaintenanceOptions({
          dimensionIndexMaintenanceStrategy,
          rebuildDimensionIndexOnCompletion,
          requestDimensionIndexMaintenance: requestDimensionIndexMaintenanceForBackfill,
        })
      );
      onProgress(done, total);
      return finalizeBackfillCounts(embeddingSetId, total, done, drainedExisting.counts);
    }

    done = await enqueueBackfillCandidateBatches({
      ...(assertCanContinue ? { assertCanContinue } : {}),
      backlogPollMs,
      db,
      embeddingSetId,
      initialDone: done,
      jobQueue,
      maxQueueDepth,
      metadata,
      now,
      observeMaintenance,
      onProgress,
      progressIntervalBatches,
      progressIntervalMs,
      queueCapacityTimeoutMs,
      total,
    });

    const drainedCounts = await waitForEmbeddingSetDrain(
      db,
      embeddingSetId,
      backlogPollMs,
      drainTimeoutMs,
      now,
      assertCanContinue,
      runStartedAt,
      observeMaintenance
    );
    if (drainedCounts.failed > 0) {
      throw new Error(
        `Backfill failed for embedding set '${embeddingSetId}': ${drainedCounts.failed} job(s) failed.`
      );
    }
    onProgress(total, total);
    // Final VACUUM to reclaim all dead tuples from the completed backfill
    await vacuumBackfillTables(db, vacuumLogState, now);
    dimensionIndexSuspended = await completeBackfillDimensionIndexMaintenance(
      db,
      embeddingSetId,
      metadata.expectedDimension,
      now,
      createCompleteBackfillDimensionIndexMaintenanceOptions({
        dimensionIndexMaintenanceStrategy,
        rebuildDimensionIndexOnCompletion,
        requestDimensionIndexMaintenance: requestDimensionIndexMaintenanceForBackfill,
      })
    );
    logger.info('Backfill complete', { done, embeddingSetId, total });
    return finalizeBackfillCounts(embeddingSetId, total, done, drainedCounts);
  } catch (error) {
    if (dimensionIndexSuspended) {
      if (isEmbeddingBackfillCancellationError(error)) {
        dimensionIndexSuspended = !(await restoreCanceledBackfillDimensionIndex(
          db,
          embeddingSetId,
          metadata.expectedDimension,
          now,
          {
            backlogPollMs,
            dimensionIndexMaintenanceStrategy,
            drainTimeoutMs,
            rebuildDimensionIndexOnCompletion,
            requestDimensionIndexMaintenance: requestDimensionIndexMaintenanceForBackfill,
          }
        ));
        throw error;
      }
      logSuspendedDimensionIndexAfterBackfillError(error, {
        dimension: metadata.expectedDimension,
        embeddingSetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
