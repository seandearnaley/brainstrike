# Infographic Design Brief: Job Queue State Machine & Lease-Based Processing

## Context & Purpose

This infographic should visualize the sophisticated job queue system that powers BrainStrike's background task processing, with a focus on the **database-native architecture**, **lease-based distributed locking**, and the **state machine** that governs job lifecycle. This is a critical system that prevents duplicate work, enables retries with exponential backoff, and handles worker crashes gracefully.

The target audience includes distributed systems engineers, backend developers, and technical leads who need to understand how BrainStrike achieves reliable background processing using only a SQL database (no Redis, RabbitMQ, or external queue services).

## System Overview

BrainStrike's job queue is **entirely database-native**, using PGlite (browser-local PostgreSQL) as both the persistence layer and the coordination mechanism for distributed workers. This design choice enables:

1. **Zero external dependencies**: No Redis, RabbitMQ, AWS SQS, etc.
2. **ACID guarantees**: All queue operations are transactional
3. **Cross-platform compatibility**: Works in browser, Electron, and Node.js
4. **Automatic persistence**: Queue survives app restarts
5. **SQL introspection**: Debug queue state with simple SELECT queries

**Key Design Pattern**: **Lease-Based Claiming with CTE Atomicity**

## The Job State Machine

### State Diagram

```
         ┌─────────┐
         │ ENQUEUE │
         └────┬────┘
              ↓
         ┌─────────┐
    ┌────│  queued │◄────┐
    │    └────┬────┘     │
    │         │          │
    │    [claim()]       │
    │         ↓          │
    │    ┌─────────┐    │ [fail() + attempts < max]
    │    │ running │────┤  (exponential backoff)
    │    └────┬────┘    │
    │         │         │
    │    [complete()]   │
    │    or [fail()]    │
    │         │         │
    ├─────────┼─────────┤
    ↓         ↓         ↓
┌─────────┐┌─────────┐┌────────┐
│succeeded││ failed  ││ expired│
└─────────┘└─────────┘└────────┘
     │          │          │
     └──────[prune()]──────┘
              ↓
          (deleted)
```

### State Definitions

1. **`queued`**: Job is waiting to be processed
   - Waiting for `run_at` timestamp to pass
   - Not currently held by any worker
   - Can transition to: `running` (claim), `expired` (lease timeout)

2. **`running`**: Job is actively being processed by a worker
   - Has a valid `lease_token` and `leased_until` timestamp
   - Worker sends periodic heartbeats to extend lease
   - Can transition to: `succeeded` (complete), `queued` (retry after failure), `failed` (max attempts reached), `expired` (lease timeout)

3. **`succeeded`**: Job completed successfully
   - Terminal state (no further transitions)
   - Eligible for pruning after retention period

4. **`failed`**: Job permanently failed after max attempts
   - Terminal state (unless manually requeued)
   - Error message stored for debugging
   - Can be manually transitioned to: `queued` (via `requeueFailed()`)

5. **`canceled`**: Job manually canceled by user
   - Terminal state (reserved for future use)

6. **`expired`**: Job lease expired without heartbeat
   - Worker likely crashed or became unresponsive
   - Automatically released back to `queued` by `expireLeases()`

## Database Schema (from Migration 007)

```sql
CREATE TABLE job_queue (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,                    -- Queue name (e.g., 'embeddings')
  job_type TEXT NOT NULL,                 -- Job type (e.g., 'embed_chunk')
  payload JSONB,                          -- Task-specific data

  -- State machine
  state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','canceled','expired'))
        DEFAULT 'queued',

  -- Scheduling
  run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- When job becomes eligible
  attempts INTEGER NOT NULL DEFAULT 0,               -- Incremented on each claim
  max_attempts INTEGER NOT NULL DEFAULT 5,           -- Poison pill threshold
  backoff_ms INTEGER NOT NULL DEFAULT 0,             -- Computed backoff duration

  -- Lease-based locking
  lease_token TEXT,                       -- Unique token for claiming worker
  leased_until TEXT,                      -- Lease expiration timestamp
  worker_id TEXT,                         -- Optional worker identifier

  -- Idempotency
  dedupe_key TEXT,                        -- User-defined deduplication key

  error TEXT,                             -- Last error message (truncated to 4KB)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CRITICAL: Partial unique index for active deduplication
CREATE UNIQUE INDEX idx_job_queue_dedupe_active
  ON job_queue(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');

-- Composite index for fast claiming
CREATE INDEX idx_job_queue_scheduling ON job_queue(queue, state, run_at);

-- Index for lease expiration cleanup
CREATE INDEX idx_job_queue_lease ON job_queue(state, leased_until);
```

### Schema Design Rationale

**Why TEXT timestamps instead of TIMESTAMP?**
- **Portability**: ISO strings work identically in browser, Node.js, and Electron
- **Serialization**: No timezone conversion issues when crossing process boundaries
- **Parsing**: `Date.parse('2025-01-22T10:30:45.123Z')` works universally

**Why partial unique index on dedupe_key?**
```sql
CREATE UNIQUE INDEX ... WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');
```
- Allows same `dedupe_key` to exist in `succeeded`, `failed`, `canceled` states
- Prevents duplicate **active** jobs only
- Enables job history tracking with same dedupe key

**Example**:
```
dedupe_key='chunk1:set1:hash123', state='queued'   ← UNIQUE
dedupe_key='chunk1:set1:hash123', state='succeeded' ← ALLOWED (historical)
dedupe_key='chunk1:set1:hash123', state='queued'   ← REJECTED (duplicate active)
```

## Core Operations (CTE-Based Atomicity)

### 1. Enqueue (Idempotent)

**Goal**: Add job to queue, or return existing job if already enqueued.

```typescript
async enqueue(params: EnqueueParams): Promise<Job> {
  const id = generateUUID();
  const now = new Date().toISOString();
  const runAt = params.runAt ?? now;
  const maxAttempts = params.maxAttempts ?? 5;
  const dedupeKey = params.dedupeKey ?? null;

  const result = await db.query(`
    WITH existing AS (
      SELECT * FROM job_queue
       WHERE dedupe_key = $7 AND state IN ('queued','running')
       LIMIT 1
    ),
    upd AS (
      UPDATE job_queue
         SET run_at = LEAST(run_at, $5),  -- Move earlier if possible
             updated_at = GREATEST(updated_at, $8)
       WHERE id IN (SELECT id FROM existing)
      RETURNING *
    ),
    ins AS (
      INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, ...)
      SELECT $1,$2,$3,$4,'queued',$5,...
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING *
    )
    SELECT * FROM upd UNION ALL SELECT * FROM ins LIMIT 1
  `, [id, queue, jobType, payload, runAt, maxAttempts, dedupeKey, now]);

  return fromRow(result.rows[0]);
}
```

**CTE Breakdown**:
1. **`existing`**: Check if job with same dedupe_key is already active
2. **`upd`**: If exists, update `run_at` to earlier timestamp (graceful re-enqueue)
3. **`ins`**: If doesn't exist, insert new job
4. **`UNION ALL`**: Return either updated or inserted row

**Why LEAST(run_at, $5)?**
- If job is re-enqueued with earlier `run_at`, move it forward in the queue
- Prevents backlog buildup from repeated enqueues

**Idempotency Guarantee**:
- Calling `enqueue()` 10 times with same `dedupeKey` → Only 1 active job
- Subsequent calls return the same job ID

### 2. Claim (Atomic Lease-Based Locking)

**Goal**: Atomically select and lock the next runnable job.

```typescript
async claim(params: ClaimParams): Promise<Job | null> {
  const now = params.now ?? new Date().toISOString();
  const leaseToken = generateUUID(); // Unique token for this claim
  const leasedUntil = new Date(Date.now() + params.leaseMs).toISOString();

  const result = await db.query(`
    WITH candidate AS (
      SELECT id
        FROM job_queue
       WHERE queue = $1
         AND attempts < max_attempts
         AND (
               (state = 'queued'  AND run_at <= $2)      -- Scheduled job ready
            OR (state = 'running' AND (leased_until IS NULL OR leased_until <= $2)) -- Expired lease
             )
       ORDER BY run_at ASC, id ASC
       LIMIT 1
    )
    UPDATE job_queue AS j SET
      state = 'running',
      attempts = j.attempts + 1,    -- Increment on claim (pre-increment)
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
    RETURNING j.*
  `, [queue, now, leaseToken, leasedUntil, workerId, now]);

  if (!result.rows[0]) return null; // No jobs available
  return fromRow(result.rows[0]);
}
```

**CTE Breakdown**:
1. **`candidate`**: SELECT next runnable job with `ORDER BY run_at ASC`
   - Picks oldest job first (FIFO within same `run_at`)
   - Checks `attempts < max_attempts` (don't claim poison pills)
   - Allows re-claiming expired running jobs (zombie worker recovery)

2. **`UPDATE ... FROM candidate`**: Atomically lock the selected job
   - Re-checks conditions in WHERE clause (prevents TOCTOU races)
   - Increments `attempts` counter
   - Sets `lease_token` and `leased_until`
   - Transitions state to `running`

**Why Re-Check Conditions in UPDATE?**
```sql
WHERE j.id = c.id
  AND j.attempts < j.max_attempts
  AND (...)
```
- **TOCTOU Protection**: Prevents race condition where two workers select the same candidate
- Even if two workers run the SELECT simultaneously, only ONE will successfully UPDATE
- The other worker's UPDATE will return 0 rows (no match on WHERE clause)

**Claim Race Example**:
```
Worker A: SELECT id FROM job_queue ... LIMIT 1  → job_123
Worker B: SELECT id FROM job_queue ... LIMIT 1  → job_123 (same!)

Worker A: UPDATE job_queue SET lease_token='uuid-a' WHERE id='job_123' AND state='queued'
          → SUCCESS (1 row updated)

Worker B: UPDATE job_queue SET lease_token='uuid-b' WHERE id='job_123' AND state='queued'
          → FAILURE (0 rows, job is now 'running')

Worker A processes job_123
Worker B calls claim() again, gets job_124
```

**Lease Mechanism**:
```
leaseMs = 60000 (60 seconds)
leasedUntil = now + 60000ms = '2025-01-22T10:31:00Z'

Worker must:
  - Complete job before lease expires, OR
  - Send heartbeats to extend lease
```

### 3. Heartbeat (Extend Lease)

**Goal**: Keep lease alive while processing long-running job.

```typescript
async heartbeat(params: HeartbeatParams): Promise<Job | null> {
  const newLease = new Date(Date.now() + params.extendMs).toISOString();
  const updatedAt = new Date().toISOString();

  const result = await db.query(`
    UPDATE job_queue
       SET leased_until = $1, updated_at = $2
     WHERE id = $3 AND lease_token = $4 AND state = 'running'
    RETURNING *
  `, [newLease, updatedAt, id, leaseToken]);

  if (!result.rows[0]) return null; // Lease no longer valid
  return fromRow(result.rows[0]);
}
```

**Validation**:
- `WHERE lease_token = $4`: Only the owning worker can extend the lease
- `AND state = 'running'`: Job must still be running (not completed by another process)

**Heartbeat Interval Strategy**:
```typescript
const leaseMs = 60000;             // 60s lease
const heartbeatIntervalMs = 10000; // 10s heartbeat

// Send heartbeat every 10s → lease never expires during normal operation
setInterval(() => {
  jq.heartbeat({ id, leaseToken, extendMs: 60000 });
}, 10000);
```

**Why Fire-and-Forget?**
```typescript
jq.heartbeat(...).catch(err => log('heartbeat_error', { err }));
```
- Heartbeat failures are non-fatal (lease will eventually expire)
- Worker should continue processing; lease expiration will handle cleanup

### 4. Complete (Success)

**Goal**: Mark job as successfully completed.

```typescript
async complete(params: CompleteParams): Promise<Job | null> {
  const updatedAt = new Date().toISOString();

  const result = await db.query(`
    UPDATE job_queue
       SET state = 'succeeded',
           leased_until = NULL,
           updated_at = $1
     WHERE id = $2 AND lease_token = $3 AND state = 'running'
    RETURNING *
  `, [updatedAt, id, leaseToken]);

  if (!result.rows[0]) return null;
  return fromRow(result.rows[0]);
}
```

**Validation**:
- `WHERE lease_token = $3`: Only the owning worker can complete
- `AND state = 'running'`: Prevents double-completion

### 5. Fail (Retry or Poison Pill)

**Goal**: Handle job failure with exponential backoff retry logic.

```typescript
async fail(params: FailParams): Promise<Job | null> {
  // 1. Load current job state
  const current = await db.query('SELECT * FROM job_queue WHERE id = $1', [id]);
  const row = current.rows[0];
  const attempts = row.attempts; // Already incremented by claim()

  // 2. Check if max attempts reached
  if (attempts >= row.max_attempts) {
    // POISON PILL: Mark as permanently failed
    await db.query(`
      UPDATE job_queue
         SET state = 'failed',
             attempts = $1,
             error = $2,
             updated_at = $3
       WHERE id = $4 AND lease_token = $5
      RETURNING *
    `, [attempts, error, now, id, leaseToken]);
    return fromRow(result.rows[0]);
  }

  // 3. Compute exponential backoff
  const backoff = this.retryPolicy(attempts);
  const runAt = new Date(Date.now() + backoff).toISOString();

  // 4. Requeue with backoff
  await db.query(`
    UPDATE job_queue
       SET state = 'queued',
           attempts = $1,
           backoff_ms = $2,
           run_at = $3,           -- Future timestamp
           error = $4,
           leased_until = NULL,   -- Release lease
           lease_token = NULL,
           updated_at = $5
     WHERE id = $6 AND lease_token = $7
    RETURNING *
  `, [attempts, backoff, runAt, error, now, id, leaseToken]);
}
```

**Retry Policy (Exponential Backoff with Jitter)**:
```typescript
retryPolicy(attempts: number): number {
  const base = 1000;             // 1s
  const cap = 5 * 60 * 1000;     // 5min
  const exp = Math.min(cap, base * 2 ** attempts); // 2^n exponential
  const jitter = Math.floor(exp * (0.2 + Math.random() * 0.3)); // 20-50% jitter
  return Math.min(cap, Math.max(base, jitter));
}
```

**Backoff Schedule**:
```
Attempt 1: 0ms → claim immediately (attempt 0 → no backoff)
Attempt 2: ~1s ± jitter (base * 2^1 = 2s → jitter → ~1s)
Attempt 3: ~4s ± jitter (base * 2^2 = 4s)
Attempt 4: ~8s ± jitter (base * 2^3 = 8s)
Attempt 5: ~16s ± jitter (base * 2^4 = 16s)
Attempt 6: POISON PILL (max_attempts=5 reached)
```

**Why Jitter?**
- Prevents **thundering herd** problem
- If 1000 jobs fail simultaneously, they won't all retry at the exact same moment
- Jitter spreads retries over time

**Poison Pill Pattern**:
```
attempts >= max_attempts → state = 'failed' (terminal)
```
- Prevents infinite retry loops
- Admin can manually `requeueFailed()` if needed

### 6. Expire Leases (Zombie Worker Cleanup)

**Goal**: Release jobs held by crashed/unresponsive workers.

```typescript
async expireLeases(nowIso?: string): Promise<number> {
  const now = nowIso ?? new Date().toISOString();

  const result = await db.query(`
    WITH cte AS (
      SELECT id FROM job_queue
       WHERE state = 'running'
         AND leased_until IS NOT NULL
         AND leased_until <= $1  -- Lease expired
    ),
    upd AS (
      UPDATE job_queue
         SET state = 'queued',
             lease_token = NULL,
             leased_until = NULL,
             updated_at = $1
       WHERE id IN (SELECT id FROM cte)
      RETURNING 1
    )
    SELECT COUNT(*) as count FROM upd
  `, [now]);

  const released = Number(result.rows[0].count);
  if (released > 0) {
    logger.warn('Expired job leases', { count: released });
  }
  return released;
}
```

**When to Run**:
```typescript
// Periodic background task (every 30s)
setInterval(() => {
  jq.expireLeases();
}, 30000);
```

**Effect**:
- Jobs transition: `running` → `queued`
- `run_at` remains unchanged (eligible immediately)
- **Does NOT increment attempts** (attempt counter tracks claims, not expirations)

**Example Scenario**:
```
Worker A claims job_123 at 10:00:00
Worker A crashes at 10:00:30 (no heartbeat sent)
Lease expires at 10:01:00 (60s lease)
Periodic expiry task runs at 10:01:15
  → job_123 transitions to 'queued'
Worker B claims job_123 at 10:01:16
  → attempts incremented from 1 to 2
```

### 7. Prune (Delete Old Jobs)

**Goal**: Delete historical jobs to prevent unbounded growth.

```typescript
async prune(states: JobState[], olderThanIso: string): Promise<number> {
  const result = await db.query(`
    WITH del AS (
      DELETE FROM job_queue
       WHERE updated_at < $1
         AND state IN (${placeholders}) -- ['succeeded', 'failed']
      RETURNING 1
    )
    SELECT COUNT(*) as count FROM del
  `, [olderThanIso, ...states]);

  return Number(result.rows[0].count);
}
```

**Example Usage**:
```typescript
// Delete succeeded jobs older than 7 days
const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
await jq.prune(['succeeded'], sevenDaysAgo);

// Delete failed jobs older than 30 days
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
await jq.prune(['failed'], thirtyDaysAgo);
```

## Advanced Patterns

### Requeue Failed Jobs (Manual Intervention)

```typescript
async requeueFailed(queue?: string, limit = 20): Promise<number> {
  const now = new Date().toISOString();

  const result = await db.query(`
    WITH cte AS (
      SELECT id FROM job_queue
       WHERE state = 'failed'
         ${queue ? 'AND queue = $3' : ''}
       ORDER BY updated_at DESC
       LIMIT $2
    ),
    upd AS (
      UPDATE job_queue
         SET state = 'queued',
             run_at = $1,      -- Run immediately
             backoff_ms = 0,   -- Reset backoff
             leased_until = NULL,
             lease_token = NULL,
             error = NULL,     -- Clear error
             updated_at = $1
       WHERE id IN (SELECT id FROM cte)
      RETURNING 1
    )
    SELECT COUNT(*) as count FROM upd
  `, [now, limit, queue]);

  return Number(result.rows[0].count);
}
```

**Use Case**: Admin UI to retry failed jobs after fixing underlying issue (e.g., API key added).

### Queue Statistics (Dashboard Queries)

```typescript
async getQueueStats(queue?: string): Promise<{
  queue: string;
  queued: number;
  running: number;
  failed: number;
  succeeded: number;
  nextRunnableAt: string | null;
}[]> {
  // 1. Count by state
  const counts = await db.query(`
    SELECT queue, state, COUNT(*) as count
      FROM job_queue
     ${queue ? 'WHERE queue = $1' : ''}
     GROUP BY queue, state
  `);

  // 2. Find next runnable timestamp
  const minRunAt = await db.query(`
    SELECT queue, MIN(run_at) as run_at
      FROM job_queue
     WHERE state = 'queued' ${queue ? 'AND queue = $1' : ''}
     GROUP BY queue
  `);

  // Combine results...
}
```

**Powers UI Dashboard**:
- "23 queued, 4 running, 156 succeeded, 2 failed"
- "Next job runs at 10:32:45"

## Index Strategy & Performance

### Critical Indexes

**1. Scheduling Index (Composite)**:
```sql
CREATE INDEX idx_job_queue_scheduling ON job_queue(queue, state, run_at);
```
Enables fast claim query:
```sql
SELECT id FROM job_queue
 WHERE queue = 'embeddings' AND state = 'queued' AND run_at <= NOW()
 ORDER BY run_at ASC LIMIT 1;
```

**2. Deduplication Index (Partial Unique)**:
```sql
CREATE UNIQUE INDEX idx_job_queue_dedupe_active
  ON job_queue(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');
```
Enforces idempotency without blocking historical records.

**3. Lease Expiration Index**:
```sql
CREATE INDEX idx_job_queue_lease ON job_queue(state, leased_until);
```
Enables fast `expireLeases()`:
```sql
SELECT id FROM job_queue
 WHERE state = 'running' AND leased_until <= NOW();
```

## Key Files for Reference

- **Queue Implementation**: `/packages/db/src/queue/job-queue.ts` (line 102-555)
- **Migration**: `/packages/db/src/migrations/007-job-queue.ts`
- **Worker Integration**: `/packages/embeddings/src/worker/embedding-worker.ts` (line 811-832)

## Visual Design Suggestions (Non-Prescriptive)

- **State Machine Diagram**: Nodes for each state, arrows for transitions with labels (claim, complete, fail, expire)
- **Claim Race Visualization**: Timeline showing two workers racing to claim the same job
- **Lease Lifecycle**: Timeline showing claim → heartbeats → complete/expire
- **Exponential Backoff Chart**: X-axis=attempts, Y-axis=backoff duration with jitter band
- **CTE Query Flow**: Animated visualization of CTE execution (existing → upd → ins → UNION)
- **Partial Unique Index**: Venn diagram showing dedupe_key uniqueness constraint scope
- **Zombie Recovery**: Sequence diagram showing worker crash → lease expiry → re-claim
- **Throughput vs. Latency**: Scatter plot of job processing times with p50/p95 markers

## Technical Depth

The designer should understand:
- **CTE (Common Table Expressions)** for atomic multi-step operations
- **Lease-based distributed locking** (time-based claims)
- **Partial unique indexes** (conditional uniqueness)
- **Exponential backoff** with jitter for retry stability
- **TOCTOU (Time-of-Check-Time-of-Use)** race conditions and mitigation
- **Poison pill pattern** for terminal failures
- **Idempotency** via deduplication keys
- **Heartbeat mechanisms** for long-running tasks

## Success Criteria

After viewing this infographic, a developer should be able to:
1. Explain how lease-based claiming prevents duplicate job processing
2. Trace the path of a job through all state transitions
3. Understand why CTE queries are atomic despite multiple sub-queries
4. Identify when exponential backoff triggers and how it scales
5. Recognize the purpose of each index and the queries it optimizes
6. Explain how zombie worker cleanup works without losing jobs
7. Understand the trade-offs of database-native queuing vs. external queue services

---

**Schema Complexity**: 1 table, 3 specialized indexes, 6 states, 4 core operations
**Atomicity Mechanism**: CTE-based queries with re-checks in WHERE clauses
**Performance**: 100-500 jobs/sec claim rate (depending on database load)
**Reliability**: Zero data loss, automatic recovery from worker crashes
