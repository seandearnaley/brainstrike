import {
  buildEmbeddingJobDedupeKey,
  type EnqueueParams,
  type JobQueueStateCounts,
} from '@brainstrike/db';
import { canonicalizeProviderModelKey } from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';

export interface TursoEmbeddingBackfillQueueCounts {
  failed: number;
  queued: number;
  running: number;
  succeeded: number;
}

export interface EnqueueTursoEmbeddingBackfillOptions {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs?: number;
  drainTimeoutMs?: number;
  maxQueueDepth?: number;
  now?: () => number;
  onDrainTick?: (completedSinceLastTick: number) => void | Promise<void>;
  progressIntervalBatches?: number;
  progressIntervalMs?: number;
  queueCapacityTimeoutMs?: number;
}

interface ResolvedEnqueueTursoEmbeddingBackfillOptions {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs: number;
  drainTimeoutMs: number;
  maxQueueDepth: number;
  now: () => number;
  onDrainTick?: (completedSinceLastTick: number) => void | Promise<void>;
  progressIntervalBatches: number;
  progressIntervalMs: number;
  queueCapacityTimeoutMs: number;
}

interface TursoBackfillCandidate {
  readonly contentHash: string;
  readonly fileRecordId: string;
  readonly id: string;
}

interface TursoBackfillChunkRepository {
  countEmbeddingBackfillCandidates(
    embeddingSetId: string,
    options?: { readonly queue?: string }
  ): Promise<number>;
  findEmbeddingBackfillCandidates(options: {
    readonly afterChunkId?: string | null;
    readonly embeddingSetId: string;
    readonly limit: number;
    readonly queue?: string;
  }): Promise<TursoBackfillCandidate[]>;
}

interface TursoBackfillEmbeddingSetsRepository {
  getById(id: string): Promise<{ dimensions: number | string; modelKey: string } | null>;
}

interface TursoBackfillJobQueue {
  enqueueBatch(params: EnqueueParams[]): Promise<readonly unknown[]>;
  getEmbeddingSetQueueCounts(
    queue: string,
    embeddingSetId: string,
    options?: { readonly updatedAfter?: string }
  ): Promise<JobQueueStateCounts>;
  getQueueStats(queue?: string): Promise<
    Array<{
      failed: number;
      queue: string;
      queued: number;
      running: number;
      succeeded: number;
    }>
  >;
  repairUnclaimableQueued(
    queue?: string,
    limit?: number,
    options?: { readonly embeddingSetId?: string }
  ): Promise<number>;
}

export interface TursoEmbeddingBackfillRunnerDependencies {
  chunkRepository: TursoBackfillChunkRepository;
  embeddingSetsRepository: TursoBackfillEmbeddingSetsRepository;
  jobQueue: TursoBackfillJobQueue;
  queue?: string;
}

interface TursoEmbeddingSetJobMetadata {
  expectedDimension: number;
  modelKey: string;
}

interface TursoBackfillBatchResult {
  inserted: number;
  selected: number;
}

interface TursoExistingBackfillDrainResult {
  done: number;
}

interface TursoQueueBacklogSnapshot {
  failed: number;
  queued: number;
  running: number;
  succeeded: number;
}

export interface TursoEmbeddingBackfillRunner {
  enqueue(
    embeddingSetId: string,
    onProgress: (done: number, total: number) => void,
    options?: EnqueueTursoEmbeddingBackfillOptions
  ): Promise<TursoEmbeddingBackfillQueueCounts>;
}

const logger = createLogger('DesktopTursoEmbeddingBackfill');
const EMBEDDINGS_QUEUE = 'embeddings';
const BACKFILL_ENQUEUE_BATCH_SIZE = 32;
const BACKFILL_MAX_QUEUE_DEPTH = 64;
const BACKFILL_BACKLOG_POLL_MS = 100;
const BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS = 30_000;
const BACKFILL_DRAIN_TIMEOUT_MS = 300_000;
const BACKFILL_PROGRESS_INTERVAL_MS = 250;
const BACKFILL_QUEUE_REPAIR_LIMIT = 1000;

function resolvePositiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer when configured.`);
  }
  return resolved;
}

function resolveOptions(
  options: EnqueueTursoEmbeddingBackfillOptions | undefined
): ResolvedEnqueueTursoEmbeddingBackfillOptions {
  return {
    backlogPollMs: resolvePositiveIntegerOption(
      options?.backlogPollMs,
      BACKFILL_BACKLOG_POLL_MS,
      'backlogPollMs'
    ),
    drainTimeoutMs: resolvePositiveIntegerOption(
      options?.drainTimeoutMs,
      BACKFILL_DRAIN_TIMEOUT_MS,
      'drainTimeoutMs'
    ),
    maxQueueDepth: resolvePositiveIntegerOption(
      options?.maxQueueDepth,
      BACKFILL_MAX_QUEUE_DEPTH,
      'maxQueueDepth'
    ),
    now: options?.now ?? Date.now,
    progressIntervalBatches: resolvePositiveIntegerOption(
      options?.progressIntervalBatches,
      1,
      'progressIntervalBatches'
    ),
    progressIntervalMs: resolvePositiveIntegerOption(
      options?.progressIntervalMs,
      BACKFILL_PROGRESS_INTERVAL_MS,
      'progressIntervalMs'
    ),
    queueCapacityTimeoutMs: resolvePositiveIntegerOption(
      options?.queueCapacityTimeoutMs,
      BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS,
      'queueCapacityTimeoutMs'
    ),
    ...(options?.assertCanContinue ? { assertCanContinue: options.assertCanContinue } : {}),
    ...(options?.onDrainTick ? { onDrainTick: options.onDrainTick } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function optionalBackfillLoopCallbacks(callbacks: {
  readonly assertCanContinue: (() => void | Promise<void>) | undefined;
  readonly observeMaintenance: (() => Promise<void>) | undefined;
}): {
  readonly assertCanContinue?: () => void | Promise<void>;
  readonly observeMaintenance?: () => Promise<void>;
} {
  return {
    ...(callbacks.assertCanContinue ? { assertCanContinue: callbacks.assertCanContinue } : {}),
    ...(callbacks.observeMaintenance ? { observeMaintenance: callbacks.observeMaintenance } : {}),
  };
}

function cooperativeYield(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function toQueueCounts(counts: JobQueueStateCounts): TursoEmbeddingBackfillQueueCounts {
  return {
    failed: counts.failed,
    queued: counts.queued,
    running: counts.running,
    succeeded: counts.succeeded,
  };
}

async function getEmbeddingQueueBacklogSnapshot(
  jobQueue: Pick<TursoBackfillJobQueue, 'getQueueStats'>,
  queue: string
): Promise<TursoQueueBacklogSnapshot> {
  const snapshot = (await jobQueue.getQueueStats(queue))[0];
  if (!snapshot) {
    return { failed: 0, queued: 0, running: 0, succeeded: 0 };
  }
  return {
    failed: Math.max(0, Number(snapshot.failed ?? 0)),
    queued: Math.max(0, Number(snapshot.queued ?? 0)),
    running: Math.max(0, Number(snapshot.running ?? 0)),
    succeeded: Math.max(0, Number(snapshot.succeeded ?? 0)),
  };
}

async function waitForQueueCapacity(params: {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs: number;
  jobQueue: Pick<TursoBackfillJobQueue, 'getQueueStats'>;
  maxQueueDepth: number;
  now: () => number;
  observeMaintenance?: () => Promise<void>;
  queue: string;
  timeoutMs: number;
}): Promise<number> {
  const startedAt = params.now();
  while (true) {
    await params.assertCanContinue?.();
    const backlog = await getEmbeddingQueueBacklogSnapshot(params.jobQueue, params.queue);
    const capacity = params.maxQueueDepth - (backlog.queued + backlog.running);
    if (capacity > 0) {
      return capacity;
    }
    if (params.now() - startedAt >= params.timeoutMs) {
      throw new Error(
        `Turso backfill timed out while waiting for queue capacity below ${params.maxQueueDepth} jobs ` +
          `(queued=${backlog.queued}, running=${backlog.running}, failed=${backlog.failed}, succeeded=${backlog.succeeded}).`
      );
    }
    await params.observeMaintenance?.();
    await sleep(params.backlogPollMs);
  }
}

async function resolveEmbeddingSetJobMetadata(
  repository: TursoBackfillEmbeddingSetsRepository,
  embeddingSetId: string
): Promise<TursoEmbeddingSetJobMetadata> {
  const embeddingSet = await repository.getById(embeddingSetId);
  if (!embeddingSet) {
    logger.error('Failed to resolve Turso embedding set metadata (missing row)', {
      embeddingSetId,
    });
    throw new Error(`Embedding set ${embeddingSetId} not found`);
  }
  const rawKey = embeddingSet.modelKey.trim();
  if (!rawKey) {
    logger.error('Failed to resolve Turso embedding set metadata (missing model_key)', {
      embeddingSetId,
    });
    throw new Error(`Embedding set ${embeddingSetId} is missing model_key metadata`);
  }
  const canonical = canonicalizeProviderModelKey(rawKey, { fallbackProvider: 'local' });
  if (!canonical) {
    logger.error('Failed to resolve Turso embedding set metadata (invalid model_key)', {
      embeddingSetId,
      modelKey: embeddingSet.modelKey,
    });
    throw new Error(`Embedding set ${embeddingSetId} has invalid model_key metadata`);
  }
  const expectedDimension = Number(embeddingSet.dimensions);
  if (!Number.isFinite(expectedDimension) || expectedDimension <= 0) {
    logger.error('Failed to resolve Turso embedding set metadata (invalid dimension)', {
      dimensions: embeddingSet.dimensions,
      embeddingSetId,
    });
    throw new Error(`Embedding set ${embeddingSetId} is missing dimension metadata`);
  }
  return { expectedDimension, modelKey: canonical.composite };
}

async function waitForEmbeddingSetDrain(params: {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs: number;
  embeddingSetId: string;
  jobQueue: Pick<TursoBackfillJobQueue, 'getEmbeddingSetQueueCounts'>;
  now: () => number;
  observeMaintenance?: () => Promise<void>;
  queue: string;
  timeoutMs: number;
}): Promise<TursoEmbeddingBackfillQueueCounts> {
  const startedAt = params.now();
  while (true) {
    const counts = toQueueCounts(
      await params.jobQueue.getEmbeddingSetQueueCounts(params.queue, params.embeddingSetId)
    );
    if (counts.queued === 0 && counts.running === 0) {
      await params.observeMaintenance?.();
      return counts;
    }
    await params.assertCanContinue?.();
    if (params.now() - startedAt >= params.timeoutMs) {
      throw new Error(
        `Turso backfill timed out while waiting for embedding set '${params.embeddingSetId}' to drain.`
      );
    }
    await params.observeMaintenance?.();
    await sleep(params.backlogPollMs);
  }
}

function createDrainProgressObserver(params: {
  baselineSucceeded: number;
  embeddingSetId: string;
  jobQueue: Pick<TursoBackfillJobQueue, 'getEmbeddingSetQueueCounts'>;
  onDrainTick: ((completedSinceLastTick: number) => void | Promise<void>) | undefined;
  queue: string;
}): (() => Promise<void>) | undefined {
  if (!params.onDrainTick) {
    return;
  }
  let lastObservedSucceeded = params.baselineSucceeded;
  return async () => {
    const counts = await params.jobQueue.getEmbeddingSetQueueCounts(
      params.queue,
      params.embeddingSetId
    );
    if (counts.succeeded <= lastObservedSucceeded) {
      return;
    }
    const completedSinceLastTick = counts.succeeded - lastObservedSucceeded;
    lastObservedSucceeded = counts.succeeded;
    try {
      await params.onDrainTick?.(completedSinceLastTick);
    } catch (error) {
      logger.warn('Turso backfill drain maintenance callback failed (non-fatal)', {
        completedSinceLastTick,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

async function enqueueCandidateBatch(params: {
  batch: readonly TursoBackfillCandidate[];
  embeddingSetId: string;
  jobQueue: Pick<TursoBackfillJobQueue, 'enqueueBatch'>;
  metadata: TursoEmbeddingSetJobMetadata;
  queue: string;
}): Promise<TursoBackfillBatchResult> {
  if (params.batch.length === 0) {
    return { inserted: 0, selected: 0 };
  }
  const jobs = await params.jobQueue.enqueueBatch(
    params.batch.map((row) => ({
      dedupeKey: buildEmbeddingJobDedupeKey(row.id, params.embeddingSetId, row.contentHash),
      jobType: 'embed_chunk' as const,
      maxAttempts: 5,
      payload: {
        chunkId: String(row.id),
        embeddingSetId: params.embeddingSetId,
        expectedDimension: params.metadata.expectedDimension,
        fileRecordId: String(row.fileRecordId),
        modelKey: params.metadata.modelKey,
      },
      queue: params.queue,
    }))
  );
  return { inserted: jobs.length, selected: params.batch.length };
}

async function repairScopedEmbeddingBackfillQueue(params: {
  embeddingSetId: string;
  jobQueue: Pick<TursoBackfillJobQueue, 'repairUnclaimableQueued'>;
  queue: string;
}): Promise<void> {
  const repairedQueued = await params.jobQueue.repairUnclaimableQueued(
    params.queue,
    BACKFILL_QUEUE_REPAIR_LIMIT,
    { embeddingSetId: params.embeddingSetId }
  );
  if (repairedQueued > 0) {
    logger.warn('Turso backfill recovered blocked embedding jobs before candidate counting', {
      embeddingSetId: params.embeddingSetId,
      repairedQueued,
    });
  }
}

async function getRunScopedQueueCounts(params: {
  embeddingSetId: string;
  jobQueue: Pick<TursoBackfillJobQueue, 'getEmbeddingSetQueueCounts'>;
  queue: string;
  runStartedAt: string;
}): Promise<TursoEmbeddingBackfillQueueCounts> {
  return toQueueCounts(
    await params.jobQueue.getEmbeddingSetQueueCounts(params.queue, params.embeddingSetId, {
      updatedAfter: params.runStartedAt,
    })
  );
}

function assertNoRunScopedFailures(params: {
  counts: TursoEmbeddingBackfillQueueCounts;
  embeddingSetId: string;
}): void {
  if (params.counts.failed === 0) {
    return;
  }
  throw new Error(
    `Turso backfill failed for embedding set '${params.embeddingSetId}': ${params.counts.failed} job(s) failed.`
  );
}

async function drainExistingScopedBackfillJobs(params: {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs: number;
  embeddingSetId: string;
  existingPending: number;
  jobQueue: Pick<TursoBackfillJobQueue, 'getEmbeddingSetQueueCounts'>;
  now: () => number;
  observeMaintenance?: () => Promise<void>;
  onProgress: (done: number, total: number) => void;
  queue: string;
  runStartedAt: string;
  timeoutMs: number;
}): Promise<TursoExistingBackfillDrainResult | null> {
  if (params.existingPending <= 0) {
    return null;
  }

  logger.info('Turso backfill found existing active scoped jobs; draining first', {
    embeddingSetId: params.embeddingSetId,
    pending: params.existingPending,
  });
  params.onProgress(0, params.existingPending);
  await waitForEmbeddingSetDrain({
    backlogPollMs: params.backlogPollMs,
    embeddingSetId: params.embeddingSetId,
    jobQueue: params.jobQueue,
    now: params.now,
    queue: params.queue,
    timeoutMs: params.timeoutMs,
    ...optionalBackfillLoopCallbacks({
      assertCanContinue: params.assertCanContinue,
      observeMaintenance: params.observeMaintenance,
    }),
  });
  assertNoRunScopedFailures({
    counts: await getRunScopedQueueCounts({
      embeddingSetId: params.embeddingSetId,
      jobQueue: params.jobQueue,
      queue: params.queue,
      runStartedAt: params.runStartedAt,
    }),
    embeddingSetId: params.embeddingSetId,
  });
  return { done: params.existingPending };
}

async function enqueueCandidateBatches(params: {
  assertCanContinue?: () => void | Promise<void>;
  backlogPollMs: number;
  chunkRepository: TursoBackfillChunkRepository;
  embeddingSetId: string;
  initialDone: number;
  jobQueue: Pick<
    TursoBackfillJobQueue,
    'enqueueBatch' | 'getQueueStats' | 'getEmbeddingSetQueueCounts'
  >;
  maxQueueDepth: number;
  metadata: TursoEmbeddingSetJobMetadata;
  now: () => number;
  observeMaintenance?: () => Promise<void>;
  onProgress: (done: number, total: number) => void;
  progressIntervalBatches: number;
  progressIntervalMs: number;
  queue: string;
  queueCapacityTimeoutMs: number;
  total: number;
}): Promise<number> {
  let cursor: string | null = null;
  let availableCapacity = 0;
  let batchesSinceProgress = 0;
  let done = params.initialDone;
  let exhaustedCursor = false;
  let lastReportedAt = Number.NEGATIVE_INFINITY;

  while (done < params.total && !exhaustedCursor) {
    await params.assertCanContinue?.();
    if (availableCapacity <= 0) {
      availableCapacity = await waitForQueueCapacity({
        backlogPollMs: params.backlogPollMs,
        jobQueue: params.jobQueue,
        maxQueueDepth: params.maxQueueDepth,
        now: params.now,
        queue: params.queue,
        timeoutMs: params.queueCapacityTimeoutMs,
        ...optionalBackfillLoopCallbacks({
          assertCanContinue: params.assertCanContinue,
          observeMaintenance: params.observeMaintenance,
        }),
      });
    }
    const batchLimit = Math.min(
      BACKFILL_ENQUEUE_BATCH_SIZE,
      params.total - done,
      availableCapacity
    );
    const batch = await params.chunkRepository.findEmbeddingBackfillCandidates({
      afterChunkId: cursor,
      embeddingSetId: params.embeddingSetId,
      limit: batchLimit,
      queue: params.queue,
    });
    if (batch.length === 0) {
      exhaustedCursor = true;
      break;
    }
    cursor = batch.at(-1)?.id ?? cursor;
    const { inserted, selected } = await enqueueCandidateBatch({
      batch,
      embeddingSetId: params.embeddingSetId,
      jobQueue: params.jobQueue,
      metadata: params.metadata,
      queue: params.queue,
    });
    done = Math.min(params.total, done + inserted);
    availableCapacity = Math.max(0, availableCapacity - inserted);
    batchesSinceProgress += 1;
    const now = params.now();
    if (
      done < params.total &&
      (batchesSinceProgress >= params.progressIntervalBatches ||
        now - lastReportedAt >= params.progressIntervalMs)
    ) {
      lastReportedAt = now;
      batchesSinceProgress = 0;
      params.onProgress(done, params.total);
    }
    if (selected === batchLimit && done < params.total) {
      await cooperativeYield();
    }
  }

  return done;
}

export function createTursoEmbeddingBackfillRunner(
  dependencies: TursoEmbeddingBackfillRunnerDependencies
): TursoEmbeddingBackfillRunner {
  const queue = dependencies.queue ?? EMBEDDINGS_QUEUE;
  return {
    async enqueue(embeddingSetId, onProgress, options) {
      if (typeof embeddingSetId !== 'string' || embeddingSetId.trim().length === 0) {
        throw new Error('Turso embedding backfill requires a non-empty embeddingSetId.');
      }

      const resolvedOptions = resolveOptions(options);
      logger.info('Turso backfill requested', { embeddingSetId });
      const runStartedAt = new Date().toISOString();
      await resolvedOptions.assertCanContinue?.();
      const metadata = await resolveEmbeddingSetJobMetadata(
        dependencies.embeddingSetsRepository,
        embeddingSetId
      );
      await repairScopedEmbeddingBackfillQueue({
        embeddingSetId,
        jobQueue: dependencies.jobQueue,
        queue,
      });

      const beforeCounts = toQueueCounts(
        await dependencies.jobQueue.getEmbeddingSetQueueCounts(queue, embeddingSetId)
      );
      const observeMaintenance = createDrainProgressObserver({
        baselineSucceeded: beforeCounts.succeeded,
        embeddingSetId,
        jobQueue: dependencies.jobQueue,
        onDrainTick: resolvedOptions.onDrainTick,
        queue,
      });
      const existingPending = beforeCounts.queued + beforeCounts.running;
      const drainedExisting = await drainExistingScopedBackfillJobs({
        backlogPollMs: resolvedOptions.backlogPollMs,
        embeddingSetId,
        existingPending,
        jobQueue: dependencies.jobQueue,
        now: resolvedOptions.now,
        onProgress,
        queue,
        runStartedAt,
        timeoutMs: resolvedOptions.drainTimeoutMs,
        ...optionalBackfillLoopCallbacks({
          assertCanContinue: resolvedOptions.assertCanContinue,
          observeMaintenance,
        }),
      });
      let done = drainedExisting?.done ?? 0;

      const candidates = await dependencies.chunkRepository.countEmbeddingBackfillCandidates(
        embeddingSetId,
        { queue }
      );
      const total = done + candidates;
      logger.info('Turso embedding set metadata resolved for backfill', {
        candidates,
        embeddingSetId,
        expectedDimension: metadata.expectedDimension,
        modelKey: metadata.modelKey,
        preExistingDrained: done,
        total,
      });
      onProgress(done, total);

      done = await enqueueCandidateBatches({
        backlogPollMs: resolvedOptions.backlogPollMs,
        chunkRepository: dependencies.chunkRepository,
        embeddingSetId,
        initialDone: done,
        jobQueue: dependencies.jobQueue,
        maxQueueDepth: resolvedOptions.maxQueueDepth,
        metadata,
        now: resolvedOptions.now,
        onProgress,
        progressIntervalBatches: resolvedOptions.progressIntervalBatches,
        progressIntervalMs: resolvedOptions.progressIntervalMs,
        queue,
        queueCapacityTimeoutMs: resolvedOptions.queueCapacityTimeoutMs,
        total,
        ...optionalBackfillLoopCallbacks({
          assertCanContinue: resolvedOptions.assertCanContinue,
          observeMaintenance,
        }),
      });

      await waitForEmbeddingSetDrain({
        backlogPollMs: resolvedOptions.backlogPollMs,
        embeddingSetId,
        jobQueue: dependencies.jobQueue,
        now: resolvedOptions.now,
        queue,
        timeoutMs: resolvedOptions.drainTimeoutMs,
        ...optionalBackfillLoopCallbacks({
          assertCanContinue: resolvedOptions.assertCanContinue,
          observeMaintenance,
        }),
      });
      const runScopedCounts = await getRunScopedQueueCounts({
        embeddingSetId,
        jobQueue: dependencies.jobQueue,
        queue,
        runStartedAt,
      });
      assertNoRunScopedFailures({ counts: runScopedCounts, embeddingSetId });
      onProgress(total, total);
      logger.info('Turso backfill complete', {
        embeddingSetId,
        enqueued: done,
        queueCounts: runScopedCounts,
        total,
      });
      return runScopedCounts;
    },
  };
}
