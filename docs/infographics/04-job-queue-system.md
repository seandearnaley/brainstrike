# Infographic Design Brief: Job Queue System Architecture

## Context

BrainStrike's embedding generation is computationally expensive (100ms - 2s per chunk). Running this synchronously would freeze the UI. The solution is a robust, database-backed job queue that:
- Decouples job creation from execution
- Enables background processing
- Provides automatic retry with backoff
- Prevents duplicate work
- Supports concurrency control
- Offers observability and monitoring

## The Problem

**Without a Queue**:
```typescript
// ❌ BAD: Blocks UI for minutes
async function importFiles(files: File[]) {
  for (const file of files) {
    const chunks = await chunkFile(file);       // 1s
    for (const chunk of chunks) {
      const embedding = await generateEmbedding(chunk); // 500ms each!
      await saveEmbedding(embedding);
    }
  }
  // User waits 10 minutes staring at frozen UI
}
```

**With a Queue**:
```typescript
// ✓ GOOD: Returns immediately
async function importFiles(files: File[]) {
  for (const file of files) {
    const chunks = await chunkFile(file);       // 1s
    for (const chunk of chunks) {
      await jobQueue.enqueue({                  // < 1ms per job
        jobType: 'embed_chunk',
        payload: { chunkId: chunk.id },
      });
    }
  }
  // Returns in ~5 seconds
  // Background worker processes jobs asynchronously
}
```

## Architecture Overview

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Producer  │────▶│  Job Queue   │────▶│   Consumer   │
│  (Enqueue)  │     │  (Database)  │     │   (Worker)   │
└─────────────┘     └──────────────┘     └──────────────┘
      │                    │                     │
      │                    │                     │
   Instant              Durable              Async
  Response            Persistent          Processing
```

## Database Schema

### job_queue Table

```sql
CREATE TABLE job_queue (
  -- Identity
  id                TEXT PRIMARY KEY,           -- UUID
  queue             TEXT NOT NULL,              -- 'embeddings', 'import', etc.
  job_type          TEXT NOT NULL,              -- 'embed_chunk', 'import_file', etc.

  -- Payload & State
  payload           TEXT,                       -- JSON-encoded job data
  state             TEXT NOT NULL,              -- 'queued', 'running', 'succeeded', 'failed', 'canceled', 'expired'

  -- Scheduling
  run_at            TEXT NOT NULL,              -- ISO timestamp - when to run
  attempts          INTEGER NOT NULL DEFAULT 0, -- How many times we've tried
  max_attempts      INTEGER NOT NULL DEFAULT 5, -- Give up after this many
  backoff_ms        INTEGER NOT NULL DEFAULT 0, -- Delay before next retry

  -- Locking (prevent double-processing)
  lease_token       TEXT,                       -- UUID - who owns this job
  leased_until      TEXT,                       -- ISO timestamp - when lease expires
  worker_id         TEXT,                       -- Which worker claimed this

  -- Deduplication
  dedupe_key        TEXT,                       -- Unique constraint with state

  -- Error Tracking
  error             TEXT,                       -- Last error message (max 4KB)

  -- Timestamps
  created_at        TEXT NOT NULL,              -- When job was created
  updated_at        TEXT NOT NULL               -- Last state change
);

-- Indexes
CREATE INDEX idx_job_queue_state_run_at ON job_queue(queue, state, run_at);
CREATE INDEX idx_job_queue_lease ON job_queue(state, leased_until) WHERE state = 'running';
CREATE UNIQUE INDEX idx_job_queue_dedupe ON job_queue(dedupe_key, state)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running');
```

### Why These Columns?

**lease_token**: Prevents race condition where two workers claim same job
**leased_until**: Detect stuck workers (lease expired but still 'running')
**dedupe_key**: Prevent enqueueing duplicate jobs (e.g., same chunk twice)
**run_at**: Schedule jobs for future execution (delayed retry)
**backoff_ms**: Track current backoff duration for observability

## Job Lifecycle

```
          ┌─────────┐
          │ ENQUEUE │
          └────┬────┘
               │
               ▼
          ┌─────────┐
      ┌──▶│ QUEUED  │◀──┐
      │   └────┬────┘   │
      │        │         │
      │        │ claim   │
      │        ▼         │
      │   ┌─────────┐   │
      │   │ RUNNING │   │ retry
      │   └────┬────┘   │ (< max_attempts)
      │        │         │
      │   ┌────┴────┐   │
      │   │         │   │
      ▼   ▼         ▼   │
  ┌─────────┐  ┌─────────┐
  │SUCCEEDED│  │ FAILED  │
  └─────────┘  └────┬────┘
                    │
                    ▼
               (poison pill
                after 5 attempts)
```

## Job Queue Class

Located in `packages/db/src/queue/job-queue.ts`

### Core API

```typescript
export class JobQueue {
  constructor(private db: IDatabase, private defaults: { maxAttempts?: number } = {}) {}

  // 1. Enqueue a job
  async enqueue(params: EnqueueParams): Promise<Job>

  // 2. Claim next available job
  async claim(params: ClaimParams): Promise<Job | null>

  // 3. Extend lease (heartbeat)
  async heartbeat(params: HeartbeatParams): Promise<Job | null>

  // 4. Mark job as complete
  async complete(params: CompleteParams): Promise<Job | null>

  // 5. Mark job as failed (with retry)
  async fail(params: FailParams): Promise<Job | null>

  // 6. Admin operations
  async expireLeases(nowIso?: string): Promise<number>
  async prune(states: JobState[], olderThanIso: string): Promise<number>
  async getQueueStats(queue?: string): Promise<QueueStats[]>
  async clear(queue?: string, states?: JobState[]): Promise<number>
  async requeueFailed(queue?: string, limit?: number): Promise<number>
}
```

## Operation Deep Dive

### 1. Enqueue (Producer)

**Goal**: Add a job to the queue (idempotently)

```typescript
interface EnqueueParams {
  queue: string;              // 'embeddings'
  jobType: JobType;           // 'embed_chunk'
  payload: unknown;           // { chunkId: '123', modelKey: '...' }
  dedupeKey?: string;         // Optional: prevent duplicates
  runAt?: string;             // Optional: schedule for later (ISO timestamp)
  maxAttempts?: number;       // Optional: override default (5)
}

async function enqueue(params: EnqueueParams): Promise<Job> {
  const now = new Date().toISOString();
  const id = generateUUID();
  const runAt = params.runAt ?? now;
  const maxAttempts = params.maxAttempts ?? this.defaults.maxAttempts ?? 5;
  const dedupe = params.dedupeKey ?? null;

  // Atomic upsert using CTE (Common Table Expression)
  const result = await this.db.query(`
    WITH existing AS (
      -- Check if job already exists (by dedupeKey)
      SELECT * FROM job_queue
      WHERE dedupe_key = $7
        AND state IN ('queued', 'running')
      LIMIT 1
    ),
    upd AS (
      -- Update existing job (run sooner if new runAt is earlier)
      UPDATE job_queue
      SET run_at = LEAST(run_at, $5),
          updated_at = GREATEST(updated_at, $8)
      WHERE id IN (SELECT id FROM existing)
      RETURNING *
    ),
    ins AS (
      -- Insert new job (only if no existing job)
      INSERT INTO job_queue (
        id, queue, job_type, payload, state, run_at,
        attempts, max_attempts, backoff_ms,
        lease_token, leased_until, worker_id,
        dedupe_key, error, created_at, updated_at
      )
      SELECT $1, $2, $3, $4, 'queued', $5, 0, $6, 0,
             NULL, NULL, NULL, $7, NULL, $8, $8
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING *
    )
    SELECT * FROM upd UNION ALL SELECT * FROM ins
    LIMIT 1
  `, [
    id,                           // $1
    params.queue,                 // $2
    params.jobType,               // $3
    JSON.stringify(params.payload), // $4
    runAt,                        // $5
    maxAttempts,                  // $6
    dedupe,                       // $7
    now,                          // $8
  ]);

  const job = fromRow(result.rows[0]);

  // Emit telemetry
  if (job.id === id) {
    // New job created
    emitQueueTelemetry({ event: 'enqueue', taskId: job.id, ... });
  } else {
    // Existing job returned (deduped)
    logger.debug('Job enqueue deduped', { jobId: job.id, dedupeKey: dedupe });
  }

  return job;
}
```

**Why CTE?**: Atomic operation - prevents race condition where two enqueues create duplicate jobs.

### 2. Claim (Consumer)

**Goal**: Atomically claim the next runnable job

```typescript
interface ClaimParams {
  queue: string;              // 'embeddings'
  leaseMs: number;            // 60000 (60 seconds)
  now?: string;               // Optional: override current time (for tests)
  workerId?: string;          // Optional: worker identifier
}

async function claim(params: ClaimParams): Promise<Job | null> {
  const now = params.now ?? new Date().toISOString();
  const leaseToken = generateUUID();
  const leasedUntil = new Date(Date.now() + params.leaseMs).toISOString();
  const updatedAt = now;

  // Atomic claim with re-check to prevent double-claim
  const result = await this.db.query(`
    WITH candidate AS (
      -- Find next runnable job
      SELECT id FROM job_queue
      WHERE queue = $1
        AND attempts < max_attempts
        AND (
          -- Fresh queued jobs ready to run
          (state = 'queued' AND run_at <= $2)
          OR
          -- Running jobs with expired lease (stuck worker)
          (state = 'running' AND (leased_until IS NULL OR leased_until <= $2))
        )
      ORDER BY run_at ASC, id ASC
      LIMIT 1
    )
    UPDATE job_queue AS j SET
      state = 'running',
      attempts = j.attempts + 1,        -- Increment on claim (not fail)
      lease_token = $3,
      leased_until = $4,
      worker_id = $5,
      updated_at = $6
    FROM candidate c
    WHERE j.id = c.id
      -- Re-check conditions to prevent double-claim race
      AND j.attempts < j.max_attempts
      AND (
        (j.state = 'queued' AND j.run_at <= $2)
        OR (j.state = 'running' AND (j.leased_until IS NULL OR j.leased_until <= $2))
      )
    RETURNING j.*
  `, [
    params.queue,      // $1
    now,               // $2
    leaseToken,        // $3
    leasedUntil,       // $4
    params.workerId ?? null, // $5
    updatedAt,         // $6
  ]);

  if (!result.rows[0]) return null;

  const job = fromRow(result.rows[0]);
  logger.debug('Job claimed', {
    jobId: job.id,
    leaseToken,
    workerId: params.workerId,
    attempts: job.attempts,
  });

  return job;
}
```

**Key Details**:
- `ORDER BY run_at ASC, id ASC`: Processes oldest jobs first (FIFO)
- Re-check conditions in UPDATE: Prevents race where two workers claim same job
- `attempts + 1` on claim: Tracks total attempts including current
- Expired lease reclaim: Automatically recovers stuck jobs

### 3. Heartbeat (Keep-Alive)

**Goal**: Extend lease to prevent job from appearing as "stuck"

```typescript
interface HeartbeatParams {
  id: string;
  leaseToken: string;
  extendMs: number;     // Usually same as original lease (60s)
}

async function heartbeat(params: HeartbeatParams): Promise<Job | null> {
  const newLease = new Date(Date.now() + params.extendMs).toISOString();
  const updatedAt = new Date().toISOString();

  const result = await this.db.query(`
    UPDATE job_queue
    SET leased_until = $1,
        updated_at = $2
    WHERE id = $3
      AND lease_token = $4      -- Must own the lease
      AND state = 'running'     -- Must still be running
    RETURNING *
  `, [newLease, updatedAt, params.id, params.leaseToken]);

  if (!result.rows[0]) {
    // Heartbeat failed - job may have been completed/failed by another process
    return null;
  }

  const job = fromRow(result.rows[0]);
  logger.debug('Heartbeat extended lease', {
    jobId: job.id,
    leasedUntil: job.leasedUntil,
  });

  return job;
}
```

**Usage in Worker**:
```typescript
const heartbeat = setInterval(() => {
  jobQueue.heartbeat({
    id: job.id,
    leaseToken: job.lease_token,
    extendMs: 60_000,
  }).catch(err =>
    logger.error('Heartbeat failed', { jobId: job.id, error: err })
  );
}, 10_000); // Heartbeat every 10 seconds

// Clear on job completion
clearInterval(heartbeat);
```

### 4. Complete (Success)

**Goal**: Mark job as successfully completed

```typescript
interface CompleteParams {
  id: string;
  leaseToken: string;
}

async function complete(params: CompleteParams): Promise<Job | null> {
  const updatedAt = new Date().toISOString();

  const result = await this.db.query(`
    UPDATE job_queue
    SET state = 'succeeded',
        leased_until = NULL,
        updated_at = $1
    WHERE id = $2
      AND lease_token = $3      -- Must own the lease
      AND state = 'running'
    RETURNING *
  `, [updatedAt, params.id, params.leaseToken]);

  if (!result.rows[0]) return null;

  const job = fromRow(result.rows[0]);
  logger.info('Job completed', {
    jobId: job.id,
    queue: job.queue,
    jobType: job.jobType,
  });

  // Emit telemetry
  const elapsedMs = computeElapsedMs(job.runAt, updatedAt);
  emitQueueTelemetry({
    event: 'complete',
    taskId: job.id,
    elapsedMs,
    metadata: { queue: job.queue, jobType: job.jobType },
  });

  return job;
}
```

### 5. Fail (Retry Logic)

**Goal**: Mark job as failed, schedule retry with backoff OR mark as poison pill

```typescript
interface FailParams {
  id: string;
  leaseToken: string;
  error: string;        // Truncated to 4KB max
}

async function fail(params: FailParams): Promise<Job | null> {
  // 1. Load current job state
  const current = await this.db.query(`
    SELECT * FROM job_queue WHERE id = $1
  `, [params.id]);

  const row = current.rows[0];
  if (!row) return null;

  const attempts = row.attempts ?? 0;
  const maxAttempts = row.max_attempts ?? 5;
  const now = new Date();
  const updatedAt = now.toISOString();

  // 2. Check if this is a poison pill (max attempts exceeded)
  if (attempts >= maxAttempts) {
    // Terminal failure - mark as failed permanently
    const result = await this.db.query(`
      UPDATE job_queue
      SET state = 'failed',
          attempts = $1,
          error = $2,
          updated_at = $3
      WHERE id = $4
        AND lease_token = $5
      RETURNING *
    `, [attempts, params.error, updatedAt, params.id, params.leaseToken]);

    if (!result.rows[0]) return null;

    const failedJob = fromRow(result.rows[0]);
    logger.error('Job failed permanently', {
      jobId: failedJob.id,
      queue: failedJob.queue,
      error: params.error,
    });

    emitQueueTelemetry({
      event: 'error',
      taskId: failedJob.id,
      errorMessage: params.error,
      metadata: { attempts, terminal: true },
    });

    return failedJob;
  }

  // 3. Calculate backoff and schedule retry
  const backoff = this.retryPolicy(attempts);
  const runAt = new Date(now.getTime() + backoff).toISOString();

  const result = await this.db.query(`
    UPDATE job_queue
    SET state = 'queued',           -- Back to queue
        attempts = $1,
        backoff_ms = $2,
        run_at = $3,                -- Scheduled in future
        error = $4,                 -- Store error message
        leased_until = NULL,        -- Release lease
        lease_token = NULL,
        updated_at = $5
    WHERE id = $6
      AND lease_token = $7
    RETURNING *
  `, [
    attempts,
    backoff,
    runAt,
    params.error,
    updatedAt,
    params.id,
    params.leaseToken,
  ]);

  if (!result.rows[0]) return null;

  const retriedJob = fromRow(result.rows[0]);
  logger.warn('Job failed; retry scheduled', {
    jobId: retriedJob.id,
    queue: retriedJob.queue,
    attempts,
    retryAt: runAt,
    backoffMs: backoff,
  });

  emitQueueTelemetry({
    event: 'error',
    taskId: retriedJob.id,
    errorMessage: params.error,
    metadata: { attempts, retryAt: runAt },
  });

  return retriedJob;
}
```

### Retry Policy (Exponential Backoff)

```typescript
retryPolicy(attempts: number): number {
  const base = 1000;              // 1 second
  const cap = 5 * 60 * 1000;      // 5 minutes max
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempts));
  const jitter = Math.floor(exp * (0.2 + Math.random() * 0.3));
  return Math.min(cap, Math.max(base, jitter));
}
```

**Backoff Schedule**:
```
Attempt 1: 1000ms  * (0.2-0.5 jitter) = 200-500ms    (immediate retry)
Attempt 2: 2000ms  * (0.2-0.5 jitter) = 400-1000ms
Attempt 3: 4000ms  * (0.2-0.5 jitter) = 800-2000ms
Attempt 4: 8000ms  * (0.2-0.5 jitter) = 1600-4000ms
Attempt 5: 16000ms * (0.2-0.5 jitter) = 3200-8000ms
Attempt 6: (max attempts exceeded) → FAILED permanently
```

**Why Jitter?**: Prevents thundering herd (many jobs retrying at same instant)

## Administrative Operations

### Expire Leases

**Goal**: Recover jobs from crashed workers

```typescript
async function expireLeases(nowIso?: string): Promise<number> {
  const now = nowIso ?? new Date().toISOString();

  const result = await this.db.query(`
    WITH cte AS (
      SELECT id FROM job_queue
      WHERE state = 'running'
        AND leased_until IS NOT NULL
        AND leased_until <= $1       -- Lease expired
    ),
    upd AS (
      UPDATE job_queue
      SET state = 'queued',           -- Back to queue
          lease_token = NULL,
          leased_until = NULL,
          updated_at = $1
      WHERE id IN (SELECT id FROM cte)
      RETURNING 1
    )
    SELECT COUNT(*)::text as count FROM upd
  `, [now]);

  const released = Number(result.rows[0]?.count ?? 0);
  if (released > 0) {
    logger.warn('Expired job leases', { count: released });
  }

  return released;
}
```

**Run periodically** (e.g., every 60 seconds) to auto-recover stuck jobs.

### Prune Old Jobs

**Goal**: Delete historical jobs to prevent table bloat

```typescript
async function prune(states: JobState[], olderThanIso: string): Promise<number> {
  const placeholders = states.map((_, i) => `$${i + 2}`).join(',');

  const result = await this.db.query(`
    WITH del AS (
      DELETE FROM job_queue
      WHERE updated_at < $1
        AND state IN (${placeholders})
      RETURNING 1
    )
    SELECT COUNT(*)::text as count FROM del
  `, [olderThanIso, ...states]);

  const removed = Number(result.rows[0]?.count ?? 0);
  if (removed > 0) {
    logger.info('Pruned historical jobs', {
      count: removed,
      states,
      olderThanIso,
    });
  }

  return removed;
}
```

**Example Usage**:
```typescript
// Delete succeeded jobs older than 7 days
await jobQueue.prune(['succeeded'], sevenDaysAgo);

// Delete failed jobs older than 30 days
await jobQueue.prune(['failed'], thirtyDaysAgo);
```

### Queue Statistics

**Goal**: Observability dashboard

```typescript
async function getQueueStats(queue?: string): Promise<QueueStats[]> {
  // 1. Get counts by state
  const counts = await this.getCountsByState(queue);

  // 2. Get next runnable timestamp per queue
  const result = await this.db.query(`
    SELECT queue, MIN(run_at) as run_at
    FROM job_queue
    WHERE state = 'queued' ${queue ? 'AND queue = $1' : ''}
    GROUP BY queue
  `, queue ? [queue] : []);

  const minRunAt = new Map<string, string>();
  for (const row of result.rows) {
    minRunAt.set(row.queue, row.run_at);
  }

  // 3. Aggregate stats
  const queues = new Map<string, QueueCounts>();
  for (const c of counts) {
    const entry = queues.get(c.queue) ?? {
      queued: 0,
      running: 0,
      failed: 0,
      succeeded: 0,
    };
    if (c.state === 'queued') entry.queued += c.count;
    if (c.state === 'running') entry.running += c.count;
    if (c.state === 'failed') entry.failed += c.count;
    if (c.state === 'succeeded') entry.succeeded += c.count;
    queues.set(c.queue, entry);
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
```

**Example Output**:
```json
[
  {
    "queue": "embeddings",
    "queued": 1234,
    "running": 4,
    "failed": 12,
    "succeeded": 5678,
    "nextRunnableAt": "2025-01-15T10:30:00.000Z"
  }
]
```

## Worker Integration

### Worker Main Loop

```typescript
async function workerLoop() {
  while (running) {
    try {
      // 1. Claim next job
      const job = await jobQueue.claim({
        queue: 'embeddings',
        leaseMs: 60_000,
        workerId,
      });

      if (!job) {
        await sleep(400); // No work, back off
        continue;
      }

      // 2. Process job
      await handleJob(job);

    } catch (error) {
      logger.error('Worker loop error', { error });
      await sleep(1000); // Brief pause on error
    }
  }
}

async function handleJob(job: Job) {
  const leaseToken = job.lease_token as string;

  // Start heartbeat
  const heartbeat = setInterval(() => {
    jobQueue.heartbeat({
      id: job.id,
      leaseToken,
      extendMs: 60_000,
    }).catch(err =>
      logger.error('Heartbeat failed', { jobId: job.id, error: err })
    );
  }, 10_000);

  try {
    // Execute job logic
    await executeJob(job);

    // Mark complete
    await jobQueue.complete({ id: job.id, leaseToken });

  } catch (error) {
    // Mark failed (will retry)
    await jobQueue.fail({
      id: job.id,
      leaseToken,
      error: error.message.slice(0, 4000), // Truncate
    });
  } finally {
    clearInterval(heartbeat);
  }
}
```

### Concurrency Control

```typescript
async function startWorker(concurrency = 4) {
  const loops: Promise<void>[] = [];

  // Start N parallel loops
  for (let i = 0; i < concurrency; i++) {
    loops.push(workerLoop());
  }

  return {
    stop: async () => {
      running = false;
      await Promise.allSettled(loops);
    },
  };
}
```

## Telemetry & Observability

### Queue Telemetry Events

```typescript
type QueueTelemetryEvent =
  | { event: 'enqueue'; taskId: string; metadata: { queue: string; jobType: string } }
  | { event: 'complete'; taskId: string; elapsedMs: number; metadata: { queue: string } }
  | { event: 'error'; taskId: string; errorMessage: string; metadata: { attempts: number } };

function emitQueueTelemetry(event: QueueTelemetryEvent) {
  // Send to analytics, logging, monitoring
  // e.g., Datadog, Prometheus, CloudWatch
  logger.info('queue_telemetry', event);
}
```

### Worker Metrics

```typescript
const metrics = {
  startedAt: Date.now(),
  jobsProcessed: 0,
  jobsFailed: 0,
  totalDurationMs: 0,
};

// Log metrics every 30 seconds
setInterval(() => {
  const uptimeMs = Date.now() - metrics.startedAt;
  const avgMs = metrics.jobsProcessed > 0
    ? metrics.totalDurationMs / metrics.jobsProcessed
    : 0;

  logger.info('worker_metrics', {
    uptimeMs,
    processed: metrics.jobsProcessed,
    failed: metrics.jobsFailed,
    avgDurationMs: Math.round(avgMs),
    concurrency,
    queue: queueName,
  });
}, 30_000);
```

## Visual Suggestion for Infographic

**Recommended Layout**:
- **Top**: Job lifecycle state machine (queued → running → succeeded/failed)
- **Middle Left**: Enqueue operation (with CTE visualization)
- **Middle Right**: Claim operation (with atomic update)
- **Bottom**: Worker loop with heartbeat mechanism

**Key Visual Elements**:
- State transition diagram (FSM)
- Database table representation (job_queue schema)
- Lease token as "lock" icon
- Heartbeat as "pulse" waves
- Retry backoff as exponential curve
- Worker concurrency as parallel processing lanes

**Complexity to Emphasize**:
- Atomic operations (CTE for idempotent enqueue)
- Lease-based locking (prevents double-processing)
- Heartbeat mechanism (prevents job timeout)
- Retry policy (exponential backoff with jitter)
- Poison pill detection (max attempts exceeded)
- Expired lease recovery (stuck worker handling)

**Code Snippets to Highlight**:
- CTE for idempotent enqueue
- Claim query with re-check conditions
- Retry policy calculation
- Worker loop structure

This job queue provides reliability, observability, and scalability for background processing in BrainStrike.
