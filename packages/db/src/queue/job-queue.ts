import { generateUUID } from '@brainstrike/utils';
import type { IDatabase } from '../repositories/interfaces.js';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired';

export type JobType = 'embed_chunk';

export interface JobRow {
  id: string;
  queue: string;
  job_type: string;
  payload: unknown | null;
  state: JobState;
  run_at: string;
  attempts: number;
  max_attempts: number;
  backoff_ms: number;
  lease_token?: string | null;
  leased_until?: string | null;
  worker_id?: string | null;
  dedupe_key?: string | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Job extends Omit<JobRow, 'job_type' | 'payload' | 'run_at' | 'leased_until'> {
  jobType: JobType;
  runAt: string;
  leasedUntil?: string | null;
  payload?: unknown | null;
}

function fromRow(row: JobRow): Job {
  return {
    id: row.id,
    queue: row.queue,
    jobType: row.job_type as JobType,
    payload: row.payload ?? null,
    state: row.state,
    runAt: row.run_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    backoff_ms: row.backoff_ms,
    lease_token: row.lease_token ?? null,
    leasedUntil: row.leased_until ?? null,
    worker_id: row.worker_id ?? null,
    dedupe_key: row.dedupe_key ?? null,
    error: row.error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  } as unknown as Job; // property names aligned above
}

export interface EnqueueParams {
  queue: string;
  jobType: JobType;
  payload: unknown;
  dedupeKey?: string;
  runAt?: string; // ISO string; defaults to now
  maxAttempts?: number; // defaults to configured
}

export interface ClaimParams {
  queue: string;
  leaseMs: number;
  now?: string; // ISO string; defaults to now
  workerId?: string;
}

export interface HeartbeatParams {
  id: string;
  leaseToken: string;
  extendMs: number;
}

export interface CompleteParams {
  id: string;
  leaseToken: string;
}

export interface FailParams {
  id: string;
  leaseToken: string;
  error: string;
}

export class JobQueue {
  constructor(
    private db: IDatabase,
    private defaults: { maxAttempts?: number } = {}
  ) {}

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
    const maxAttempts = params.maxAttempts ?? this.defaults.maxAttempts ?? 5;
    const dedupe = params.dedupeKey ?? null;

    // If a dedupe key is provided, honor it for active states by checking first
    if (dedupe) {
      const existing = await this.db.query<JobRow>(
        `SELECT * FROM job_queue 
         WHERE dedupe_key = $1 AND state IN ('queued','running')
         LIMIT 1`,
        [dedupe]
      );
      if (existing.rows[0]) return fromRow(existing.rows[0]);
    }

    const inserted = await this.db.query<JobRow>(
      `INSERT INTO job_queue (
        id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, 
        lease_token, leased_until, worker_id, dedupe_key, error, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,'queued',$5,0,$6,0,NULL,NULL,NULL,$7,NULL,$8,$8)
      RETURNING *`,
      [
        id,
        params.queue,
        params.jobType,
        JSON.stringify(params.payload),
        runAt,
        maxAttempts,
        dedupe,
        now,
      ]
    );

    if (!inserted.rows[0]) {
      throw new Error('Failed to insert job');
    }
    return fromRow(inserted.rows[0]);
  }

  async claim(params: ClaimParams): Promise<Job | null> {
    const now = params.now ?? new Date().toISOString();
    const leaseToken = generateUUID();
    const leasedUntil = new Date(Date.now() + params.leaseMs).toISOString();
    const updatedAt = now;

    // Atomic claim: select one eligible job and move it to running
    const result = await this.db.query<JobRow>(
      `WITH candidate AS (
        SELECT id FROM job_queue
        WHERE queue = $1 AND state = 'queued' AND run_at <= $2
        ORDER BY run_at ASC
        LIMIT 1
      )
      UPDATE job_queue SET
        state = 'running',
        lease_token = $3,
        leased_until = $4,
        worker_id = $5,
        updated_at = $6
      WHERE id IN (SELECT id FROM candidate)
      RETURNING *`,
      [params.queue, now, leaseToken, leasedUntil, params.workerId ?? null, updatedAt]
    );

    if (!result.rows[0]) return null;
    return fromRow(result.rows[0]);
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
    return res.rows[0] ? fromRow(res.rows[0]) : null;
  }

  async complete(params: CompleteParams): Promise<Job | null> {
    const updatedAt = new Date().toISOString();
    const res = await this.db.query<JobRow>(
      `UPDATE job_queue SET state = 'succeeded', leased_until = NULL, updated_at = $1
       WHERE id = $2 AND lease_token = $3 AND state = 'running'
       RETURNING *`,
      [updatedAt, params.id, params.leaseToken]
    );
    return res.rows[0] ? fromRow(res.rows[0]) : null;
  }

  async fail(params: FailParams): Promise<Job | null> {
    // Load current to compute next state
    const current = await this.db.query<JobRow>('SELECT * FROM job_queue WHERE id = $1', [
      params.id,
    ]);
    const row = current.rows[0];
    if (!row) return null;

    const attempts = (row.attempts ?? 0) + 1;
    const now = new Date();
    const updatedAt = now.toISOString();
    const maxAttempts = row.max_attempts ?? 5;

    if (attempts >= maxAttempts) {
      // Poison pill — mark as failed
      const res = await this.db.query<JobRow>(
        `UPDATE job_queue SET state = 'failed', attempts = $1, error = $2, updated_at = $3
         WHERE id = $4 AND lease_token = $5
         RETURNING *`,
        [attempts, params.error, updatedAt, params.id, params.leaseToken]
      );
      return res.rows[0] ? fromRow(res.rows[0]) : null;
    }

    const backoff = this.retryPolicy(attempts);
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
    return res.rows[0] ? fromRow(res.rows[0]) : null;
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
    return res.rows.map((r) => ({ queue: r.queue, state: r.state, count: Number(r.count) }));
  }

  async getQueueStats(queue?: string): Promise<
    {
      queue: string;
      queued: number;
      running: number;
      failed: number;
      succeeded: number;
      nextRunnableAt?: string | null;
    }[]
  > {
    const counts = await this.getCountsByState(queue);
    const queues = new Map<
      string,
      { queued: number; running: number; failed: number; succeeded: number }
    >();
    for (const c of counts) {
      const entry = queues.get(c.queue) ?? { queued: 0, running: 0, failed: 0, succeeded: 0 };
      if (c.state === 'queued') entry.queued += c.count;
      if (c.state === 'running') entry.running += c.count;
      if (c.state === 'failed') entry.failed += c.count;
      if (c.state === 'succeeded') entry.succeeded += c.count;
      queues.set(c.queue, entry);
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
      queue: q,
      queued: stats.queued,
      running: stats.running,
      failed: stats.failed,
      succeeded: stats.succeeded,
      nextRunnableAt: minRunAt.get(q) ?? null,
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
    return Number(res.rows[0]?.count ?? 0);
  }

  async requeueFailed(queue?: string, limit = 20): Promise<number> {
    const now = new Date().toISOString();
    const params: unknown[] = [now, limit];
    let queueClause = '';
    if (queue) {
      queueClause = 'AND queue = $3';
      params.push(queue);
    }
    const res = await this.db.query<{ count: string }>(
      `WITH cte AS (
        SELECT id FROM job_queue
        WHERE state = 'failed' ${queueClause}
        ORDER BY updated_at DESC
        LIMIT $2
      ), upd AS (
        UPDATE job_queue SET
          state = 'queued',
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
