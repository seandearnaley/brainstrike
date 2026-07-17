import { emitQueueTelemetry, type QueueTelemetryAdapter } from '@brainstrike/queue';
import { createLogger, generateUUID } from '@brainstrike/utils';
import type { IDatabase } from '../repositories/interfaces.js';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired';

export type JobType = 'embed_chunk';

export interface JobRow {
  attempts: number;
  backoff_ms: number;
  chunk_id?: string | null;
  created_at: string;
  dedupe_key?: string | null;
  embedding_set_id?: string | null;
  error?: string | null;
  id: string;
  job_type: string;
  lease_token?: string | null;
  leased_until?: string | null;
  max_attempts: number;
  payload: unknown | null;
  queue: string;
  run_at: string;
  state: JobState;
  updated_at: string;
  worker_id?: string | null;
}

export interface Job extends Omit<JobRow, 'job_type' | 'payload' | 'run_at' | 'leased_until'> {
  jobType: JobType;
  leasedUntil?: string | null;
  payload?: unknown | null;
  runAt: string;
}

const logger = createLogger('JobQueue');

/**
 * Telemetry adapter identifier for the durable DB-backed JobQueue.
 */
const JOB_QUEUE_TELEMETRY_ADAPTER: QueueTelemetryAdapter = 'job-queue';

function fromRow(row: JobRow): Job {
  const job: Job = {
    attempts: row.attempts,
    backoff_ms: row.backoff_ms,
    chunk_id: row.chunk_id ?? null,
    created_at: row.created_at,
    dedupe_key: row.dedupe_key ?? null,
    embedding_set_id: row.embedding_set_id ?? null,
    error: row.error ?? null,
    id: row.id,
    jobType: row.job_type as JobType,
    lease_token: row.lease_token ?? null,
    leasedUntil: row.leased_until ?? null,
    max_attempts: row.max_attempts,
    payload: row.payload ?? null,
    queue: row.queue,
    runAt: row.run_at,
    state: row.state,
    updated_at: row.updated_at,
    worker_id: row.worker_id ?? null,
  };
  return job;
}

function extractEmbedChunkId(jobType: JobType, payload: unknown): string | null {
  if (jobType !== 'embed_chunk' || !(payload && typeof payload === 'object')) {
    return null;
  }
  const chunkId = (payload as { chunkId?: unknown }).chunkId;
  return typeof chunkId === 'string' && chunkId.length > 0 ? chunkId : null;
}

function extractEmbedEmbeddingSetId(jobType: JobType, payload: unknown): string | null {
  if (jobType !== 'embed_chunk' || !(payload && typeof payload === 'object')) {
    return null;
  }
  const embeddingSetId = (payload as { embeddingSetId?: unknown }).embeddingSetId;
  return typeof embeddingSetId === 'string' && embeddingSetId.length > 0 ? embeddingSetId : null;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    return Math.max(0, end - start);
  }
  return null;
}

/**
 * Durable per-queue lifetime outcome counters in job_queue_metrics. A strict
 * union so the column name folded into SQL can never be untrusted input.
 */
type OutcomeMetricsColumn = 'succeeded_total' | 'failed_total' | 'canceled_total';

/**
 * Builds a data-modifying CTE that increments a durable per-queue lifetime
 * outcome counter from a source CTE of just-transitioned job rows. Folded into
 * the same statement as the transition UPDATE so a job can never reach a
 * terminal state without being counted (atomic on the single-statement
 * engine). The counters are monotonic — pruning/clearing the terminal rows
 * never touches them (aggregate-then-prune). `sourceCte` must expose a `queue`
 * column and contain only rows that transitioned in this statement.
 *
 * Exported for raw-SQL sites outside JobQueue that transition jobs terminally
 * (e.g. managed-cache chunk invalidation) so they fold in the same counter
 * instead of silently skipping it.
 */
export function incrementOutcomeMetricsCte(
  sourceCte: string,
  column: OutcomeMetricsColumn
): string {
  return `metrics AS (
       INSERT INTO job_queue_metrics (queue, ${column})
       SELECT queue, COUNT(*) FROM ${sourceCte} GROUP BY queue
       ON CONFLICT (queue) DO UPDATE
         SET ${column} = job_queue_metrics.${column} + EXCLUDED.${column}
     )`;
}

export interface EnqueueParams {
  dedupeKey?: string;
  jobType: JobType;
  maxAttempts?: number; // defaults to configured
  payload: unknown;
  queue: string;
  runAt?: string; // ISO string; defaults to now
}

export interface ClaimParams {
  leaseMs: number;
  now?: string; // ISO string; defaults to now
  queue: string;
  workerId?: string;
}

export interface HeartbeatParams {
  extendMs: number;
  id: string;
  leaseToken: string;
}

export interface CompleteParams {
  id: string;
  leaseToken: string;
}

export interface CompleteEmbeddingChunkParams extends CompleteParams {
  chunkId: string;
  embedding: number[];
  embeddingHash: string;
  embeddingSetId: string;
}

export interface FailParams {
  backoffMs?: number;
  error: string;
  id: string;
  leaseToken: string;
  terminal?: boolean;
}

export interface FailBatchParams {
  backoffMs?: number;
  error: string;
  jobs: ReadonlyArray<{ id: string; leaseToken: string }>;
  terminal?: boolean;
}

export interface QueueRetryOptions {
  embeddingSetId?: string;
}

export interface CancelParams {
  id: string;
  leaseToken?: string;
  reason?: string;
}

type IdTypeProbe = 'information_schema' | 'pg_catalog';

export class JobQueue {
  private static readonly DEFAULT_MAX_ATTEMPTS = 5;
  private static readonly MAX_BATCH_SIZE = 9000;
  private fileChunkIdType: 'uuid' | 'text' | null = null;
  private idType: 'uuid' | 'text' | null = null;

  constructor(
    private readonly db: IDatabase,
    private readonly defaults: { maxAttempts?: number } = {}
  ) {}

  withDb(db: IDatabase): JobQueue {
    return new JobQueue(db, this.defaults);
  }

  private normalizeIdType(value: unknown): 'uuid' | 'text' | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.toLowerCase();
    if (normalized === 'uuid') {
      return 'uuid';
    }
    if (normalized === 'text') {
      return 'text';
    }
    return null;
  }

  private async resolveIdTypeFromPgCatalog(table: string): Promise<'uuid' | 'text' | null> {
    const res = await this.db.query<{ data_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS data_type
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = $1
          AND a.attname = 'id'
          AND NOT a.attisdropped
        LIMIT 1`,
      [table]
    );
    return this.normalizeIdType(res.rows[0]?.data_type);
  }

  private async resolveIdTypeFromInformationSchema(table: string): Promise<'uuid' | 'text' | null> {
    const res = await this.db.query<{ data_type: string }>(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = 'id'
        LIMIT 1`,
      [table]
    );
    return this.normalizeIdType(res.rows[0]?.data_type);
  }

  private async resolveTableIdType(table: string): Promise<'uuid' | 'text'> {
    const errors: string[] = [];

    try {
      const type = await this.resolveIdTypeFromPgCatalog(table);
      if (type) {
        return type;
      }
    } catch (error) {
      this.recordIdTypeProbeError(errors, 'pg_catalog', table, error);
    }

    try {
      const type = await this.resolveIdTypeFromInformationSchema(table);
      if (type) {
        return type;
      }
    } catch (error) {
      this.recordIdTypeProbeError(errors, 'information_schema', table, error);
    }

    const suffix = errors.length > 0 ? ` Details: ${errors.join('; ')}` : '';
    throw new Error(`Failed to resolve ID type for ${table}.id.${suffix}`);
  }

  private async getOrResolveIdType(): Promise<'uuid' | 'text'> {
    if (!this.idType) {
      this.idType = await this.resolveTableIdType('job_queue');
    }
    return this.idType;
  }

  private async getOrResolveFileChunkIdType(): Promise<'uuid' | 'text'> {
    if (!this.fileChunkIdType) {
      this.fileChunkIdType = await this.resolveTableIdType('file_chunks');
    }
    return this.fileChunkIdType;
  }

  private recordIdTypeProbeError(
    errors: string[],
    probe: IdTypeProbe,
    table: string,
    error: unknown
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${probe}: ${message}`);
    logger.error('Failed to resolve table id type probe', {
      message,
      probe,
      table,
    });
  }

  private validateIdType(idType: string): asserts idType is 'uuid' | 'text' {
    if (idType !== 'uuid' && idType !== 'text') {
      throw new Error(`Invalid idType resolved: ${idType}`);
    }
  }

  retryPolicy(attempts: number): number {
    // Exponential with jitter; base 1s, factor 2, cap 5m
    const base = 1000;
    const cap = 5 * 60 * 1000;
    const exp = Math.min(cap, base * 2 ** Math.max(0, attempts));
    const jitter = Math.floor(exp * (0.2 + Math.random() * 0.3));
    return Math.min(cap, Math.max(base, jitter));
  }

  async enqueue(params: EnqueueParams): Promise<Job> {
    const now = new Date().toISOString();
    const runAt = params.runAt ?? now;
    const id = generateUUID();
    const maxAttempts =
      params.maxAttempts ?? this.defaults.maxAttempts ?? JobQueue.DEFAULT_MAX_ATTEMPTS;
    const dedupe = params.dedupeKey ?? null;
    const chunkId = extractEmbedChunkId(params.jobType, params.payload);
    const embeddingSetId = extractEmbedEmbeddingSetId(params.jobType, params.payload);

    // Portable idempotent enqueue using CTEs (works with partial unique index)
    const inserted = await this.db.query<JobRow>(
      `WITH existing AS (
         SELECT * FROM job_queue
          WHERE dedupe_key = $7 AND state IN ('queued','running')
          LIMIT 1
       ),
       upd AS (
         UPDATE job_queue
            SET run_at = LEAST(run_at, $5),
                chunk_id = COALESCE(chunk_id, $9),
                embedding_set_id = COALESCE(embedding_set_id, $10),
                updated_at = GREATEST(updated_at, $8)
          WHERE id IN (SELECT id FROM existing)
          RETURNING *
       ),
       ins AS (
         INSERT INTO job_queue (
           id, queue, job_type, payload, chunk_id, embedding_set_id, state, run_at, attempts, max_attempts, backoff_ms,
           lease_token, leased_until, worker_id, dedupe_key, error, created_at, updated_at
         )
         SELECT $1,$2,$3,$4,$9,$10,'queued',$5,0,$6,0,NULL,NULL,NULL,$7,NULL,$8,$8
         WHERE NOT EXISTS (SELECT 1 FROM existing)
         RETURNING *
       )
       SELECT * FROM upd
       UNION ALL
       SELECT * FROM ins
       LIMIT 1`,
      [
        id,
        params.queue,
        params.jobType,
        JSON.stringify(params.payload),
        runAt,
        maxAttempts,
        dedupe,
        now,
        chunkId,
        embeddingSetId,
      ]
    );

    if (!inserted.rows[0]) {
      throw new Error('Failed to insert job');
    }
    const job = fromRow(inserted.rows[0]);
    const isNewEnqueue = job.id === id;

    if (isNewEnqueue) {
      logger.debug('Job enqueued', {
        dedupeKey: dedupe,
        jobId: job.id,
        jobType: job.jobType,
        queue: job.queue,
        runAt: job.runAt,
      });
      emitQueueTelemetry({
        adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
        event: 'enqueue',
        metadata: {
          dedupeKey: dedupe,
          jobType: job.jobType,
          queue: job.queue,
        },
        taskId: job.id,
        timestamp: Date.now(),
      });
    } else {
      logger.debug('Job enqueue deduped; returning existing job', {
        dedupeKey: dedupe,
        jobId: job.id,
        jobType: job.jobType,
        queue: job.queue,
        runAt: job.runAt,
      });
    }
    return job;
  }

  /**
   * Helper to pre-process parameters for intra-batch deduplication.
   */
  private processBatchParams(params: EnqueueParams[], now: string): EnqueueParams[] {
    const processedParams: EnqueueParams[] = [];
    const seenDedupeKeys = new Map<string, EnqueueParams>();

    for (const p of params) {
      if (p.dedupeKey) {
        const existing = seenDedupeKeys.get(p.dedupeKey);
        if (existing) {
          // Keep the one with earlier runAt
          const currentRunAt = existing.runAt ?? now;
          const newRunAt = p.runAt ?? now;
          if (newRunAt < currentRunAt) {
            existing.runAt = newRunAt;
          }
        } else {
          // Clone to avoid mutation if we modify runAt
          const clone = { ...p, runAt: p.runAt ?? now };
          seenDedupeKeys.set(p.dedupeKey, clone);
          processedParams.push(clone);
        }
      } else {
        processedParams.push({ ...p, runAt: p.runAt ?? now });
      }
    }
    return processedParams;
  }

  /**
   * Helper to build the batch SQL query based on ID type.
   */
  private buildBatchQuery(idType: 'uuid' | 'text'): string {
    const idTypeCast = idType === 'uuid' ? 'uuid' : 'text';
    return `WITH input AS (
             SELECT * FROM unnest(
               $1::${idTypeCast}[], $2::text[], $3::text[], $4::jsonb[], $5::text[], $6::int[], $7::text[], $8::text[], $9::text[]
             ) AS t(id, queue, job_type, payload, run_at_text, max_attempts, dedupe_key, chunk_id, embedding_set_id)
           ),
           existing AS (
             SELECT jq.id, jq.dedupe_key, i.run_at_text
             FROM job_queue jq
             JOIN input i ON jq.dedupe_key = i.dedupe_key
             WHERE jq.state IN ('queued', 'running')
           ),
           upd AS (
             UPDATE job_queue jq
             SET run_at = LEAST(jq.run_at, e.run_at_text),
                 chunk_id = COALESCE(jq.chunk_id, i.chunk_id),
                 embedding_set_id = COALESCE(jq.embedding_set_id, i.embedding_set_id),
                 updated_at = $10
             FROM existing e
             JOIN input i ON i.dedupe_key = e.dedupe_key
             WHERE jq.id = e.id
             RETURNING jq.*
           ),
           ins AS (
             INSERT INTO job_queue (
               id, queue, job_type, payload, chunk_id, embedding_set_id, state, run_at, attempts, max_attempts, backoff_ms,
               lease_token, leased_until, worker_id, dedupe_key, error, created_at, updated_at
             )
             SELECT
               i.id, i.queue, i.job_type, i.payload, i.chunk_id, i.embedding_set_id, 'queued', i.run_at_text, 0, i.max_attempts, 0,
               NULL, NULL, NULL, i.dedupe_key, NULL, $10, $10
             FROM input i
             WHERE NOT EXISTS (SELECT 1 FROM existing e WHERE e.dedupe_key = i.dedupe_key)
             RETURNING *
           )
           SELECT * FROM upd
           UNION ALL
           SELECT * FROM ins`;
  }

  /**
   * Enqueue multiple jobs atomically in a single database query.
   * Significantly faster than calling enqueue() in a loop for large batches.
   *
   * Deduplication behavior:
   * - Intra-batch: Jobs with the same dedupeKey are deduplicated, keeping the earliest runAt.
   * - Database: Existing jobs with matching dedupeKey in 'queued'/'running' states are updated
   *   with the earlier runAt time. Payload is NOT updated.
   *
   * @param params - Array of job parameters to enqueue
   * @returns Array of Job objects (length <= params.length due to deduplication)
   */
  async enqueueBatch(params: EnqueueParams[]): Promise<Job[]> {
    if (params.length === 0) {
      return [];
    }
    if (params.length > JobQueue.MAX_BATCH_SIZE) {
      throw new Error(
        `Batch size ${params.length} exceeds maximum supported size of ${JobQueue.MAX_BATCH_SIZE}`
      );
    }
    if (params.length > 1000) {
      logger.warn('Large batch size detected for enqueueBatch', { count: params.length });
    }

    const now = new Date().toISOString();
    const idType = await this.getOrResolveIdType();
    this.validateIdType(idType);

    const processedParams = this.processBatchParams(params, now);

    const ids: string[] = [];
    const queues: string[] = [];
    const jobTypes: string[] = [];
    const payloads: string[] = [];
    const runAts: string[] = [];
    const maxAttemptsArr: number[] = [];
    const dedupeKeys: (string | null)[] = [];
    const chunkIds: (string | null)[] = [];
    const embeddingSetIds: (string | null)[] = [];

    const defaultMaxAttempts = this.defaults.maxAttempts ?? JobQueue.DEFAULT_MAX_ATTEMPTS;

    for (const p of processedParams) {
      ids.push(generateUUID());
      queues.push(p.queue);
      jobTypes.push(p.jobType);
      payloads.push(JSON.stringify(p.payload));
      runAts.push(p.runAt ?? now);
      maxAttemptsArr.push(p.maxAttempts ?? defaultMaxAttempts);
      dedupeKeys.push(p.dedupeKey ?? null);
      chunkIds.push(extractEmbedChunkId(p.jobType, p.payload));
      embeddingSetIds.push(extractEmbedEmbeddingSetId(p.jobType, p.payload));
    }

    const sql = this.buildBatchQuery(idType);

    const res = await this.db.query<JobRow>(sql, [
      ids,
      queues,
      jobTypes,
      payloads,
      runAts,
      maxAttemptsArr,
      dedupeKeys,
      chunkIds,
      embeddingSetIds,
      now,
    ]);

    const jobs = res.rows.map(fromRow);

    if (jobs.length > 0) {
      logger.debug('Jobs enqueued in batch', { count: jobs.length });

      const newIdSet = new Set(ids);

      for (const job of jobs) {
        const isNew = newIdSet.has(job.id);
        if (isNew) {
          emitQueueTelemetry({
            adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
            event: 'enqueue',
            metadata: {
              dedupeKey: job.dedupe_key ?? undefined,
              jobType: job.jobType,
              queue: job.queue,
            },
            taskId: job.id,
            timestamp: Date.now(),
          });
        }
      }
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
    const leasedUntil = new Date(Date.now() + params.leaseMs).toISOString();
    const updatedAt = now;
    const limit = Math.max(1, params.limit ?? 1);

    // Atomic claim: next runnable or expired lease; bump attempts on claim.
    // Re-check state/lease conditions in the UPDATE to prevent double-claim races.
    const result = await this.db.query<JobRow>(
      `WITH candidate AS (
         SELECT id
           FROM job_queue
          WHERE queue = $1
            AND attempts < max_attempts
            AND (
                  (state = 'queued'  AND run_at <= $2)
               OR (state = 'running' AND (leased_until IS NULL OR leased_until <= $2))
                )
          ORDER BY run_at ASC, id ASC
          LIMIT $7
          FOR UPDATE SKIP LOCKED
       )
       UPDATE job_queue AS j SET
         state = 'running',
         attempts = j.attempts + 1,
         lease_token = $3,
         leased_until = $4,
         worker_id = $5,
         updated_at = $6
       FROM candidate c
       WHERE j.id = c.id
         AND j.attempts < j.max_attempts
         AND (
               (j.state = 'queued'  AND j.run_at <= $2)
            OR (j.state = 'running' AND (j.leased_until IS NULL OR j.leased_until <= $2))
             )
       RETURNING j.*`,
      [params.queue, now, leaseToken, leasedUntil, params.workerId ?? null, updatedAt, limit]
    );

    const jobs = result.rows.map(fromRow);
    if (jobs.length > 0) {
      logger.trace('Jobs claimed', {
        count: jobs.length,
        leaseToken,
        queue: params.queue,
        workerId: params.workerId ?? null,
      });

      // Emit 'start' telemetry for each claimed job
      for (const job of jobs) {
        emitQueueTelemetry({
          adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
          event: 'start',
          metadata: {
            attempt: job.attempts,
            jobType: job.jobType,
            leaseMs: params.leaseMs,
            queue: job.queue,
            workerId: params.workerId ?? null,
          },
          taskId: job.id,
          timestamp: Date.now(),
        });
      }
    }
    return jobs;
  }

  async heartbeat(params: HeartbeatParams): Promise<Job | null> {
    const newLease = new Date(Date.now() + params.extendMs).toISOString();
    const updatedAt = new Date().toISOString();
    const res = await this.db.query<JobRow>(
      `UPDATE job_queue SET leased_until = $1, updated_at = $2
       WHERE id = $3 AND lease_token = $4 AND state = 'running'
       RETURNING *`,
      [newLease, updatedAt, params.id, params.leaseToken]
    );
    if (!res.rows[0]) {
      return null;
    }
    const job = fromRow(res.rows[0]);
    logger.debug('Heartbeat extended lease', {
      jobId: job.id,
      leasedUntil: job.leasedUntil,
      leaseToken: params.leaseToken,
    });
    return job;
  }

  /**
   * Heartbeat multiple jobs atomically in a single database query.
   * Efficiently updates lease expiration for a batch of jobs using PostgreSQL's `unnest`.
   * Only updates jobs where the ID and lease token match and the state is 'running'.
   *
   * @param jobs - Array of job identifiers (ID and lease token) to heartbeat.
   * @param extendMs - Milliseconds to extend the lease by (from now).
   * @returns Array of updated Job objects. Jobs with invalid leases (stolen/expired) are excluded from this list.
   */
  async heartbeatBatch(
    jobs: { id: string; leaseToken: string }[],
    extendMs: number
  ): Promise<Job[]> {
    if (jobs.length === 0) {
      return [];
    }
    const idType = await this.getOrResolveIdType();
    this.validateIdType(idType);
    const newLease = new Date(Date.now() + extendMs).toISOString();
    const updatedAt = new Date().toISOString();
    const ids = jobs.map((j) => j.id);
    const leaseTokens = jobs.map((j) => j.leaseToken);

    const sql =
      idType === 'uuid'
        ? `UPDATE job_queue AS j
           SET leased_until = $1, updated_at = $2
           FROM unnest($3::uuid[], $4::text[]) AS t(id, lease_token)
           WHERE j.id = t.id AND j.lease_token = t.lease_token AND j.state = 'running'
           RETURNING j.*`
        : `UPDATE job_queue AS j
           SET leased_until = $1, updated_at = $2
           FROM unnest($3::text[], $4::text[]) AS t(id, lease_token)
           WHERE j.id = t.id AND j.lease_token = t.lease_token AND j.state = 'running'
           RETURNING j.*`;

    const res = await this.db.query<JobRow>(sql, [newLease, updatedAt, ids, leaseTokens]);

    const updatedJobs = res.rows.map(fromRow);

    if (updatedJobs.length > 0) {
      logger.debug('Jobs heartbeated in batch', { count: updatedJobs.length });
    }

    return updatedJobs;
  }

  /**
   * Complete multiple jobs atomically in a single database query.
   * @param jobs Array of job IDs and lease tokens to complete
   * @returns Array of completed Job objects
   */
  async completeBatch(jobs: CompleteParams[]): Promise<Job[]> {
    if (jobs.length === 0) {
      return [];
    }
    const idType = await this.getOrResolveIdType();
    this.validateIdType(idType);
    const updatedAt = new Date().toISOString();
    const ids = jobs.map((j) => j.id);
    const leaseTokens = jobs.map((j) => j.leaseToken);

    const unnestSignature = idType === 'uuid' ? '$2::uuid[], $3::text[]' : '$2::text[], $3::text[]';
    const sql = `WITH completed AS (
       UPDATE job_queue AS j
          SET state = 'succeeded', leased_until = NULL, updated_at = $1
         FROM unnest(${unnestSignature}) AS t(id, lease_token)
        WHERE j.id = t.id AND j.lease_token = t.lease_token AND j.state = 'running'
        RETURNING j.*
     ),
     ${incrementOutcomeMetricsCte('completed', 'succeeded_total')}
     SELECT * FROM completed`;

    const res = await this.db.query<JobRow>(sql, [updatedAt, ids, leaseTokens]);

    const completedJobs = res.rows.map(fromRow);

    if (completedJobs.length > 0) {
      logger.trace('Jobs completed in batch', { count: completedJobs.length });
    }

    for (const job of completedJobs) {
      const elapsedMs = computeElapsedMs(job.runAt, updatedAt);
      emitQueueTelemetry({
        adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
        event: 'complete',
        taskId: job.id,
        timestamp: Date.now(),
        ...(typeof elapsedMs === 'number' ? { elapsedMs } : {}),
        metadata: {
          jobType: job.jobType,
          queue: job.queue,
        },
      });
    }

    return completedJobs;
  }

  /**
   * Atomically writes chunk embeddings and completes their jobs under the same lease guard.
   * A stale worker must not persist a vector after losing ownership of its job.
   */
  async completeEmbeddingChunkBatch(jobs: CompleteEmbeddingChunkParams[]): Promise<Job[]> {
    if (jobs.length === 0) {
      return [];
    }
    const jobIdType = await this.getOrResolveIdType();
    const chunkIdType = await this.getOrResolveFileChunkIdType();
    this.validateIdType(jobIdType);
    this.validateIdType(chunkIdType);

    const updatedAt = new Date().toISOString();
    const ids = jobs.map((job) => job.id);
    const leaseTokens = jobs.map((job) => job.leaseToken);
    const chunkIds = jobs.map((job) => job.chunkId);
    const embeddings = jobs.map((job) => `[${job.embedding.join(',')}]`);
    const embeddingSetIds = jobs.map((job) => job.embeddingSetId);
    const embeddingHashes = jobs.map((job) => job.embeddingHash);
    const jobIdArrayType = jobIdType === 'uuid' ? 'uuid[]' : 'text[]';
    const chunkIdArrayType = chunkIdType === 'uuid' ? 'uuid[]' : 'text[]';

    const res = await this.db.query<JobRow>(
      `WITH input AS (
         SELECT *
           FROM unnest(
             $2::${jobIdArrayType},
             $3::text[],
             $4::${chunkIdArrayType},
             $5::text[],
             $6::text[],
             $7::text[]
           ) AS t(id, lease_token, chunk_id, embedding, embedding_set_id, embedding_hash)
       ),
       owned_jobs AS (
         SELECT
           j.id AS job_id,
           i.chunk_id,
           i.embedding,
           i.embedding_set_id,
           i.embedding_hash
         FROM job_queue AS j
         JOIN input AS i
          ON j.id = i.id
          AND j.lease_token = i.lease_token
         WHERE j.state = 'running'
       ),
       chunk_updates AS (
         SELECT DISTINCT ON (chunk_id)
           chunk_id,
           embedding,
           embedding_set_id,
           embedding_hash
         FROM owned_jobs
         ORDER BY chunk_id, job_id
       ),
       updated_chunks AS (
         UPDATE file_chunks AS fc
            SET embedding = u.embedding::vector,
                embedding_set_id = u.embedding_set_id,
                embedding_updated_at = $1,
                embedding_hash = u.embedding_hash,
                updated_at = $1
           FROM chunk_updates AS u
          WHERE fc.id = u.chunk_id
          RETURNING fc.id AS chunk_id
       ),
       completed_jobs AS (
         UPDATE job_queue AS j
            SET state = 'succeeded',
                chunk_id = COALESCE(j.chunk_id, o.chunk_id::text),
                embedding_set_id = COALESCE(j.embedding_set_id, o.embedding_set_id),
                leased_until = NULL,
                updated_at = $1
           FROM owned_jobs AS o
           JOIN updated_chunks AS u ON u.chunk_id = o.chunk_id
          WHERE j.id = o.job_id
          RETURNING j.*
       ),
       ${incrementOutcomeMetricsCte('completed_jobs', 'succeeded_total')}
       SELECT * FROM completed_jobs`,
      [updatedAt, ids, leaseTokens, chunkIds, embeddings, embeddingSetIds, embeddingHashes]
    );

    const completedJobs = res.rows.map(fromRow);

    if (completedJobs.length > 0) {
      logger.trace('Embedding chunks completed in batch', { count: completedJobs.length });
    }

    for (const job of completedJobs) {
      const elapsedMs = computeElapsedMs(job.runAt, updatedAt);
      emitQueueTelemetry({
        adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
        event: 'complete',
        taskId: job.id,
        timestamp: Date.now(),
        ...(typeof elapsedMs === 'number' ? { elapsedMs } : {}),
        metadata: {
          jobType: job.jobType,
          queue: job.queue,
        },
      });
    }

    return completedJobs;
  }

  async complete(params: CompleteParams): Promise<Job | null> {
    const updatedAt = new Date().toISOString();
    const res = await this.db.query<JobRow>(
      `WITH completed AS (
         UPDATE job_queue SET state = 'succeeded', leased_until = NULL, updated_at = $1
          WHERE id = $2 AND lease_token = $3 AND state = 'running'
          RETURNING *
       ),
       ${incrementOutcomeMetricsCte('completed', 'succeeded_total')}
       SELECT * FROM completed`,
      [updatedAt, params.id, params.leaseToken]
    );
    if (!res.rows[0]) {
      return null;
    }
    const job = fromRow(res.rows[0]);
    // Use debug level for per-job completion to reduce log noise during bulk operations
    logger.debug('Job completed', { jobId: job.id, jobType: job.jobType, queue: job.queue });
    const elapsedMs = computeElapsedMs(job.runAt, updatedAt);
    emitQueueTelemetry({
      adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
      event: 'complete',
      taskId: job.id,
      timestamp: Date.now(),
      ...(typeof elapsedMs === 'number' ? { elapsedMs } : {}),
      metadata: {
        jobType: job.jobType,
        queue: job.queue,
      },
    });
    return job;
  }

  async fail(params: FailParams): Promise<Job | null> {
    // Load current to compute next state (attempts incremented on claim)
    const current = await this.db.query<JobRow>('SELECT * FROM job_queue WHERE id = $1', [
      params.id,
    ]);
    const row = current.rows[0];
    if (!row) {
      return null;
    }

    const attempts = row.attempts ?? 0;
    const now = new Date();
    const updatedAt = now.toISOString();
    const maxAttempts = row.max_attempts ?? 5;

    if (params.terminal || attempts >= maxAttempts) {
      // Poison pill — mark as failed. The state = 'running' guard makes the
      // transition (and the lifetime counter increment) exactly-once: a
      // repeated fail() with the same lease token finds no running row.
      const res = await this.db.query<JobRow>(
        `WITH failed AS (
           UPDATE job_queue SET state = 'failed', attempts = $1, error = $2, updated_at = $3
            WHERE id = $4 AND lease_token = $5 AND state = 'running'
            RETURNING *
         ),
         ${incrementOutcomeMetricsCte('failed', 'failed_total')}
         SELECT * FROM failed`,
        [attempts, params.error, updatedAt, params.id, params.leaseToken]
      );
      if (!res.rows[0]) {
        return null;
      }
      const failedJob = fromRow(res.rows[0]);
      logger.error('Job failed permanently', {
        error: params.error,
        jobId: failedJob.id,
        queue: failedJob.queue,
      });
      emitQueueTelemetry({
        adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
        errorMessage: params.error,
        event: 'error',
        metadata: {
          attempts,
          jobType: failedJob.jobType,
          queue: failedJob.queue,
          terminal: true,
        },
        taskId: failedJob.id,
        timestamp: Date.now(),
      });
      return failedJob;
    }

    const backoff = params.backoffMs ?? this.retryPolicy(attempts);
    const runAt = new Date(now.getTime() + backoff).toISOString();

    const res = await this.db.query<JobRow>(
      `UPDATE job_queue SET 
         state = 'queued',
         attempts = $1,
         backoff_ms = $2,
         run_at = $3,
         error = $4,
         leased_until = NULL,
         lease_token = NULL,
         updated_at = $5
       WHERE id = $6 AND lease_token = $7
       RETURNING *`,
      [attempts, backoff, runAt, params.error, updatedAt, params.id, params.leaseToken]
    );
    if (!res.rows[0]) {
      return null;
    }
    const retriedJob = fromRow(res.rows[0]);
    logger.warn('Job failed; retry scheduled', {
      attempts,
      jobId: retriedJob.id,
      queue: retriedJob.queue,
      retryAt: runAt,
    });
    emitQueueTelemetry({
      adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
      errorMessage: params.error,
      event: 'error',
      metadata: {
        attempts,
        jobType: retriedJob.jobType,
        queue: retriedJob.queue,
        retryAt: runAt,
      },
      taskId: retriedJob.id,
      timestamp: Date.now(),
    });
    return retriedJob;
  }

  private emitFailTelemetry(jobs: Job[], error: string, terminal: boolean): void {
    for (const job of jobs) {
      emitQueueTelemetry({
        adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
        errorMessage: error,
        event: 'error',
        metadata: {
          attempts: job.attempts,
          jobType: job.jobType,
          queue: job.queue,
          ...(terminal ? { terminal: true } : { retryAt: job.runAt }),
        },
        taskId: job.id,
        timestamp: Date.now(),
      });
    }
  }

  private failBatchTerminalSql(idCast: string): string {
    return `WITH failed AS (
         UPDATE job_queue AS j
         SET state = 'failed', error = $1, updated_at = $2
         FROM unnest($3::${idCast}[], $4::text[]) AS t(id, lease_token)
         WHERE j.id = t.id AND j.lease_token = t.lease_token AND j.state = 'running'
         RETURNING j.*
       ),
       ${incrementOutcomeMetricsCte('failed', 'failed_total')}
       SELECT * FROM failed`;
  }

  private classifyBatchJobs(
    rows: ReadonlyArray<{ attempts: number; id: string; max_attempts: number }>,
    tokenMap: Map<string, string>,
    now: Date,
    backoffMs: number | undefined
  ) {
    const exhausted: { ids: string[]; tokens: string[] } = { ids: [], tokens: [] };
    const retry: { backoffs: number[]; ids: string[]; runAts: string[]; tokens: string[] } = {
      backoffs: [],
      ids: [],
      runAts: [],
      tokens: [],
    };

    for (const row of rows) {
      const token = tokenMap.get(row.id);
      if (!token) {
        continue;
      }
      if (row.attempts >= row.max_attempts) {
        exhausted.ids.push(row.id);
        exhausted.tokens.push(token);
      } else {
        const backoff = backoffMs ?? this.retryPolicy(row.attempts);
        retry.ids.push(row.id);
        retry.tokens.push(token);
        retry.runAts.push(new Date(now.getTime() + backoff).toISOString());
        retry.backoffs.push(backoff);
      }
    }
    return { exhausted, retry };
  }

  /**
   * Fail multiple jobs atomically using batched queries.
   * Terminal failures: 1 query. Retryable: up to 3 queries (SELECT + 2 UPDATEs).
   * Much more efficient than calling fail() in a loop (2N queries).
   */
  async failBatch(params: FailBatchParams): Promise<Job[]> {
    if (params.jobs.length === 0) {
      return [];
    }
    const idType = await this.getOrResolveIdType();
    this.validateIdType(idType);
    const now = new Date();
    const updatedAt = now.toISOString();
    const ids = params.jobs.map((j) => j.id);
    const leaseTokens = params.jobs.map((j) => j.leaseToken);
    const idCast = idType === 'uuid' ? 'uuid' : 'text';

    // Terminal branch: all jobs go straight to 'failed'
    if (params.terminal) {
      const res = await this.db.query<JobRow>(this.failBatchTerminalSql(idCast), [
        params.error,
        updatedAt,
        ids,
        leaseTokens,
      ]);
      const failedJobs = res.rows.map(fromRow);
      if (failedJobs.length > 0) {
        logger.error('Jobs failed permanently in batch', { count: failedJobs.length });
        this.emitFailTelemetry(failedJobs, params.error, true);
      }
      return failedJobs;
    }

    // Retryable branch: need to check attempts vs max_attempts per job
    const selectSql = `SELECT id, attempts, max_attempts FROM job_queue
       WHERE (id, lease_token) IN (SELECT * FROM unnest($1::${idCast}[], $2::text[]))
         AND state = 'running'`;

    const current = await this.db.query<{ attempts: number; id: string; max_attempts: number }>(
      selectSql,
      [ids, leaseTokens]
    );
    if (current.rows.length === 0) {
      return [];
    }

    const tokenMap = new Map(params.jobs.map((j) => [j.id, j.leaseToken]));
    const { exhausted, retry } = this.classifyBatchJobs(
      current.rows,
      tokenMap,
      now,
      params.backoffMs
    );

    const allResults: Job[] = [];

    // UPDATE exhausted → 'failed'
    if (exhausted.ids.length > 0) {
      const res = await this.db.query<JobRow>(this.failBatchTerminalSql(idCast), [
        params.error,
        updatedAt,
        exhausted.ids,
        exhausted.tokens,
      ]);
      const failedJobs = res.rows.map(fromRow);
      allResults.push(...failedJobs);
      this.emitFailTelemetry(failedJobs, params.error, true);
    }

    // UPDATE retryable → 'queued' with per-job run_at
    if (retry.ids.length > 0) {
      const retrySql = `UPDATE job_queue AS j
         SET state = 'queued',
             error = $1,
             run_at = t.run_at::timestamptz,
             backoff_ms = t.backoff::int,
             leased_until = NULL,
             lease_token = NULL,
             updated_at = $2
         FROM unnest($3::${idCast}[], $4::text[], $5::text[], $6::int[])
           AS t(id, lease_token, run_at, backoff)
         WHERE j.id = t.id AND j.lease_token = t.lease_token AND j.state = 'running'
         RETURNING j.*`;

      const res = await this.db.query<JobRow>(retrySql, [
        params.error,
        updatedAt,
        retry.ids,
        retry.tokens,
        retry.runAts,
        retry.backoffs,
      ]);
      const retriedJobs = res.rows.map(fromRow);
      allResults.push(...retriedJobs);
      this.emitFailTelemetry(retriedJobs, params.error, false);
    }

    if (allResults.length > 0) {
      logger.debug('Jobs failed in batch', {
        exhausted: exhausted.ids.length,
        retried: retry.ids.length,
        total: allResults.length,
      });
    }

    return allResults;
  }

  async cancel(params: CancelParams): Promise<Job | null> {
    const updatedAt = new Date().toISOString();

    // If leaseToken provided, only cancel if we own the lease
    const leaseCondition = params.leaseToken ? 'AND lease_token = $3' : '';
    const queryParams = params.leaseToken
      ? [updatedAt, params.id, params.leaseToken]
      : [updatedAt, params.id];

    const res = await this.db.query<JobRow>(
      `WITH canceled AS (
         UPDATE job_queue SET state = 'canceled', leased_until = NULL, updated_at = $1
          WHERE id = $2 AND state IN ('queued', 'running') ${leaseCondition}
          RETURNING *
       ),
       ${incrementOutcomeMetricsCte('canceled', 'canceled_total')}
       SELECT * FROM canceled`,
      queryParams
    );

    if (!res.rows[0]) {
      return null;
    }

    const job = fromRow(res.rows[0]);
    logger.info('Job canceled', {
      jobId: job.id,
      jobType: job.jobType,
      queue: job.queue,
      reason: params.reason,
    });

    emitQueueTelemetry({
      adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
      event: 'cancel',
      metadata: {
        jobType: job.jobType,
        queue: job.queue,
        reason: params.reason,
      },
      taskId: job.id,
      timestamp: Date.now(),
    });

    return job;
  }

  async cancelMany(queue: string, reason?: string): Promise<number> {
    const updatedAt = new Date().toISOString();

    // Single-statement cancel: telemetry is emitted from the RETURNING rows, so
    // the reported set is exactly what this statement transitioned (no window
    // between a telemetry snapshot read and the cancel write). The lifetime
    // canceled counter is folded in, counting every transitioned row.
    const res = await this.db.query<JobRow>(
      `WITH canceled AS (
         UPDATE job_queue SET state = 'canceled', leased_until = NULL, updated_at = $1
          WHERE queue = $2 AND state IN ('queued', 'running')
          RETURNING *
       ),
       ${incrementOutcomeMetricsCte('canceled', 'canceled_total')}
       SELECT * FROM canceled`,
      [updatedAt, queue]
    );

    const count = res.rows.length;

    if (count > 0) {
      logger.info('Jobs canceled in bulk', { count, queue, reason });

      for (const row of res.rows) {
        const job = fromRow(row);
        emitQueueTelemetry({
          adapter: JOB_QUEUE_TELEMETRY_ADAPTER,
          event: 'cancel',
          metadata: {
            bulkCancel: true,
            jobType: job.jobType,
            queue: job.queue,
            reason,
          },
          taskId: job.id,
          timestamp: Date.now(),
        });
      }
    }

    return count;
  }

  async expireLeases(nowIso?: string): Promise<number> {
    const now = nowIso ?? new Date().toISOString();
    const res = await this.db.query<{ count: string }>(
      `WITH cte AS (
        SELECT id FROM job_queue
        WHERE state = 'running' AND leased_until IS NOT NULL AND leased_until <= $1
      ), upd AS (
        UPDATE job_queue SET
          state = 'queued',
          lease_token = NULL,
          leased_until = NULL,
          updated_at = $1
        WHERE id IN (SELECT id FROM cte)
        RETURNING 1
      ) SELECT COUNT(*)::text as count FROM upd`,
      [now]
    );
    const released = Number(res.rows[0]?.count ?? 0);
    if (released > 0) {
      logger.warn('Expired job leases', { count: released });
    }
    return released;
  }

  async prune(states: JobState[], olderThanIso: string): Promise<number> {
    if (!olderThanIso) {
      throw new Error('olderThanIso is required');
    }
    const placeholders = states.map((_, i) => `$${i + 2}`).join(',');
    const res = await this.db.query<{ count: string }>(
      `WITH del AS (
        DELETE FROM job_queue
         WHERE updated_at < $1
           AND state IN (${placeholders})
        RETURNING 1
      ) SELECT COUNT(*)::text as count FROM del`,
      [olderThanIso, ...states]
    );
    const removed = Number(res.rows[0]?.count ?? 0);
    if (removed > 0) {
      logger.info('Pruned historical jobs', { count: removed, olderThanIso, states });
    }
    return removed;
  }

  // Stats helpers
  async getCountsByState(
    queue?: string
  ): Promise<Array<{ queue: string; state: JobState; count: number }>> {
    const res = await this.db.query<{ queue: string; state: JobState; count: string }>(
      `SELECT queue, state, COUNT(*)::text as count
       FROM job_queue
       ${queue ? 'WHERE queue = $1' : ''}
       GROUP BY queue, state
       ORDER BY queue, state`,
      queue ? [queue] : []
    );
    return res.rows.map((r) => ({ count: Number(r.count), queue: r.queue, state: r.state }));
  }

  async getQueueStats(queue?: string): Promise<
    {
      queue: string;
      queued: number;
      running: number;
      failed: number;
      succeeded: number;
      succeededLifetime: number;
      /**
       * Durable lifetime outcome totals (migration 063). Optional in the type
       * so pre-existing JobQueue mocks/stubs stay assignable; the real
       * implementation always returns them.
       */
      failedLifetime?: number;
      canceledLifetime?: number;
      nextRunnableAt?: string | null;
    }[]
  > {
    const counts = await this.getCountsByState(queue);
    const queues = new Map<
      string,
      { queued: number; running: number; failed: number; succeeded: number }
    >();
    const ensureEntry = (q: string) => {
      const existing = queues.get(q);
      if (existing) {
        return existing;
      }
      const created = { failed: 0, queued: 0, running: 0, succeeded: 0 };
      queues.set(q, created);
      return created;
    };
    for (const c of counts) {
      const entry = ensureEntry(c.queue);
      if (c.state === 'queued') {
        entry.queued += c.count;
      }
      if (c.state === 'running') {
        entry.running += c.count;
      }
      if (c.state === 'failed') {
        entry.failed += c.count;
      }
      if (c.state === 'succeeded') {
        entry.succeeded += c.count;
      }
    }

    // Durable lifetime outcome totals. A queue whose live rows were all pruned
    // still has a metrics row, so surface it even with zero live counts —
    // otherwise the HUD's cumulative totals would vanish after a prune.
    const metricsRes = await this.db.query<{
      queue: string;
      succeeded_total: string | number;
      failed_total: string | number;
      canceled_total: string | number;
    }>(
      `SELECT queue, succeeded_total, failed_total, canceled_total
       FROM job_queue_metrics ${queue ? 'WHERE queue = $1' : ''}`,
      queue ? [queue] : []
    );
    const succeededLifetime = new Map<string, number>();
    const failedLifetime = new Map<string, number>();
    const canceledLifetime = new Map<string, number>();
    for (const row of metricsRes.rows) {
      succeededLifetime.set(row.queue, Number(row.succeeded_total ?? 0));
      failedLifetime.set(row.queue, Number(row.failed_total ?? 0));
      canceledLifetime.set(row.queue, Number(row.canceled_total ?? 0));
      ensureEntry(row.queue);
    }

    const res = await this.db.query<{ queue: string; run_at: string }>(
      `SELECT queue, MIN(run_at) as run_at
       FROM job_queue
       WHERE state = 'queued' ${queue ? 'AND queue = $1' : ''}
       GROUP BY queue`,
      queue ? [queue] : []
    );
    const minRunAt = new Map<string, string>();
    for (const row of res.rows) {
      minRunAt.set(row.queue, row.run_at);
    }

    return Array.from(queues.entries()).map(([q, stats]) => ({
      canceledLifetime: canceledLifetime.get(q) ?? 0,
      failed: stats.failed,
      failedLifetime: failedLifetime.get(q) ?? 0,
      nextRunnableAt: minRunAt.get(q) ?? null,
      queue: q,
      queued: stats.queued,
      running: stats.running,
      succeeded: stats.succeeded,
      succeededLifetime: succeededLifetime.get(q) ?? 0,
    }));
  }

  async clear(queue?: string, states?: JobState[]): Promise<number> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (queue) {
      conditions.push(`queue = $${p++}`);
      params.push(queue);
    }
    if (states && states.length > 0) {
      const placeholders = states.map((_, i) => `$${p + i}`).join(',');
      conditions.push(`state IN (${placeholders})`);
      params.push(...states);
      p += states.length;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.db.query<{ count: string }>(
      `WITH del AS (
        DELETE FROM job_queue ${where}
        RETURNING 1
      ) SELECT COUNT(*)::text as count FROM del`,
      params
    );
    const removed = Number(res.rows[0]?.count ?? 0);
    if (removed > 0) {
      logger.info('Cleared job queue entries', { count: removed, queue: queue ?? 'all', states });
    }
    return removed;
  }

  async requeueFailed(
    queue?: string,
    limit = 20,
    options: QueueRetryOptions = {}
  ): Promise<number> {
    const now = new Date().toISOString();
    const params: unknown[] = [now, limit];
    const conditions = ["state = 'failed'"];
    if (queue) {
      params.push(queue);
      conditions.push(`queue = $${params.length}`);
    }
    if (options.embeddingSetId) {
      params.push(options.embeddingSetId);
      conditions.push(`embedding_set_id = $${params.length}`);
    }
    const res = await this.db.query<{ count: string }>(
      `WITH cte AS (
        SELECT id FROM job_queue
        WHERE ${conditions.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT $2
      ), upd AS (
        UPDATE job_queue SET
          state = 'queued',
          attempts = 0,
          run_at = $1,
          backoff_ms = 0,
          leased_until = NULL,
          lease_token = NULL,
          error = NULL,
          updated_at = $1
        WHERE id IN (SELECT id FROM cte)
        RETURNING 1
      ) SELECT COUNT(*)::text as count FROM upd`,
      params
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async repairUnclaimableQueued(
    queue?: string,
    limit = 20,
    options: QueueRetryOptions = {}
  ): Promise<number> {
    const now = new Date().toISOString();
    const params: unknown[] = [now, limit];
    const conditions = ["state = 'queued'", 'attempts >= max_attempts'];
    if (queue) {
      params.push(queue);
      conditions.push(`queue = $${params.length}`);
    }
    if (options.embeddingSetId) {
      params.push(options.embeddingSetId);
      conditions.push(`embedding_set_id = $${params.length}`);
    }
    const res = await this.db.query<{ count: string }>(
      `WITH cte AS (
        SELECT id FROM job_queue
        WHERE ${conditions.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT $2
      ), upd AS (
        UPDATE job_queue SET
          attempts = 0,
          run_at = $1,
          backoff_ms = 0,
          leased_until = NULL,
          lease_token = NULL,
          error = NULL,
          updated_at = $1
        WHERE id IN (SELECT id FROM cte)
        RETURNING 1
      ) SELECT COUNT(*)::text as count FROM upd`,
      params
    );
    return Number(res.rows[0]?.count ?? 0);
  }
}
