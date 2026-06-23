import { emitQueueTelemetry, type QueueTelemetryAdapter } from '@brainstrike/queue';
import { generateUUID } from '@brainstrike/utils';
import type {
  BrainstrikeDbExecutionClient,
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
  JobRow,
  JobState,
  QueueRetryOptions,
} from './job-queue.js';

const JOB_QUEUE_TELEMETRY_ADAPTER: QueueTelemetryAdapter = 'job-queue';
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_BATCH_SIZE = 9000;

export class TursoJobQueue {
  constructor(
    private readonly db: BrainstrikeDbExecutionClient,
    private readonly defaults: { maxAttempts?: number } = {}
  ) {}

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

    return this.db.transaction(async (tx) => enqueueJobs(tx, params, this.defaults.maxAttempts));
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

    const jobs = await this.db.transaction(async (tx) => {
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
    });

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
    const updated: Job[] = [];
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
        updated.push(fromRow(result.rows[0]));
      }
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
    const completed: Job[] = [];
    for (const job of jobs) {
      const result = await this.db.query<JobRow>(
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
        completed.push(fromRow(result.rows[0]));
      }
    }
    emitCompleteTelemetry(completed, updatedAt);
    return completed;
  }

  async completeEmbeddingChunkBatch(jobs: CompleteEmbeddingChunkParams[]): Promise<Job[]> {
    if (jobs.length === 0) {
      return [];
    }
    const updatedAt = new Date().toISOString();
    const completed = await this.db.transaction(async (tx) => {
      const completedJobs: Job[] = [];
      const chunkRepository = new TursoFileChunkRepository(this.db);

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
        if (!owned.rows[0]) {
          continue;
        }

        const updatedChunk = await chunkRepository.updateWithTx(tx, {
          id: job.chunkId,
          embedding: job.embedding,
          embeddingHash: job.embeddingHash,
          embeddingSetId: job.embeddingSetId,
          embeddingUpdatedAt: updatedAt,
          updatedAt,
        });
        if (!updatedChunk) {
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
    });
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
    const failed: Job[] = [];

    for (const job of params.jobs) {
      const current = await this.db.query<JobRow>(
        `SELECT *
           FROM job_queue
          WHERE id = ?
            AND lease_token = ?
            AND state = 'running'
          LIMIT 1`,
        [job.id, job.leaseToken]
      );
      const row = current.rows[0];
      if (!row) {
        continue;
      }

      const attempts = Number(row.attempts ?? 0);
      const maxAttempts = Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS);
      if (params.terminal || attempts >= maxAttempts) {
        const result = await this.db.query<JobRow>(
          `UPDATE job_queue
              SET state = 'failed',
                  attempts = ?,
                  error = ?,
                  updated_at = ?
            WHERE id = ?
              AND lease_token = ?
              AND state = 'running'
          RETURNING *`,
          [attempts, params.error, updatedAt, job.id, job.leaseToken]
        );
        if (result.rows[0]) {
          failed.push(fromRow(result.rows[0]));
        }
        continue;
      }

      const backoff = params.backoffMs ?? this.retryPolicy(attempts);
      const runAt = new Date(now.getTime() + backoff).toISOString();
      const result = await this.db.query<JobRow>(
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
        [attempts, backoff, runAt, params.error, updatedAt, job.id, job.leaseToken]
      );
      if (result.rows[0]) {
        failed.push(fromRow(result.rows[0]));
      }
    }

    emitFailTelemetry(failed, params.error);
    return failed;
  }

  async cancel(params: CancelParams): Promise<Job | null> {
    const updatedAt = new Date().toISOString();
    const result = params.leaseToken
      ? await this.db.query<JobRow>(
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
      : await this.db.query<JobRow>(
          `UPDATE job_queue
              SET state = 'canceled',
                  leased_until = NULL,
                  updated_at = ?
            WHERE id = ?
              AND state IN ('queued', 'running')
          RETURNING *`,
          [updatedAt, params.id]
        );
    const row = result.rows[0];
    return row ? fromRow(row) : null;
  }

  async cancelMany(queue: string, _reason?: string): Promise<number> {
    const updatedAt = new Date().toISOString();
    const result = await this.db.query<{ id: string }>(
      `UPDATE job_queue
          SET state = 'canceled',
              leased_until = NULL,
              updated_at = ?
        WHERE queue = ?
          AND state IN ('queued', 'running')
      RETURNING id`,
      [updatedAt, queue]
    );
    return result.rows.length;
  }

  async expireLeases(nowIso?: string): Promise<number> {
    const now = nowIso ?? new Date().toISOString();
    const result = await this.db.query<{ id: string }>(
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
    );
    return result.rows.length;
  }

  async prune(states: JobState[], olderThanIso: string): Promise<number> {
    if (!olderThanIso) {
      throw new Error('olderThanIso is required');
    }
    if (states.length === 0) {
      return 0;
    }
    const result = await this.db.query<{ id: string }>(
      `DELETE FROM job_queue
        WHERE updated_at < ?
          AND state IN (${placeholders(states.length)})
      RETURNING id`,
      [olderThanIso, ...states]
    );
    return result.rows.length;
  }

  async getCountsByState(
    queue?: string
  ): Promise<Array<{ queue: string; state: JobState; count: number }>> {
    const result = await this.db.query<{ count: number | string; queue: string; state: JobState }>(
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
    const counts = await this.getCountsByState(queue);
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

    const nextRunnable = await this.db.query<{ queue: string; run_at: string }>(
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
    const result = await this.db.query<{ id: string }>(
      `DELETE FROM job_queue ${where} RETURNING id`,
      params
    );
    return result.rows.length;
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

async function enqueueJobs(
  tx: BrainstrikeDbTransactionClient,
  params: EnqueueParams[],
  defaultMaxAttempts = DEFAULT_MAX_ATTEMPTS
): Promise<Job[]> {
  const now = new Date().toISOString();
  const processedParams = processBatchParams(params, now);
  const jobs: Job[] = [];

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

  return jobs;
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
    payload: parsePayload(row.payload),
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

function parsePayload(payload: unknown): unknown | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  if (typeof payload !== 'string') {
    return payload;
  }
  return JSON.parse(payload);
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

function emitCompleteTelemetry(jobs: Job[], updatedAt: string): void {
  for (const job of jobs) {
    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
      event: 'complete',
      taskId: job.id,
      metadata: {
        queue: job.queue,
        jobType: job.jobType,
        completedAt: updatedAt,
      },
    });
  }
}

function emitFailTelemetry(jobs: Job[], error: string): void {
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
      },
    });
  }
}

async function resetJobsForRetry(
  db: BrainstrikeDbExecutionClient,
  baseCondition: string,
  queue: string | undefined,
  limit: number,
  embeddingSetId: string | undefined
): Promise<number> {
  const now = new Date().toISOString();
  const params: unknown[] = [];
  const conditions = [baseCondition];
  if (queue) {
    conditions.push('queue = ?');
    params.push(queue);
  }
  if (embeddingSetId) {
    conditions.push('embedding_set_id = ?');
    params.push(embeddingSetId);
  }
  const candidates = await db.query<{ id: string }>(
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
  const result = await db.query<{ id: string }>(
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
}
