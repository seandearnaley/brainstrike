# Infographic Design Brief: Vector Embedding Pipeline Architecture

## Context & Purpose

This infographic should visualize the complete lifecycle of embedding generation in BrainStrike, from provider factory instantiation through worker processing to database storage. This is one of the most complex systems in the codebase, involving factory patterns, worker lifecycle management, job queuing, device selection (WebGPU/WASM/CPU), and multi-provider support (local transformers.js vs. hosted APIs like OpenAI/Google).

The target audience includes ML engineers, full-stack developers, and technical architects who need to understand how vector embeddings are generated, cached, and synchronized across distributed workers.

## System Overview

BrainStrike supports **two embedding runtime types**:

1. **Local (Browser)**: Uses `transformers.js` to run models like Jina-Code, BGE-M3 directly in the browser via WASM or WebGPU
2. **Hosted (API)**: Calls external providers (OpenAI, Google, Cohere, Voyage) via REST APIs

Both runtimes share a common interface but have vastly different initialization, caching, and error handling strategies.

## Core Architectural Patterns

### 1. Factory Pattern with Instance Caching

The `EmbeddingProviderFactory` is a **static factory class** that manages provider lifecycle:

```typescript
export class EmbeddingProviderFactory {
  // Cache: "provider:modelId:variant" → IEmbeddingProvider
  private static instances = new Map<string, IEmbeddingProvider>();

  static async createProvider(
    config: EmbeddingProviderConfig
  ): Promise<Result<IEmbeddingProvider, EmbeddingProviderError>>
}
```

**Cache Key Strategy**:
- Local: `"local:jina-code:default"` or `"local:bge-m3:q4"` (quantization variant)
- OpenAI: `"openai:text-embedding-3-small:1536"` (dimension variant)
- Google: `"google:text-embedding-004:768"` (outputDimensionality variant)
- Cohere: `"cohere:embed-multilingual-v3:search_document"` (inputType variant)

**Why Cache?**
- Local models are 50-500MB WASM binaries that take 5-30 seconds to load
- Hosted providers have connection pooling and rate limit state
- Multiple workers can share the same provider instance

**Cache Invalidation**:
```typescript
// Manual removal (testing, memory pressure)
await EmbeddingProviderFactory.removeProvider('local', 'jina-code', 'default');

// Clear entire cache (app reset, model switching)
await EmbeddingProviderFactory.clearCache(); // Calls dispose() on all instances
```

### 2. Discriminated Union Configuration

The factory uses TypeScript discriminated unions for type-safe provider creation:

```typescript
type EmbeddingProviderConfig =
  | { runtime: 'browser'; provider: 'local'; modelId: string; quantization?: 'q4' | 'q8' }
  | { runtime: 'hosted'; provider: 'openai'; modelId: string; dimensions?: number }
  | { runtime: 'hosted'; provider: 'google'; modelId: string; outputDimensionality?: number }
  | { runtime: 'hosted'; provider: 'cohere'; modelId: string; inputType?: 'search_document' | 'search_query' }
  | { runtime: 'hosted'; provider: 'voyage'; modelId: string; inputType?: 'document' | 'query' };
```

This **prevents invalid configurations** at compile time:
- Can't specify `dimensions` for local providers
- Can't specify `quantization` for hosted providers
- TypeScript enforces exhaustive handling

### 3. Result Pattern for Error Handling

All provider operations return `Result<T, E>` instead of throwing exceptions:

```typescript
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

type EmbeddingProviderError =
  | { type: 'missing_api_key'; provider: 'openai' | 'google' | 'cohere' | 'voyage' }
  | { type: 'api_error'; provider: string; statusCode: number; message: string }
  | { type: 'rate_limit_exceeded'; provider: string }
  | { type: 'model_load_failed'; provider: 'local'; modelId: string; reason: string }
  | { type: 'dimension_mismatch'; expected: number; received: number; modelId: string }
  | { type: 'validation_error'; message: string };
```

**Benefits**:
- Forces explicit error handling at call sites
- No unhandled promise rejections
- Errors are typed and actionable

## The Embedding Worker: Lifecycle & State Management

### Worker Architecture

The `EmbeddingWorker` is a **long-running background process** that:

1. Claims jobs from the database job queue
2. Loads file chunks
3. Generates embeddings (local or hosted)
4. Stores embeddings with content-addressable hashes
5. Marks jobs complete or failed

```typescript
export async function startEmbeddingWorker(
  options: EmbeddingWorkerOptions
): Promise<EmbeddingWorkerController> {
  // Returns { stop: () => Promise<void> }
}

type EmbeddingWorkerOptions = {
  db: IDatabase;
  queue?: string;                   // default: 'embeddings'
  concurrency?: number;              // default: 1 (up to 4)
  leaseMs?: number;                  // default: 60000 (60s)
  heartbeatIntervalMs?: number;      // default: 10000 (10s)
  modelKey?: string;                 // default: registry default
  distance?: 'cosine' | 'l2' | 'ip'; // default: 'cosine'
  device?: 'webgpu' | 'wasm' | 'cpu';// preferred device
  reinitEveryN?: number;             // reinit every N successes (default 200)
  forceCpuAfterFailures?: number;    // fallback to CPU after N failures (default 3)
};
```

### Worker Initialization Flow

**Step 1: Model Resolution**
```typescript
const modelResolution = resolveWorkerModel(options.modelKey);
// Returns { provider: 'local' | 'openai' | 'google', modelId: string, compositeKey: string }

// Priority: options.modelKey → process.env.EMBED_MODEL_KEY → registry default
```

**Step 2: Runtime Validation** (Critical for Electron!)
```typescript
ensureLocalRuntime(modelResolution);
// THROWS if local provider in Node.js main process
// Reason: transformers.js requires Web Workers, which don't exist in Node.js
```

**Why This Matters**:
- Electron has two processes: main (Node.js) and renderer (Chromium)
- Local models MUST run in renderer (browser context with Web Workers)
- Hosted providers work in both (just HTTP requests)
- Attempting local models in main process → synchronous blocking → app freeze

**Step 3: Service Initialization**
```typescript
let { service, modelConfig } = await initializeEmbeddingService(options, activeModelId);
// service: EmbeddingService (default: SimpleEmbeddingService)
// modelConfig: { id, name, dimensions, quantized, description, tags, origin, size }

let activeModelDimension = ensureModelDimension(modelConfig, activeCompositeKey, log);
// Validates: dimensions > 0, dimensions <= MAX_EMBEDDING_DIMENSION (16000)
```

**Step 4: PGlite pgvector Detection**
```typescript
// Check if pgvector extension is available for native vector operations
let vectorEnabledForWrites = false;
const res = await options.db.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
vectorEnabledForWrites = res.rows.length > 0;
```

If pgvector is available:
```sql
UPDATE file_chunks SET embedding = $1::vector WHERE id = $2;
```

If not available (fallback):
```sql
UPDATE file_chunks SET embedding = $1 WHERE id = $2; -- Stored as REAL[]
```

### Worker Processing Loop (Concurrency)

The worker spawns **1-4 concurrent loops**:

```typescript
const loops: Promise<void>[] = [];
for (let i = 0; i < concurrency; i++) {
  loops.push(
    (async () => {
      while (running) {
        await processOne(); // Claim → Execute → Complete/Fail
      }
    })()
  );
}
```

**Per-Loop Processing**:

```typescript
async function processOne(): Promise<void> {
  // 1. Claim a job with lease-based locking
  const claimed = await jq.claim({ queue: 'embeddings', leaseMs: 60000, workerId });
  if (!claimed) {
    await sleep(400); // Idle backoff
    return;
  }

  // 2. Start heartbeat to extend lease while processing
  const hb = setInterval(() => {
    jq.heartbeat({ id: claimed.id, leaseToken: claimed.lease_token, extendMs: leaseMs });
  }, 10000);

  // 3. Execute job payload
  try {
    await executeJobPayload(claimed, claimed.lease_token);
    metrics.jobsProcessed++;
    consecutiveFailures = 0;
  } catch (err) {
    await jq.fail({ id: claimed.id, leaseToken: claimed.lease_token, error: err.message });
    metrics.jobsFailed++;
    consecutiveFailures++;
  } finally {
    clearInterval(hb);
  }
}
```

## Job Execution Deep Dive

### Job Payload Structure

```typescript
type EmbedChunkPayload = {
  chunkId: string;
  fileRecordId?: string;
  embeddingSetId?: string | null;      // REQUIRED (as of recent migration)
  expectedDimension?: number;          // Fallback to embedding_set.dimensions
  modelKey?: string | null;            // Override worker's default model
  provider?: 'local' | 'openai' | 'google' | null;
  dimensionParameter?: { ... } | null; // Provider-specific dimension config
};
```

### Step-by-Step Execution

**1. Load Chunk from Database**
```typescript
const chunk = await loadChunk(db, payload.chunkId);
// Returns: { id, content, contentHash, embeddingHash, embeddingSetId }

if (!chunk) throw new Error(`Chunk not found: ${payload.chunkId}`);
```

**2. Resolve Target Embedding Set**
```typescript
const targetSetId = payload.embeddingSetId ?? chunk.embeddingSetId;
if (!targetSetId) {
  throw new Error('Job payload missing embeddingSetId. Collections must exist before jobs.');
}
```

**Design Decision**: Workers no longer auto-create embedding sets. Users MUST create collections via UI first. This prevents orphaned embeddings and dimension mismatches.

**3. Determine Expected Dimension**
```typescript
const setDimension = await resolveEmbeddingSetDimension(db, targetSetId);
// Queries: SELECT dimensions FROM embedding_sets WHERE id = $1

// Cache in-memory to avoid repeated queries
embeddingSetDimensionCache.set(targetSetId, setDimension);
```

**4. Resolve Job Model** (May differ from worker's default!)
```typescript
const jobModel = resolveJobModel(payload);
// Parses payload.modelKey and payload.provider to determine composite key

// Examples:
// payload.modelKey = 'openai::text-embedding-3-small' → { provider: 'openai', modelId: '...', compositeKey: '...' }
// payload.modelKey = 'jina-code' → { provider: 'local', modelId: 'jina-code', compositeKey: 'local::jina-code' }
```

**5. Check if Embedding Already Up-to-Date** (Deduplication!)
```typescript
const expectedHash = await sha256Hex(`${chunk.contentHash}:${jobModel.compositeKey}`);

if (chunk.embeddingHash === expectedHash) {
  // Embedding already exists for this content + model combination
  await jq.complete({ id: claimed.id, leaseToken });
  return; // Skip embedding generation
}
```

**Hash Formula**: `SHA-256(contentHash:modelKey)`
- Same chunk content + same model = same hash
- Different model (e.g., jina-code → bge-m3) = different hash → regenerate
- Content change (edit file) = different contentHash → regenerate

**6. Generate Embedding** (Fork: Local vs. Hosted)

**Local Path**:
```typescript
if (jobModel.provider === 'local') {
  // Ensure correct model is loaded (may reinitialize if switching models)
  await ensureLocalModel(jobModel.modelId, jobModel.compositeKey);

  const result = await generateLocalEmbedding(chunk, expectedDimension);
  // Calls: service.generateDocEmbedding(chunk.content)
  // Returns: { embedding: number[], dimensions: number }

  if (result.embedding.length !== expectedDimension) {
    throw new Error('Dimension mismatch');
  }

  embedding = result.embedding;
}
```

**Hosted Path**:
```typescript
else {
  // Build provider-specific config
  const config = buildHostedProviderConfig(jobModel.provider, jobModel.modelId, expectedDimension);
  // For OpenAI: { runtime: 'hosted', provider: 'openai', modelId: '...', dimensions: 1536 }

  // Create provider instance (or retrieve from cache)
  const providerInstance = await createHostedProviderInstance(jobModel.provider, config);

  // Generate embedding via API
  const embedResult = await providerInstance.embed({ text: chunk.content, modelId: jobModel.modelId });

  if (!embedResult.ok) {
    throw new Error(formatHostedEmbedError(jobModel.provider, embedResult.error));
  }

  embedding = embedResult.value.embedding;
}
```

**7. Store Embedding with Hash**
```typescript
await updateChunkEmbedding(db, chunk.id, embedding, targetSetId, expectedHash, vectorEnabledForWrites);

// SQL (if pgvector available):
// UPDATE file_chunks
//    SET embedding = '[1.23,4.56,...]'::vector,
//        embedding_set_id = 'set-uuid',
//        embedding_updated_at = '2025-01-22T10:30:00Z',
//        embedding_hash = 'abc123...',
//        updated_at = '2025-01-22T10:30:00Z'
//  WHERE id = 'chunk-uuid';
```

**8. Mark Job Complete**
```typescript
await jq.complete({ id: claimed.id, leaseToken });
// Updates job_queue: state='succeeded', updated_at=NOW()
```

## Stability & Self-Healing Mechanisms

### 1. Periodic Reinitialization

```typescript
processedSinceInit++; // Increment after each successful job
if (reinitEveryN > 0 && processedSinceInit >= reinitEveryN) {
  await resetService(false); // Reinitialize with same device
}
```

**Why?**
- WebGPU/WASM backends can leak memory over time
- Periodic disposal releases native resources (GPU buffers, WASM heap)
- Default: Every 200 successful embeddings

### 2. Automatic CPU Fallback

```typescript
consecutiveFailures++; // Increment on job failure
const looksLikeModelExecError = /model execution/i.test(errorMessage);

if (consecutiveFailures >= forceCpuAfterFailures && looksLikeModelExecError) {
  log('worker_reset_service', { reason: 'consecutive_failures' });
  await resetService(true); // Force CPU device
}
```

**Why?**
- WebGPU can fail due to driver issues, memory exhaustion, or GPU contention
- WASM is more stable but slower
- CPU is slowest but most reliable
- Auto-fallback prevents worker from getting stuck

### 3. Graceful Database Closure Detection

```typescript
catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('PGlite is closed') || message.includes('closed')) {
    running = false; // Stop the worker loop
    return;
  }
  throw err; // Re-throw other errors
}
```

**Why?**
- App shutdown or factory reset closes the database
- Workers should stop gracefully instead of flooding logs with errors

## Vector Queue Service: Backfill & Monitoring

### VectorQueueSnapshot (UI State)

```typescript
export type VectorQueueSnapshot = {
  coverage: CoverageSnapshot | null;  // { total: number, withSet: number }
  queueCounts: QueueCounts;           // { queued, running, failed, succeeded }
  throughput: number;                 // Jobs/minute
  lastError: string | null;           // Most recent error message
  latency: LatencyStats;              // { avgMs, p50Ms, p95Ms }
};
```

**Refresh Query** (Powers the UI dashboard):
```typescript
async refresh(activeSetId: string | null): Promise<VectorQueueSnapshot> {
  const since = new Date(Date.now() - 60_000).toISOString(); // Last 60 seconds

  const [queueStats, throughputRows, lastErrorRows, latencyRows, coverage] = await Promise.all([
    jobQueue.getQueueStats('embeddings'),
    db.query(`SELECT COUNT(*) FROM job_queue WHERE queue='embeddings' AND state='succeeded' AND updated_at>=$1`, [since]),
    db.query(`SELECT error FROM job_queue WHERE state='failed' AND queue='embeddings' ORDER BY updated_at DESC LIMIT 1`),
    db.query(`SELECT run_at, updated_at FROM job_queue WHERE queue='embeddings' AND state='succeeded' AND updated_at>=$1 LIMIT 200`, [since]),
    chunkRepository.getCoverageForSet(activeSetId),
  ]);

  // Calculate latency percentiles from (updated_at - run_at)
  const latency = calculateLatency(latencyRows);

  return { coverage, queueCounts, throughput, lastError, latency };
}
```

**Latency Calculation**:
```typescript
function calculateLatency(rows: Array<{ runAt: string; updatedAt: string }>): LatencyStats {
  const durations = rows
    .map(row => Date.parse(row.updatedAt) - Date.parse(row.runAt))
    .sort((a, b) => a - b);

  return {
    avgMs: average(durations),
    p50Ms: percentile(durations, 0.5),  // Median
    p95Ms: percentile(durations, 0.95), // 95th percentile
  };
}
```

### Backfill Process (Enqueue Missing Embeddings)

```typescript
async backfill(activeSetId: string, onProgress: (done, total) => void): Promise<QueueCounts> {
  // 1. Find all chunks missing embeddings for this set
  const candidates = await db.query(`
    SELECT c.id, c.file_record_id AS "fileRecordId", c.content_hash AS "contentHash"
      FROM file_chunks c
     WHERE c.embedding_set_id = $1
       AND c.embedding IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM job_queue j
          WHERE j.queue = 'embeddings'
            AND j.state IN ('queued','running')
            AND j.dedupe_key = (c.id || ':' || $1 || ':' || c.content_hash)
       )
  `, [activeSetId]);

  // 2. Resolve embedding set metadata (model, dimensions)
  const setMetadata = await resolveEmbeddingSetJobMetadata(db, activeSetId);
  // Returns: { modelKey: 'local::jina-code', expectedDimension: 1024 }

  // 3. Enqueue in batches of 500
  for (const batch of chunkArray(candidates.rows, 500)) {
    await enqueueEmbeddingChunkJobsBatch(db, batch, activeSetId, setMetadata);
    onProgress(doneCount, totalCount);
  }

  // 4. Return updated queue counts
  return jobQueue.getQueueStats('embeddings');
}
```

**Batch Enqueue SQL** (CTE for deduplication):
```sql
WITH pending (chunk_id, job_id, payload_json, dedupe_key) AS (
  VALUES
    ('chunk1', 'uuid1', '{"chunkId":"chunk1",...}', 'chunk1:set-uuid:hash1'),
    ('chunk2', 'uuid2', '{"chunkId":"chunk2",...}', 'chunk2:set-uuid:hash2'),
    ...
),
inserted AS (
  INSERT INTO job_queue (id, queue, job_type, payload, dedupe_key, ...)
  SELECT pending.job_id, 'embeddings', 'embed_chunk', pending.payload_json::jsonb, pending.dedupe_key, ...
    FROM pending
   WHERE NOT EXISTS (
     SELECT 1 FROM job_queue j
      WHERE j.dedupe_key = pending.dedupe_key
        AND j.state IN ('queued','running')
   )
  RETURNING 1
)
SELECT COUNT(*) AS inserted FROM inserted;
```

**Key Features**:
- Only inserts jobs that don't already exist (idempotent)
- Single multi-row INSERT instead of 500 individual INSERTs
- Returns count of newly inserted jobs

## Device Selection & Fallback Strategy

### Device Priority for Local Models

```typescript
type Device = 'webgpu' | 'wasm' | 'cpu';

// Priority (fastest → slowest):
// 1. WebGPU: GPU-accelerated, requires compatible hardware
// 2. WASM: CPU-accelerated via SIMD, broadly compatible
// 3. CPU: Slowest, universally compatible
```

**Device Selection**:
```typescript
const device = options.device ?? 'webgpu'; // Default to fastest

await service.initializeWithModel(modelId, onProgress, device);
```

**Automatic Fallback**:
```typescript
// If WebGPU fails to initialize → WASM
// If WASM fails → CPU
// transformers.js backend handles this internally
```

**Manual Fallback** (after repeated failures):
```typescript
if (consecutiveFailures >= 3) {
  await resetService(true); // forceCpu=true
}
```

### Quantization Variants (Local Models Only)

```typescript
type Quantization = 'q4' | 'q8' | undefined;

// q4: 4-bit quantization (smallest, fastest, ~5% accuracy loss)
// q8: 8-bit quantization (medium, ~2% accuracy loss)
// undefined: Full precision (largest, slowest, no accuracy loss)
```

**Model Naming Convention**:
```
Supabase/gte-small      → Full precision (300MB)
Supabase/gte-small-q8   → 8-bit quantized (150MB)
Supabase/gte-small-q4   → 4-bit quantized (75MB)
```

**Cache Key Differentiation**:
```typescript
'local:gte-small:default' // Full precision
'local:gte-small:q8'      // 8-bit quantized
'local:gte-small:q4'      // 4-bit quantized
```

## Performance Metrics & Monitoring

### Worker Metrics

```typescript
const metrics = {
  startedAt: Date.now(),
  jobsProcessed: 0,
  jobsFailed: 0,
  totalDurationMs: 0,
};

// Periodic logging (every 30s)
setInterval(() => {
  const uptimeMs = Date.now() - metrics.startedAt;
  const avgMs = metrics.totalDurationMs / metrics.jobsProcessed;
  log('worker_metrics', {
    uptimeMs,
    processed: metrics.jobsProcessed,
    failed: metrics.jobsFailed,
    avgDurationMs: Math.round(avgMs),
    concurrency,
    queue: 'embeddings',
    modelKey: activeCompositeKey,
  });
}, 30000);
```

**Typical Performance Numbers**:
- Local (WebGPU): 50-200ms per embedding (1024 dimensions)
- Local (WASM): 200-800ms per embedding
- Local (CPU): 800-3000ms per embedding
- OpenAI: 100-500ms (network latency + API processing)
- Google: 150-600ms

### Throughput Calculation

```typescript
// Jobs completed in last 60 seconds
const count = await db.query(`
  SELECT COUNT(*) FROM job_queue
   WHERE queue='embeddings' AND state='succeeded'
     AND updated_at >= $1
`, [new Date(Date.now() - 60000).toISOString()]);

const throughput = count.rows[0].count; // Jobs per minute
```

## Key Files for Reference

- **Factory**: `/packages/embeddings/src/factory.ts` (line 48-339)
- **Worker**: `/packages/embeddings/src/worker/embedding-worker.ts` (line 393-883)
- **Transformers Provider**: `/packages/embeddings/src/providers/local/transformers-provider.ts`
- **Queue Service**: `/packages/vector-management/src/vector-status/vector-queue-service.ts` (line 113-459)

## Visual Design Suggestions (Non-Prescriptive)

- **Factory Cache Visualization**: Show Map structure with composite keys and provider instances
- **Worker Lifecycle**: State machine diagram (idle → initializing → ready → processing → stopped)
- **Job Execution Flow**: Swimlane diagram showing worker, database, and provider interactions
- **Device Fallback Chain**: WebGPU → WASM → CPU with performance trade-offs
- **Backfill Process**: Animated sequence showing batch enumeration → job creation → worker claiming
- **Concurrency**: Multiple worker loops processing in parallel with shared cache
- **Error Handling**: Result pattern visualization with all error types
- **Metrics Dashboard**: Real-time snapshot with coverage, queue counts, throughput, latency
- **Hash-Based Deduplication**: Content + model → SHA-256 → cache lookup flow
- **Cross-Platform Constraints**: Electron main vs. renderer process limitations

## Technical Depth

The designer should understand:
- Factory pattern with singleton-like instance management
- Discriminated unions for type-safe configuration
- Result pattern vs. exceptions for error handling
- Lease-based job claiming (prevents double-processing)
- Content-addressable storage (SHA-256 hashing)
- WebGPU vs. WASM vs. CPU performance characteristics
- Graceful degradation and self-healing systems
- Batch SQL operations with CTEs for performance

## Success Criteria

After viewing this infographic, a developer should be able to:
1. Explain why provider instances are cached and when they're reused
2. Trace the path of a chunk from backfill enqueue through embedding generation to database storage
3. Understand when the worker reinitializes and why
4. Identify the performance trade-offs between WebGPU, WASM, and CPU
5. Recognize how the system prevents duplicate job processing
6. Explain the difference between local and hosted provider initialization
7. Understand how embedding hashes enable deduplication

---

**Code Complexity**: ~1,500 lines across 4 files
**Provider Types**: 5 (local, openai, google, cohere, voyage)
**Device Types**: 3 (webgpu, wasm, cpu)
**Error Types**: 6 (missing_api_key, api_error, rate_limit_exceeded, model_load_failed, dimension_mismatch, validation_error)
**Performance Range**: 50ms-3000ms per embedding depending on device
