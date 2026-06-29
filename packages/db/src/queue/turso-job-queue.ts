import { emitQueueTelemetry, type QueueTelemetryAdapter } from '@brainstrike/queue';
import { createLogger, generateUUID } from '@brainstrike/utils';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbQueryResult,
  BrainstrikeDbTransactionClient,
} from '../architecture/brainstrike-db-client-contract.js';
import { TursoFileChunkRepository } from '../repositories/turso-file-chunk-repository.js';
import type {
  CancelParams,
  ClaimParams,
  CompleteEmbeddingChunkParams,
  CompleteParams,
  EnqueueParams,
  FailBatchParams,
  FailParams,
  Job,
  JobQueueMetricsOptions,
  JobQueueMetricsSnapshot,
  JobQueueStateCounts,
  JobRow,
  JobState,
  QueueRetryOptions,
} from './job-queue.js';

const JOB_QUEUE_TELEMETRY_ADAPTER: QueueTelemetryAdapter = 'job-queue';
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_BATCH_SIZE = 9000;
const MAX_TURSO_WRITE_RETRIES = 6;
const TURSO_WRITE_RETRY_BASE_DELAY_MS = 5;
const logger = createLogger('TursoJobQueue');

export interface TursoJobQueueQueryClient {
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: unknown[]
  ) => Promise<BrainstrikeDbQueryResult<TRecord>>;
}

export interface TursoJobQueueReadModel {
  getCountsByState(
    queue?: string
  ): Promise<Array<{ queue: string; state: JobState; count: number }>>;
  getEmbeddingSetQueueCounts(queue: string, embeddingSetId: string): Promise<JobQueueStateCounts>;
  getQueueMetrics(queue: string, options: JobQueueMetricsOptions): Promise<JobQueueMetricsSnapshot>;
  getQueueStats(queue?: string): Promise<
    Array<{
      failed: number;
      nextRunnableAt?: string | null;
      queue: string;
      queued: number;
      running: number;
      succeeded: number;
    }>
  >;
}

export function createTursoJobQueueReadModel(db: TursoJobQueueQueryClient): TursoJobQueueReadModel {
  return {
    getCountsByState: (queue) => getCountsByState(db, queue),
    getEmbeddingSetQueueCounts: (queue, embeddingSetId) =>
      getEmbeddingSetQueueCounts(db, queue, embeddingSetId),
    getQueueMetrics: (queue, options) => getQueueMetrics(db, queue, options),
    getQueueStats: (queue) => getQueueStats(db, queue),
  };
}

export class TursoJobQueue {
  private readonly readModel: TursoJobQueueReadModel;

  constructor(
    private readonly db: BrainstrikeDbExecutionClient,
    private readonly defaults: { maxAttempts?: number } = {}
  ) {
    this.readModel = createTursoJobQueueReadModel(db);
  }

  retryPolicy(attempts: number): number {
    const base = 1000;
    const cap = 5 * 60 * 1000;
    const exp = Math.min(cap, base * 2 ** Math.max(0, attempts));
    const jitter = Math.floor(exp * (0.2 + Math.random() * 0.3));
    return Math.min(cap, Math.max(base, jitter));
  }

  async enqueue(params: EnqueueParams): Promise<Job> {
    const jobs = await this.enqueueBatch([params]);
    const job = jobs[0];
    if (!job) {
      throw new Error('Failed to insert Turso job.');
    }
    return job;
  }

  async enqueueBatch(params: EnqueueParams[]): Promise<Job[]> {
    if (params.length === 0) {
      return [];
    }
    if (params.length > MAX_BATCH_SIZE) {
      throw new Error(
        `Batch size ${params.length} exceeds maximum supported size of ${MAX_BATCH_SIZE}`
      );
    }

    const result = await withTursoWriteRetry('enqueueBatch', async () =>
      this.db.transaction(async (tx) => enqueueJobs(tx, params, this.defaults.maxAttempts))
    );
    const { jobs } = result;
    if (jobs.length > 0) {
      logger.debug('Turso jobs enqueued in batch', { count: jobs.length });
      emitEnqueueTelemetry(jobs, result.insertedJobIds);
    }
    return jobs;
  }

  async claim(params: ClaimParams): Promise<Job | null> {
    const jobs = await this.claimMany({ ...params, limit: 1 });
    return jobs[0] ?? null;
  }

  async claimMany(params: ClaimParams & { limit?: number }): Promise<Job[]> {
    const now = params.now ?? new Date().toISOString();
    const leaseToken = generateUUID();
    const leasedUntil = addMs(now, params.leaseMs);
    const limit = Math.max(1, params.limit ?? 1);

    const jobs = await withTursoWriteRetry('claimMany', async () =>
      this.db.transaction(async (tx) => {
        const candidates = await tx.query<JobRow>(
          `SELECT *
             FROM job_queue
            WHERE queue = ?
              AND attempts < max_attempts
              AND (
                    (state = 'queued' AND run_at <= ?)
                 OR (state = 'running' AND (leased_until IS NULL OR leased_until <= ?))
                  )
            ORDER BY run_at ASC, id ASC
            LIMIT ?`,
          [params.queue, now, now, limit]
        );

        const claimed: Job[] = [];
        for (const row of candidates.rows) {
          const result = await tx.query<JobRow>(
            `UPDATE job_queue
                SET state = 'running',
                    attempts = attempts + 1,
                    lease_token = ?,
                    leased_until = ?,
                    worker_id = ?,
                    updated_at = ?
              WHERE id = ?
                AND attempts < max_attempts
                AND (
                      (state = 'queued' AND run_at <= ?)
                   OR (state = 'running' AND (leased_until IS NULL OR leased_until <= ?))
                    )
            RETURNING *`,
            [leaseToken, leasedUntil, params.workerId ?? null, now, row.id, now, now]
          );
          if (result.rows[0]) {
            claimed.push(fromRow(result.rows[0]));
          }
        }
        return claimed;
      })
    );

    if (jobs.length > 0) {
      logger.trace('Turso jobs claimed', {
        count: jobs.length,
        queue: params.queue,
        workerId: params.workerId ?? null,
      });
    }

    for (const job of jobs) {
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
        event: 'start',
        taskId: job.id,
        metadata: {
          queue: job.queue,
          jobType: job.jobType,
          attempt: job.attempts,
          workerId: params.workerId ?? null,
          leaseMs: params.leaseMs,
        },
      });
    }
    return jobs;
  }

  async heartbeat(params: {
    extendMs: number;
    id: string;
    leaseToken: string;
  }): Promise<Job | null> {
    const jobs = await this.heartbeatBatch(
      [{ id: params.id, leaseToken: params.leaseToken }],
      params.extendMs
    );
    return jobs[0] ?? null;
  }

  async heartbeatBatch(
    jobs: { id: string; leaseToken: string }[],
    extendMs: number
  ): Promise<Job[]> {
    if (jobs.length === 0) {
      return [];
    }
    const now = new Date().toISOString();
    const newLease = addMs(now, extendMs);
    const updated = await withTursoWriteRetry('heartbeatBatch', async () => {
      const updatedJobs: Job[] = [];
      for (const job of jobs) {
        const result = await this.db.query<JobRow>(
          `UPDATE job_queue
            SET leased_until = ?,
                updated_at = ?
          WHERE id = ?
            AND lease_token = ?
            AND state = 'running'
        RETURNING *`,
          [newLease, now, job.id, job.leaseToken]
        );
        if (result.rows[0]) {
          updatedJobs.push(fromRow(result.rows[0]));
        }
      }
      return updatedJobs;
    });
    if (updated.length > 0) {
      logger.debug('Turso jobs heartbeated in batch', { count: updated.length });
    }
    return updated;
  }

  async complete(params: CompleteParams): Promise<Job | null> {
    const jobs = await this.completeBatch([params]);
    return jobs[0] ?? null;
  }

  async completeBatch(jobs: CompleteParams[]): Promise<Job[]> {
    if (jobs.length === 0) {
      return [];
    }
    const updatedAt = new Date().toISOString();
    const completed = await withTursoWriteRetry('completeBatch', async () =>
      this.db.transaction(async (tx) => {
        // A retry after partial commits would omit already-completed rows from the final result.
        const completedJobs: Job[] = [];
        for (const job of jobs) {
          const result = await tx.query<JobRow>(
            `UPDATE job_queue
              SET state = 'succeeded',
                  leased_until = NULL,
                  updated_at = ?
            WHERE id = ?
              AND lease_token = ?
              AND state = 'running'
          RETURNING *`,
            [updatedAt, job.id, job.leaseToken]
          );
          if (result.rows[0]) {
            completedJobs.push(fromRow(result.rows[0]));
          }
        }
        return completedJobs;
      })
    );
    if (completed.length > 0) {
      logger.trace('Turso jobs completed in batch', { count: completed.length });
    }
    emitCompleteTelemetry(completed, updatedAt);
    return completed;
  }

  async completeEmbeddingChunkBatch(jobs: CompleteEmbeddingChunkParams[]): Promise<Job[]> {
    if (jobs.length === 0) {
      return [];
    }
    const updatedAt = new Date().toISOString();
    const completed = await withTursoWriteRetry('completeEmbeddingChunkBatch', async () =>
      this.db.transaction(async (tx) =>
        completeEmbeddingChunkJobs(tx, new TursoFileChunkRepository(this.db), jobs, updatedAt)
      )
    );
    if (completed.length > 0) {
      logger.trace('Turso embedding chunks completed in batch', { count: completed.length });
    }
    emitCompleteTelemetry(completed, updatedAt);
    return completed;
  }

  async fail(params: FailParams): Promise<Job | null> {
    const batchParams: FailBatchParams = {
      jobs: [{ id: params.id, leaseToken: params.leaseToken }],
      error: params.error,
    };
    if (params.backoffMs !== undefined) {
      batchParams.backoffMs = params.backoffMs;
    }
    if (params.terminal !== undefined) {
      batchParams.terminal = params.terminal;
    }
    const jobs = await this.failBatch(batchParams);
    return jobs[0] ?? null;
  }

  async failBatch(params: FailBatchParams): Promise<Job[]> {
    if (params.jobs.length === 0) {
      return [];
    }
    const now = new Date();
    const updatedAt = now.toISOString();
    const results = await withTursoWriteRetry('failBatch', async () =>
      this.db.transaction(async (tx) =>
        failJobsWithTx(tx, params, now, updatedAt, (attempts) => this.retryPolicy(attempts))
      )
    );
    const failed = results.map((result) => result.job);

    for (const result of results) {
      if (result.terminal) {
        logger.error('Turso job failed permanently', {
          jobId: result.job.id,
          queue: result.job.queue,
          error: params.error,
        });
        emitFailTelemetry([result.job], params.error, true);
      } else {
        logger.warn('Turso job failed; retry scheduled', {
          jobId: result.job.id,
          queue: result.job.queue,
          attempts: result.job.attempts,
          retryAt: result.retryAt,
        });
        emitFailTelemetry([result.job], params.error, false);
      }
    }

    if (failed.length > 0) {
      logger.debug('Turso jobs failed in batch', { count: failed.length });
    }
    return failed;
  }

  async cancel(params: CancelParams): Promise<Job | null> {
    const updatedAt = new Date().toISOString();
    const result = await withTursoWriteRetry('cancel', async () =>
      params.leaseToken
        ? this.db.query<JobRow>(
            `UPDATE job_queue
              SET state = 'canceled',
                  leased_until = NULL,
                  updated_at = ?
            WHERE id = ?
              AND lease_token = ?
              AND state IN ('queued', 'running')
          RETURNING *`,
            [updatedAt, params.id, params.leaseToken]
          )
        : this.db.query<JobRow>(
            `UPDATE job_queue
              SET state = 'canceled',
                  leased_until = NULL,
                  updated_at = ?
            WHERE id = ?
              AND state IN ('queued', 'running')
          RETURNING *`,
            [updatedAt, params.id]
          )
    );
    const row = result.rows[0];
    const job = row ? fromRow(row) : null;
    if (job) {
      logger.info('Turso job canceled', {
        jobId: job.id,
        queue: job.queue,
        jobType: job.jobType,
        reason: params.reason,
      });
    }
    return job;
  }

  async cancelMany(queue: string, _reason?: string): Promise<number> {
    const updatedAt = new Date().toISOString();
    const result = await withTursoWriteRetry('cancelMany', async () =>
      this.db.query<{ id: string }>(
        `UPDATE job_queue
            SET state = 'canceled',
                leased_until = NULL,
                updated_at = ?
          WHERE queue = ?
            AND state IN ('queued', 'running')
        RETURNING id`,
        [updatedAt, queue]
      )
    );
    const count = result.rows.length;
    if (count > 0) {
      logger.info('Turso jobs canceled in bulk', { count, queue, reason: _reason });
    }
    return count;
  }

  async expireLeases(nowIso?: string): Promise<number> {
    const now = nowIso ?? new Date().toISOString();
    const result = await withTursoWriteRetry('expireLeases', async () =>
      this.db.query<{ id: string }>(
        `UPDATE job_queue
            SET state = 'queued',
                lease_token = NULL,
                leased_until = NULL,
                updated_at = ?
          WHERE state = 'running'
            AND leased_until IS NOT NULL
            AND leased_until <= ?
        RETURNING id`,
        [now, now]
      )
    );
    const released = result.rows.length;
    if (released > 0) {
      logger.warn('Expired Turso job leases', { count: released });
    }
    return released;
  }

  async prune(states: JobState[], olderThanIso: string): Promise<number> {
    if (!olderThanIso) {
      throw new Error('olderThanIso is required');
    }
    if (states.length === 0) {
      return 0;
    }
    const result = await withTursoWriteRetry('prune', async () =>
      this.db.query<{ id: string }>(
        `DELETE FROM job_queue
          WHERE updated_at < ?
            AND state IN (${placeholders(states.length)})
        RETURNING id`,
        [olderThanIso, ...states]
      )
    );
    const removed = result.rows.length;
    if (removed > 0) {
      logger.info('Pruned Turso historical jobs', { count: removed, states, olderThanIso });
    }
    return removed;
  }

  async getCountsByState(
    queue?: string
  ): Promise<Array<{ queue: string; state: JobState; count: number }>> {
    return this.readModel.getCountsByState(queue);
  }

  async getEmbeddingSetQueueCounts(
    queue: string,
    embeddingSetId: string
  ): Promise<JobQueueStateCounts> {
    return this.readModel.getEmbeddingSetQueueCounts(queue, embeddingSetId);
  }

  async getQueueMetrics(
    queue: string,
    options: JobQueueMetricsOptions
  ): Promise<JobQueueMetricsSnapshot> {
    return this.readModel.getQueueMetrics(queue, options);
  }

  async getQueueStats(queue?: string): Promise<
    Array<{
      queue: string;
      queued: number;
      running: number;
      failed: number;
      succeeded: number;
      nextRunnableAt?: string | null;
    }>
  > {
    return this.readModel.getQueueStats(queue);
  }

  async clear(queue?: string, states?: JobState[]): Promise<number> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (queue) {
      conditions.push('queue = ?');
      params.push(queue);
    }
    if (states && states.length > 0) {
      conditions.push(`state IN (${placeholders(states.length)})`);
      params.push(...states);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await withTursoWriteRetry('clear', async () =>
      this.db.query<{ id: string }>(`DELETE FROM job_queue ${where} RETURNING id`, params)
    );
    const removed = result.rows.length;
    if (removed > 0) {
      logger.info('Cleared Turso job queue entries', {
        count: removed,
        queue: queue ?? 'all',
        states,
      });
    }
    return removed;
  }

  async requeueFailed(
    queue?: string,
    limit = 20,
    options: QueueRetryOptions = {}
  ): Promise<number> {
    return resetJobsForRetry(this.db, "state = 'failed'", queue, limit, options.embeddingSetId);
  }

  async repairUnclaimableQueued(
    queue?: string,
    limit = 20,
    options: QueueRetryOptions = {}
  ): Promise<number> {
    return resetJobsForRetry(
      this.db,
      "state = 'queued' AND attempts >= max_attempts",
      queue,
      limit,
      options.embeddingSetId
    );
  }
}

async function getCountsByState(
  db: TursoJobQueueQueryClient,
  queue?: string
): Promise<Array<{ queue: string; state: JobState; count: number }>> {
  const result = await db.query<{ count: number | string; queue: string; state: JobState }>(
    `SELECT queue, state, COUNT(*) AS count
       FROM job_queue
       ${queue ? 'WHERE queue = ?' : ''}
      GROUP BY queue, state
      ORDER BY queue, state`,
    queue ? [queue] : []
  );
  return result.rows.map((row) => ({
    queue: row.queue,
    state: row.state,
    count: Number(row.count),
  }));
}

async function getEmbeddingSetQueueCounts(
  db: TursoJobQueueQueryClient,
  queue: string,
  embeddingSetId: string
): Promise<JobQueueStateCounts> {
  const queueName = queue.trim();
  if (!queueName) {
    throw new Error('queue is required');
  }
  const targetEmbeddingSetId = embeddingSetId.trim();
  if (!targetEmbeddingSetId) {
    throw new Error('embeddingSetId is required');
  }

  const result = await db.query<{ count: number | string; state: JobState }>(
    `SELECT state, COUNT(*) AS count
       FROM job_queue
      WHERE queue = ?
        AND job_type = 'embed_chunk'
        AND embedding_set_id = ?
        AND state IN ('queued', 'running', 'failed', 'succeeded')
      GROUP BY state`,
    [queueName, targetEmbeddingSetId]
  );
  const counts: JobQueueStateCounts = {
    failed: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
  };
  for (const row of result.rows) {
    const count = Number(row.count);
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`Invalid Turso queue count for state '${row.state}'`);
    }
    if (row.state === 'queued') {
      counts.queued = count;
    }
    if (row.state === 'running') {
      counts.running = count;
    }
    if (row.state === 'failed') {
      counts.failed = count;
    }
    if (row.state === 'succeeded') {
      counts.succeeded = count;
    }
  }
  return counts;
}

async function getQueueMetrics(
  db: TursoJobQueueQueryClient,
  queue: string,
  options: JobQueueMetricsOptions
): Promise<JobQueueMetricsSnapshot> {
  const queueName = queue.trim();
  if (!queueName) {
    throw new Error('queue is required');
  }
  const since = options.since.trim();
  if (!since || Number.isNaN(Date.parse(since))) {
    throw new Error('since must be a valid ISO timestamp');
  }
  if (!Number.isInteger(options.latencyLimit) || options.latencyLimit <= 0) {
    throw new Error('latencyLimit must be a positive integer');
  }

  const [throughputRows, lastErrorRows, latencyRows] = await Promise.all([
    db.query<{ count: number | string | null }>(
      `SELECT COUNT(*) AS count
         FROM job_queue
        WHERE queue = ?
          AND state = 'succeeded'
          AND updated_at >= ?`,
      [queueName, since]
    ),
    db.query<{ error: string | null }>(
      `SELECT error
         FROM job_queue
        WHERE queue = ?
          AND state = 'failed'
     ORDER BY updated_at DESC
        LIMIT 1`,
      [queueName]
    ),
    db.query<{ runAt: unknown; updatedAt: unknown }>(
      `SELECT run_at AS runAt,
              updated_at AS updatedAt
         FROM job_queue
        WHERE queue = ?
          AND state = 'succeeded'
          AND updated_at >= ?
     ORDER BY updated_at DESC
        LIMIT ?`,
      [queueName, since, options.latencyLimit]
    ),
  ]);

  const throughput = Number(throughputRows.rows[0]?.count ?? 0);
  if (!Number.isFinite(throughput) || throughput < 0) {
    throw new Error('Invalid Turso queue throughput count');
  }

  return {
    lastError: lastErrorRows.rows[0]?.error ?? null,
    latencyRows: latencyRows.rows.map((row) => {
      if (!(typeof row.runAt === 'string' && typeof row.updatedAt === 'string')) {
        throw new Error('Invalid Turso queue latency row');
      }
      return {
        runAt: row.runAt,
        updatedAt: row.updatedAt,
      };
    }),
    throughput,
  };
}

async function getQueueStats(
  db: TursoJobQueueQueryClient,
  queue?: string
): Promise<
  Array<{
    queue: string;
    queued: number;
    running: number;
    failed: number;
    succeeded: number;
    nextRunnableAt?: string | null;
  }>
> {
  const counts = await getCountsByState(db, queue);
  const queues = new Map<
    string,
    { queued: number; running: number; failed: number; succeeded: number }
  >();
  for (const count of counts) {
    const entry = queues.get(count.queue) ?? { queued: 0, running: 0, failed: 0, succeeded: 0 };
    if (count.state === 'queued') {
      entry.queued += count.count;
    }
    if (count.state === 'running') {
      entry.running += count.count;
    }
    if (count.state === 'failed') {
      entry.failed += count.count;
    }
    if (count.state === 'succeeded') {
      entry.succeeded += count.count;
    }
    queues.set(count.queue, entry);
  }

  const nextRunnable = await db.query<{ queue: string; run_at: string }>(
    `SELECT queue, MIN(run_at) AS run_at
       FROM job_queue
      WHERE state = 'queued' ${queue ? 'AND queue = ?' : ''}
      GROUP BY queue`,
    queue ? [queue] : []
  );
  const nextByQueue = new Map(nextRunnable.rows.map((row) => [row.queue, row.run_at]));

  return [...queues.entries()].map(([queueName, stats]) => ({
    queue: queueName,
    ...stats,
    nextRunnableAt: nextByQueue.get(queueName) ?? null,
  }));
}

async function enqueueJobs(
  tx: TursoJobQueueQueryClient,
  params: EnqueueParams[],
  defaultMaxAttempts = DEFAULT_MAX_ATTEMPTS
): Promise<EnqueueJobsResult> {
  const now = new Date().toISOString();
  const processedParams = processBatchParams(params, now);
  const jobs: Job[] = [];
  const insertedJobIds = new Set<string>();

  for (const param of processedParams) {
    const runAt = param.runAt ?? now;
    const dedupeKey = param.dedupeKey ?? null;
    const chunkId = extractEmbedChunkId(param);
    const embeddingSetId = extractEmbedEmbeddingSetId(param);
    if (dedupeKey) {
      const existing = await tx.query<JobRow>(
        `SELECT *
           FROM job_queue
          WHERE dedupe_key = ?
            AND state IN ('queued', 'running')
          ORDER BY created_at ASC
          LIMIT 1`,
        [dedupeKey]
      );
      if (existing.rows[0]) {
        const activeJob = fromRow(existing.rows[0]);
        const updated = await tx.query<JobRow>(
          `UPDATE job_queue
              SET run_at = ?,
                  chunk_id = COALESCE(chunk_id, ?),
                  embedding_set_id = COALESCE(embedding_set_id, ?),
                  updated_at = ?
            WHERE id = ?
          RETURNING *`,
          [earlierIso(activeJob.runAt, runAt), chunkId, embeddingSetId, now, activeJob.id]
        );
        if (updated.rows[0]) {
          jobs.push(fromRow(updated.rows[0]));
        }
        continue;
      }
    }

    const id = generateUUID();
    const inserted = await tx.query<JobRow>(
      `INSERT INTO job_queue (
         id,
         queue,
         job_type,
         payload,
         chunk_id,
         embedding_set_id,
         state,
         run_at,
         attempts,
         max_attempts,
         backoff_ms,
         lease_token,
         leased_until,
         worker_id,
         dedupe_key,
         error,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, 0, NULL, NULL, NULL, ?, NULL, ?, ?)
       RETURNING *`,
      [
        id,
        param.queue,
        param.jobType,
        JSON.stringify(param.payload),
        chunkId,
        embeddingSetId,
        runAt,
        param.maxAttempts ?? defaultMaxAttempts,
        dedupeKey,
        now,
        now,
      ]
    );
    if (inserted.rows[0]) {
      const job = fromRow(inserted.rows[0]);
      jobs.push(job);
      insertedJobIds.add(job.id);
    }
  }

  return { insertedJobIds, jobs };
}

interface EnqueueJobsResult {
  readonly insertedJobIds: ReadonlySet<string>;
  readonly jobs: Job[];
}

function processBatchParams(params: EnqueueParams[], now: string): EnqueueParams[] {
  const processedParams: EnqueueParams[] = [];
  const seenDedupeKeys = new Map<string, EnqueueParams>();

  for (const param of params) {
    const withRunAt = { ...param, runAt: param.runAt ?? now };
    if (!param.dedupeKey) {
      processedParams.push(withRunAt);
      continue;
    }
    const existing = seenDedupeKeys.get(param.dedupeKey);
    if (!existing) {
      seenDedupeKeys.set(param.dedupeKey, withRunAt);
      processedParams.push(withRunAt);
      continue;
    }
    existing.runAt = earlierIso(existing.runAt ?? now, withRunAt.runAt);
  }

  return processedParams;
}

function fromRow(row: JobRow): Job {
  return {
    id: row.id,
    queue: row.queue,
    jobType: row.job_type as Job['jobType'],
    payload: parsePayload(row.id, row.payload),
    state: row.state,
    runAt: row.run_at,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    backoff_ms: Number(row.backoff_ms),
    lease_token: row.lease_token ?? null,
    leasedUntil: row.leased_until ?? null,
    worker_id: row.worker_id ?? null,
    dedupe_key: row.dedupe_key ?? null,
    chunk_id: row.chunk_id ?? null,
    embedding_set_id: row.embedding_set_id ?? null,
    error: row.error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parsePayload(jobId: string, payload: unknown): unknown {
  if (payload === null || payload === undefined) {
    return null;
  }
  if (typeof payload !== 'string') {
    return payload;
  }
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `Invalid Turso job payload JSON for job ${jobId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    return Math.max(0, end - start);
  }
  return null;
}

function selectFirstJobByChunkId(
  jobs: readonly CompleteEmbeddingChunkParams[]
): CompleteEmbeddingChunkParams[] {
  const winners = new Map<string, CompleteEmbeddingChunkParams>();
  for (const job of jobs) {
    const existing = winners.get(job.chunkId);
    if (!existing || job.id < existing.id) {
      winners.set(job.chunkId, job);
    }
  }
  return [...winners.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function completeEmbeddingChunkJobs(
  tx: BrainstrikeDbTransactionClient,
  chunkRepository: TursoFileChunkRepository,
  jobs: readonly CompleteEmbeddingChunkParams[],
  updatedAt: string
): Promise<Job[]> {
  const ownedJobs = await collectOwnedEmbeddingChunkJobs(tx, jobs);
  const updatedChunkIds = await updateEmbeddingChunksWithTx(
    tx,
    chunkRepository,
    ownedJobs,
    updatedAt
  );
  return markCompletedEmbeddingChunkJobs(tx, ownedJobs, updatedChunkIds, updatedAt);
}

async function collectOwnedEmbeddingChunkJobs(
  tx: BrainstrikeDbTransactionClient,
  jobs: readonly CompleteEmbeddingChunkParams[]
): Promise<CompleteEmbeddingChunkParams[]> {
  const ownedJobs: CompleteEmbeddingChunkParams[] = [];
  for (const job of jobs) {
    const owned = await tx.query<JobRow>(
      `SELECT *
         FROM job_queue
        WHERE id = ?
          AND lease_token = ?
          AND state = 'running'
        LIMIT 1`,
      [job.id, job.leaseToken]
    );
    if (owned.rows[0]) {
      ownedJobs.push(job);
    }
  }
  return ownedJobs;
}

async function updateEmbeddingChunksWithTx(
  tx: BrainstrikeDbTransactionClient,
  chunkRepository: TursoFileChunkRepository,
  ownedJobs: readonly CompleteEmbeddingChunkParams[],
  updatedAt: string
): Promise<Set<string>> {
  const updatedChunkIds = new Set<string>();
  for (const job of selectFirstJobByChunkId(ownedJobs)) {
    const updatedChunk = await chunkRepository.updateWithTx(tx, {
      id: job.chunkId,
      embedding: job.embedding,
      embeddingHash: job.embeddingHash,
      embeddingSetId: job.embeddingSetId,
      embeddingUpdatedAt: updatedAt,
      updatedAt,
    });
    if (updatedChunk) {
      updatedChunkIds.add(job.chunkId);
    }
  }
  return updatedChunkIds;
}

async function markCompletedEmbeddingChunkJobs(
  tx: BrainstrikeDbTransactionClient,
  ownedJobs: readonly CompleteEmbeddingChunkParams[],
  updatedChunkIds: ReadonlySet<string>,
  updatedAt: string
): Promise<Job[]> {
  const completedJobs: Job[] = [];
  for (const job of ownedJobs) {
    if (!updatedChunkIds.has(job.chunkId)) {
      continue;
    }

    const result = await tx.query<JobRow>(
      `UPDATE job_queue
          SET state = 'succeeded',
              chunk_id = COALESCE(chunk_id, ?),
              embedding_set_id = COALESCE(embedding_set_id, ?),
              leased_until = NULL,
              updated_at = ?
        WHERE id = ?
          AND lease_token = ?
          AND state = 'running'
      RETURNING *`,
      [job.chunkId, job.embeddingSetId, updatedAt, job.id, job.leaseToken]
    );
    if (result.rows[0]) {
      completedJobs.push(fromRow(result.rows[0]));
    }
  }
  return completedJobs;
}

interface FailedJobResult {
  readonly job: Job;
  readonly retryAt?: string;
  readonly terminal: boolean;
}

type FailureInputJob = FailBatchParams['jobs'][number];

async function failJobsWithTx(
  tx: BrainstrikeDbTransactionClient,
  params: FailBatchParams,
  now: Date,
  updatedAt: string,
  retryPolicy: (attempts: number) => number
): Promise<FailedJobResult[]> {
  const failedJobs: FailedJobResult[] = [];
  for (const job of params.jobs) {
    const row = await findOwnedRunningJob(tx, job);
    if (!row) {
      continue;
    }
    const result = await failOwnedJobWithTx(tx, job, row, params, now, updatedAt, retryPolicy);
    if (result) {
      failedJobs.push(result);
    }
  }
  return failedJobs;
}

async function findOwnedRunningJob(
  tx: BrainstrikeDbTransactionClient,
  job: FailureInputJob
): Promise<JobRow | null> {
  const current = await tx.query<JobRow>(
    `SELECT *
       FROM job_queue
      WHERE id = ?
        AND lease_token = ?
        AND state = 'running'
      LIMIT 1`,
    [job.id, job.leaseToken]
  );
  return current.rows[0] ?? null;
}

async function failOwnedJobWithTx(
  tx: BrainstrikeDbTransactionClient,
  job: FailureInputJob,
  row: JobRow,
  params: FailBatchParams,
  now: Date,
  updatedAt: string,
  retryPolicy: (attempts: number) => number
): Promise<FailedJobResult | null> {
  const attempts = Number(row.attempts ?? 0);
  const maxAttempts = Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS);
  if (params.terminal || attempts >= maxAttempts) {
    return markJobFailedWithTx(tx, job, attempts, params.error, updatedAt);
  }
  const backoff = params.backoffMs ?? retryPolicy(attempts);
  return requeueFailedJobWithTx(
    tx,
    job,
    attempts,
    params.error,
    updatedAt,
    new Date(now.getTime() + backoff).toISOString(),
    backoff
  );
}

async function markJobFailedWithTx(
  tx: BrainstrikeDbTransactionClient,
  job: FailureInputJob,
  attempts: number,
  error: string,
  updatedAt: string
): Promise<FailedJobResult | null> {
  const result = await tx.query<JobRow>(
    `UPDATE job_queue
        SET state = 'failed',
            attempts = ?,
            error = ?,
            updated_at = ?
      WHERE id = ?
        AND lease_token = ?
        AND state = 'running'
    RETURNING *`,
    [attempts, error, updatedAt, job.id, job.leaseToken]
  );
  return result.rows[0] ? { job: fromRow(result.rows[0]), terminal: true } : null;
}

async function requeueFailedJobWithTx(
  tx: BrainstrikeDbTransactionClient,
  job: FailureInputJob,
  attempts: number,
  error: string,
  updatedAt: string,
  runAt: string,
  backoff: number
): Promise<FailedJobResult | null> {
  const result = await tx.query<JobRow>(
    `UPDATE job_queue
        SET state = 'queued',
            attempts = ?,
            backoff_ms = ?,
            run_at = ?,
            error = ?,
            leased_until = NULL,
            lease_token = NULL,
            updated_at = ?
      WHERE id = ?
        AND lease_token = ?
        AND state = 'running'
    RETURNING *`,
    [attempts, backoff, runAt, error, updatedAt, job.id, job.leaseToken]
  );
  return result.rows[0] ? { job: fromRow(result.rows[0]), retryAt: runAt, terminal: false } : null;
}

function extractEmbedChunkId(param: EnqueueParams): string | null {
  if (param.jobType !== 'embed_chunk' || !(param.payload && typeof param.payload === 'object')) {
    return null;
  }
  const chunkId = (param.payload as { chunkId?: unknown }).chunkId;
  return typeof chunkId === 'string' && chunkId.length > 0 ? chunkId : null;
}

function extractEmbedEmbeddingSetId(param: EnqueueParams): string | null {
  if (param.jobType !== 'embed_chunk' || !(param.payload && typeof param.payload === 'object')) {
    return null;
  }
  const embeddingSetId = (param.payload as { embeddingSetId?: unknown }).embeddingSetId;
  return typeof embeddingSetId === 'string' && embeddingSetId.length > 0 ? embeddingSetId : null;
}

function addMs(iso: string, ms: number): string {
  const start = Date.parse(iso);
  const base = Number.isFinite(start) ? start : Date.now();
  return new Date(base + ms).toISOString();
}

function earlierIso(left: string, right: string): string {
  return left <= right ? left : right;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function emitEnqueueTelemetry(jobs: readonly Job[], insertedJobIds: ReadonlySet<string>): void {
  for (const job of jobs) {
    if (!insertedJobIds.has(job.id)) {
      continue;
    }
    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
      event: 'enqueue',
      taskId: job.id,
      metadata: {
        queue: job.queue,
        jobType: job.jobType,
        dedupeKey: job.dedupe_key ?? undefined,
      },
    });
  }
}

function emitCompleteTelemetry(jobs: Job[], updatedAt: string): void {
  for (const job of jobs) {
    const elapsedMs = computeElapsedMs(job.runAt, updatedAt);
    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
      event: 'complete',
      taskId: job.id,
      ...(typeof elapsedMs === 'number' ? { elapsedMs } : {}),
      metadata: {
        queue: job.queue,
        jobType: job.jobType,
        completedAt: updatedAt,
      },
    });
  }
}

function emitFailTelemetry(jobs: Job[], error: string, terminal: boolean): void {
  for (const job of jobs) {
    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
      event: 'error',
      taskId: job.id,
      errorMessage: error,
      metadata: {
        queue: job.queue,
        jobType: job.jobType,
        attempts: job.attempts,
        ...(terminal ? { terminal: true } : { retryAt: job.runAt }),
      },
    });
  }
}

async function withTursoWriteRetry<TResult>(
  operation: string,
  callback: () => Promise<TResult>
): Promise<TResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_TURSO_WRITE_RETRIES; attempt += 1) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      if (!isTursoWriteContentionError(error) || attempt >= MAX_TURSO_WRITE_RETRIES) {
        throw error;
      }
      const delayMs = computeTursoWriteRetryDelayMs(attempt);
      logger.warn('Retrying Turso queue write after transient contention', {
        operation,
        attempt: attempt + 1,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function isTursoWriteContentionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('database is locked') ||
    normalized.includes('busy') ||
    normalized.includes('conflict') ||
    normalized.includes('sqlite_busy')
  );
}

function computeTursoWriteRetryDelayMs(attempt: number): number {
  const exponential = TURSO_WRITE_RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * TURSO_WRITE_RETRY_BASE_DELAY_MS);
  return exponential + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetJobsForRetry(
  db: BrainstrikeDbExecutionClient,
  baseCondition: string,
  queue: string | undefined,
  limit: number,
  embeddingSetId: string | undefined
): Promise<number> {
  const now = new Date().toISOString();
  const conditions = [baseCondition];
  const params: unknown[] = [];
  if (queue) {
    conditions.push('queue = ?');
    params.push(queue);
  }
  if (embeddingSetId) {
    conditions.push('embedding_set_id = ?');
    params.push(embeddingSetId);
  }
  return withTursoWriteRetry('resetJobsForRetry', async () =>
    db.transaction(async (tx) => {
      const candidates = await tx.query<{ id: string }>(
        `SELECT id
           FROM job_queue
          WHERE ${conditions.join(' AND ')}
          ORDER BY updated_at DESC
          LIMIT ?`,
        [...params, limit]
      );
      if (candidates.rows.length === 0) {
        return 0;
      }
      const ids = candidates.rows.map((row) => row.id);
      const result = await tx.query<{ id: string }>(
        `UPDATE job_queue
            SET state = 'queued',
                attempts = 0,
                run_at = ?,
                backoff_ms = 0,
                leased_until = NULL,
                lease_token = NULL,
                error = NULL,
                updated_at = ?
          WHERE id IN (${placeholders(ids.length)})
        RETURNING id`,
        [now, now, ...ids]
      );
      return result.rows.length;
    })
  );
}
