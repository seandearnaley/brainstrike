# ADR-0002: Queue Boundaries — Durable Jobs vs Ephemeral Compute

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **Status**  | Accepted                                   |
| **Date**    | 2026-01-04                                 |
| **Authors** | BrainStrike Team                           |
| **Epic**    | BST-135 (Queue & Worker Consolidation)     |
| **Ticket**  | BST-162                                    |

## Context

### Current State

BrainStrike has multiple queue-like systems that evolved independently:

| System | Location | Purpose | Durability |
|--------|----------|---------|------------|
| **DB JobQueue** | `packages/db/src/queue/job-queue.ts` | Durable job scheduling | SQL-backed, survives refresh |
| **Browser Workerpool** | `packages/queue/src/adapters/browser-workerpool.ts` | CPU-bound compute | In-memory, lost on refresh |
| **Ad-hoc Workers** | Various packages | One-off worker scheduling | Varies |

### Problem Statement

1. **Inconsistent Semantics**: DB JobQueue and Workerpool have different pause/resume/cancel APIs
2. **Divergent Telemetry**: Each system emits events with different schemas and adapters
3. **Unclear Boundaries**: Developers don't know when to use which system
4. **Monitoring Gaps**: No unified view of queue health across subsystems

### Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CURRENT QUEUE ARCHITECTURE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────┐    ┌────────────────────────────┐           │
│  │     DB JobQueue            │    │    Browser Workerpool      │           │
│  │                            │    │                            │           │
│  │  • SQL-backed state        │    │  • In-memory pool          │           │
│  │  • Lease-based claims      │    │  • workerpool library      │           │
│  │  • Retry with backoff      │    │  • AbortSignal cancel      │           │
│  │  • No pause/resume         │    │  • pause()/resume()        │           │
│  │                            │    │                            │           │
│  │  States:                   │    │  States:                   │           │
│  │   queued → running →       │    │   (implicit: pending,      │           │
│  │   succeeded/failed/        │    │    running, complete)      │           │
│  │   canceled/expired         │    │                            │           │
│  └────────────────────────────┘    └────────────────────────────┘           │
│              │                                  │                           │
│              ▼                                  ▼                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     TELEMETRY (divergent)                            │    │
│  │                                                                      │    │
│  │  DB JobQueue:           Workerpool:                                  │    │
│  │   adapter: 'custom'      adapter: 'workerpool'                       │    │
│  │   events: enqueue,       events: enqueue, complete, error            │    │
│  │           complete,      metadata: { pendingTasks }                  │    │
│  │           error          activeBefore/activeAfter                    │    │
│  │   metadata: { queue,                                                 │    │
│  │     jobType, dedupeKey }                                             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Pain Points

| Issue | Impact |
|-------|--------|
| **No shared cancel semantics** | JobQueue uses state transitions; Workerpool uses AbortSignal |
| **Pause not supported in JobQueue** | Cannot pause durable jobs without custom implementation |
| **Telemetry schema divergence** | Cannot aggregate metrics across systems |
| **Worker client patterns vary** | Each worker has different ready/timeout/error handling |

## Decision

We establish **clear boundaries** between durable jobs and ephemeral compute, with standardized interfaces for common operations.

### Queue Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         QUEUE MENTAL MODEL                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     DURABLE JOBS (DB JobQueue)                       │    │
│  │                                                                      │    │
│  │  Use when:                                                           │    │
│  │   • Work MUST complete (eventually)                                  │    │
│  │   • Work can survive browser refresh                                 │    │
│  │   • Work needs retry semantics                                       │    │
│  │   • Work is idempotent (safe to replay)                              │    │
│  │   • Progress must be recoverable                                     │    │
│  │                                                                      │    │
│  │  Examples:                                                           │    │
│  │   • Embedding generation jobs                                        │    │
│  │   • File import/indexing tasks                                       │    │
│  │   • Vector upsert operations                                         │    │
│  │                                                                      │    │
│  │  Lifecycle: enqueue → claim → [heartbeat]* → complete/fail           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                 EPHEMERAL COMPUTE (Workerpool/Workers)               │    │
│  │                                                                      │    │
│  │  Use when:                                                           │    │
│  │   • Work is CPU-bound and short-lived                                │    │
│  │   • Work can be restarted from scratch                               │    │
│  │   • Work doesn't need persistence                                    │    │
│  │   • Real-time responsiveness matters                                 │    │
│  │                                                                      │    │
│  │  Examples:                                                           │    │
│  │   • Token counting                                                   │    │
│  │   • Text chunking                                                    │    │
│  │   • Hash computation                                                 │    │
│  │   • Local model inference                                            │    │
│  │                                                                      │    │
│  │  Lifecycle: submit → execute → result/error                          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Decision Matrix

| Factor | Durable (JobQueue) | Ephemeral (Workerpool) |
|--------|-------------------|------------------------|
| **Persistence** | SQL-backed | In-memory |
| **Survives Refresh** | Yes | No |
| **Retry Support** | Built-in (exponential backoff) | Manual (re-submit) |
| **Cancel Mechanism** | State transition | AbortSignal |
| **Pause Support** | Via state (to be added) | Built-in |
| **Ordering** | FIFO with priorities | Concurrent pool |
| **Deduplication** | Built-in (dedupe_key) | Manual |
| **Lease/Heartbeat** | Yes | No |
| **Typical Latency** | Higher (SQL overhead) | Lower (in-memory) |
| **Use Case** | Must-complete work | Fast compute |

### Unified Control Semantics

To enable consistent pipeline control, we define standard semantics:

```typescript
/**
 * Unified queue control semantics.
 *
 * Both durable and ephemeral queues should support these operations
 * with consistent behavior.
 */
export interface QueueControl {
  /**
   * Pause accepting new work.
   * - Durable: Stop claiming jobs (existing running jobs continue)
   * - Ephemeral: Block new submissions (existing tasks complete)
   */
  pause(): void;

  /**
   * Resume accepting work after pause.
   */
  resume(): void;

  /**
   * Cancel all pending/running work.
   * - Durable: Transition queued jobs to canceled state
   * - Ephemeral: Cancel via AbortSignal, reject pending
   */
  cancel(): Promise<void>;

  /**
   * Wait for all in-flight work to complete.
   * Does not accept new work during drain.
   */
  drain(): Promise<void>;

  /**
   * Check if queue is paused.
   */
  readonly isPaused: boolean;

  /**
   * Check if queue is actively processing.
   */
  readonly isProcessing: boolean;
}
```

### WorkerClient Base Pattern (BST-165)

To standardize worker lifecycle management across different worker port implementations, we define a base pattern:

```typescript
/**
 * Lifecycle states for worker clients.
 */
export type WorkerClientState = 'initializing' | 'ready' | 'terminated' | 'error';

/**
 * Error types for worker failures.
 */
export type WorkerClientErrorType =
  | 'initialization_timeout'
  | 'worker_error'
  | 'message_timeout'
  | 'terminated';

/**
 * Base interface for worker client lifecycle management.
 *
 * All worker ports (ChunkingWorkerPort, FileTreeWorkerPort, etc.)
 * should implement this interface for consistent behavior.
 */
export interface WorkerClient {
  /** Check if the worker is ready to accept messages */
  isReady(): boolean;

  /** Get the current lifecycle state */
  getState(): WorkerClientState;

  /** Terminate the worker and release resources */
  terminate(): void;
}

/**
 * Extended interface with async ready-waiting support.
 */
export interface WorkerClientWithTimeout extends WorkerClient {
  /**
   * Wait for the worker to become ready.
   *
   * @param timeoutMs - Maximum wait time (default: 30s)
   * @returns true if ready, false if timed out
   */
  waitForReady(timeoutMs?: number): Promise<boolean>;
}
```

The `createWorkerReadyWaiter` utility provides a reusable implementation:

```typescript
import { createWorkerReadyWaiter } from '@brainstrike/queue';

// Create a ready waiter for your worker port
const waitForReady = createWorkerReadyWaiter(
  () => workerState === 'ready',
  { defaultTimeoutMs: 5000 }
);

// Use it in your port implementation
const client: WorkerClientWithTimeout = {
  isReady: () => workerState === 'ready',
  getState: () => workerState,
  terminate: () => worker.terminate(),
  waitForReady,
};
```

### Telemetry Schema (Unified)

```typescript
/**
 * Common telemetry event schema for all queue systems.
 */
export type QueueTelemetryAdapter = 'job-queue' | 'workerpool' | 'custom';

export type QueueTelemetryEvent = {
  /** Event timestamp (ms since epoch) */
  readonly timestamp: number;
  /** Queue system that emitted the event */
  readonly adapter: QueueTelemetryAdapter;
  /** Event type */
  readonly event: 'enqueue' | 'start' | 'complete' | 'error' | 'cancel';
  /** Unique task/job identifier */
  readonly taskId: string;
  /** Model name (for embedding tasks) */
  readonly model?: string;
  /** Execution time in milliseconds */
  readonly elapsedMs?: number;
  /** Error message (for error events) */
  readonly errorMessage?: string;
  /** Queue-specific metadata */
  readonly metadata?: {
    /** Queue name (for JobQueue) */
    queue?: string;
    /** Job type (for JobQueue) */
    jobType?: string;
    /** Dedupe key (for JobQueue) */
    dedupeKey?: string | null;
    /** Pending tasks (for Workerpool) */
    pendingTasks?: number;
    /** Active workers (for Workerpool) */
    activeWorkers?: number;
    /** Retry attempt number */
    attempt?: number;
    /** Whether this is a terminal failure */
    terminal?: boolean;
  };
};
```

### Integration Pattern

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    RECOMMENDED INTEGRATION PATTERN                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                      Pipeline Controller                           │     │
│  │                   (from @brainstrike/pipeline)                     │     │
│  │                                                                    │     │
│  │  Provides: pause/resume/cancel with AbortSignal                    │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                           │                                                 │
│              ┌────────────┴────────────┐                                    │
│              ▼                         ▼                                    │
│  ┌─────────────────────────┐  ┌─────────────────────────┐                   │
│  │    JobQueue Worker      │  │    Workerpool Adapter   │                   │
│  │                         │  │                         │                   │
│  │  • Polls for jobs       │  │  • Executes compute     │                   │
│  │  • Checks AbortSignal   │  │  • Respects pause       │                   │
│  │  • Emits telemetry      │  │  • Emits telemetry      │                   │
│  └─────────────────────────┘  └─────────────────────────┘                   │
│              │                         │                                    │
│              └────────────┬────────────┘                                    │
│                           ▼                                                 │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                   Telemetry Aggregator                             │     │
│  │                                                                    │     │
│  │  • Collects events from all adapters                               │     │
│  │  • Computes unified metrics                                        │     │
│  │  • Feeds diagnostics panel                                         │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Usage Recommendations

#### Scenario 1: Embedding Pipeline

```typescript
// RECOMMENDED: Use JobQueue for durable job tracking
// Use Workerpool for actual embedding compute

// 1. Enqueue to JobQueue (durable record)
const job = await jobQueue.enqueue({
  queue: 'embeddings',
  jobType: 'embed_chunk',
  payload: { chunkId, text, model },
  dedupeKey: buildEmbedJobDedupeKey(chunkId, setId, model),
});

// 2. Worker claims and delegates to Workerpool (ephemeral compute)
const claimedJob = await jobQueue.claim({ queue: 'embeddings', leaseMs: 30000 });
if (claimedJob) {
  const result = await workerpoolAdapter.add({
    kind: 'embed',
    id: claimedJob.id,
    model: claimedJob.payload.model,
    texts: [claimedJob.payload.text],
    // ... other options
  }, { signal: pipelineController.signal });

  await jobQueue.complete({ id: claimedJob.id, leaseToken: claimedJob.lease_token });
}
```

#### Scenario 2: Token Counting (Ephemeral Only)

```typescript
// RECOMMENDED: Use Workerpool directly (no persistence needed)
const result = await workerpoolAdapter.add({
  kind: 'tokenCount', // hypothetical
  id: generateTaskId(),
  text: content,
}, { signal: controller.signal });
```

#### Scenario 3: Pause/Resume Pipeline

```typescript
// Controller manages both durable and ephemeral queues
const controller = createPipelineController({
  onStateChange: (state) => {
    if (state === 'paused') {
      workerpoolAdapter.pause();
      // JobQueue: stop polling (handled by controller.waitIfPaused())
    } else if (state === 'running') {
      workerpoolAdapter.resume();
    }
  },
});
```

## Consequences

### Positive

1. **Clear Mental Model**: Developers know which queue to use for each scenario
2. **Consistent Control**: Unified pause/resume/cancel across systems
3. **Unified Telemetry**: Single schema enables cross-system monitoring
4. **Composable Pipelines**: Controller can coordinate multiple queue types

### Negative

1. **Integration Complexity**: Two-layer approach (JobQueue + Workerpool) adds indirection
2. **Migration Cost**: Existing code may need updates for unified semantics
3. **Documentation Burden**: Must maintain clear guidance

### Neutral

1. **Dual Systems Remain**: We keep both systems (by design, not tech debt)
2. **Adapter Pattern**: Telemetry adapter abstraction adds a layer but enables flexibility

## Implementation Roadmap

| Ticket | Description |
|--------|-------------|
| BST-162 | This ADR: Document queue boundaries |
| BST-163 | Add telemetry for DB JobQueue using unified schema |
| BST-164 | Standardize cancel/pause semantics across adapters |
| BST-165 | Introduce WorkerClient base pattern |
| BST-166 | Centralize queue health metrics in diagnostics panel |

## References

- `packages/db/src/queue/job-queue.ts` — DB JobQueue implementation
- `packages/queue/src/adapters/browser-workerpool.ts` — Workerpool adapter
- `packages/queue/src/telemetry.ts` — Current telemetry implementation
- `packages/pipeline/src/pipeline-controller.ts` — Pipeline pause/resume/cancel
- `packages/vector-management/src/embedding-job-queue-tracker.tsx` — UI integration
- [workerpool library](https://github.com/josdejong/workerpool) — Browser worker pool

## Appendix: State Diagrams

### DB JobQueue States

```
          enqueue
             │
             ▼
        ┌─────────┐
        │ queued  │◄─────────────────────┐
        └────┬────┘                      │
             │ claim                     │ fail (retriable)
             ▼                           │
        ┌─────────┐                      │
        │ running │──────────────────────┘
        └────┬────┘
             │
     ┌───────┼───────┐
     │       │       │
     ▼       ▼       ▼
┌─────────┐ ┌────────┐ ┌──────────┐
│succeeded│ │ failed │ │ canceled │
└─────────┘ └────────┘ └──────────┘
(terminal)  (terminal)  (terminal)
```

### Workerpool Task States

```
        submit
           │
           ▼
      ┌─────────┐
      │ pending │──────────────────┐
      └────┬────┘                  │
           │ execute               │ cancel
           ▼                       │
      ┌─────────┐                  │
      │ running │──────────────────┤
      └────┬────┘                  │
           │                       │
     ┌─────┴─────┐                 │
     │           │                 │
     ▼           ▼                 ▼
┌─────────┐ ┌─────────┐     ┌───────────┐
│complete │ │  error  │     │ cancelled │
└─────────┘ └─────────┘     └───────────┘
```
