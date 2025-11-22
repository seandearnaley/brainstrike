# Infographic Design Brief: Vector Embedding Pipeline

## Context

BrainStrike converts code files into searchable vector embeddings so users can perform semantic search across their codebase. This pipeline transforms raw text files into high-dimensional vectors that capture semantic meaning, enabling queries like "authentication logic" to find relevant code even without exact keyword matches.

## The Complete Pipeline Flow

```
File Content → Chunking → Queue Job → Worker Claims → Generate Embedding → Store in DB → Enable Search
```

## Stage 1: Text Chunking (File → Chunks)

### Why Chunking?

**The Problem**:
- Embedding models have token limits (512-8192 tokens typical)
- Large files (10,000+ lines) exceed these limits
- Semantic meaning is often localized (a function, a class, a paragraph)

**The Solution**: Break files into semantically meaningful chunks

### ChunkingService Architecture

Located in `packages/db/src/services/chunking-service.ts`

**Three Chunking Strategies**:

#### 1. Sentence Chunking (`'sentence'`)
- Uses `.` as primary separator
- Best for: Natural language text, documentation, comments
- Example: README files, markdown docs

```typescript
const sentenceChunker = new CharacterTextSplitter({
  chunkSize: maxChars,        // ~800 characters (≈200 tokens)
  chunkOverlap: overlapChars, // ~80 characters (≈20 tokens)
  separator: '. ',
});
```

#### 2. Token Chunking (`'token'`)
- Splits by token count (not character count)
- Best for: Mixed content, unknown file types
- More accurate but slower (requires tokenization)

```typescript
const tokenChunker = new TokenTextSplitter({
  chunkSize: effectiveMaxTokens,  // 200 tokens default
  chunkOverlap: effectiveOverlap, // 20 tokens default
});
```

#### 3. Recursive Chunking (`'recursive'`)
- Uses code-aware separators
- Best for: Source code files
- Separators prioritize natural code boundaries:

```typescript
const codeSeparators = [
  '\n\n',                    // Blank lines (highest priority)
  '\nexport default ',       // Module exports
  '\nclass ',                // Class definitions
  '\nfunction ',             // Function declarations
  '\nconst ', '\nlet ',      // Variable declarations
  '\ninterface ', '\ntype ', // TypeScript types
  '\nimport ',               // Import statements
  '\ndescribe(', '\nit(',    // Test blocks
  '\n}',                     // Closing braces
  '\n', ';', ',', ' ', ''    // Fallback separators
];
```

### Adaptive Chunking

The system automatically adjusts chunk size based on file type and size:

```typescript
// Code files (TypeScript, JavaScript, Python, etc.)
if (isCode) {
  maxTokens = 400;  // Larger chunks for code context
  overlap = 40;     // More overlap to preserve continuity
}

// Large structured files (JSON, XML, logs)
if (matchesStructured) {
  maxTokens = 600;  // Even larger for structured data
  overlap = 60;
}

// Very large files (> 1MB)
if (exceedsVeryLargeThreshold) {
  maxTokens = 800;  // Aggressive chunking
  overlap = 80;
}
```

### Smart File Skipping

Not all files should be chunked:

```typescript
const SKIP_CHUNKING_PATTERNS = [
  /package-lock\.json$/i,   // Lock files (huge, low signal)
  /\.min\.[jt]s$/i,         // Minified files
  /\.map$/i,                // Source maps
  /node_modules/i,          // Dependencies
  /dist\/|build\//i,        // Build artifacts
];
```

### Chunk Output Format

```typescript
interface FileChunkInsert {
  id: string;                    // "${fileRecordId}_chunk_0"
  fileRecordId: string;          // Parent file ID
  chunkIndex: number;            // Position in file (0, 1, 2...)
  content: string;               // The actual text chunk
  contentHash: string;           // SHA-256 of content
  tokenCount: number;            // Estimated token count
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize: number;             // Max tokens setting used
  createdAt: string;             // ISO timestamp
  updatedAt: string;

  // Embedding fields (populated later)
  embedding?: number[];          // Vector array [0.123, -0.456, ...]
  embeddingSetId?: string;       // Which model/collection
  embeddingUpdatedAt?: string;
  embeddingHash?: string;        // SHA-256 of content + model key
}
```

### Token Estimation vs Accurate Counting

**Fast Estimation** (default):
```typescript
estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4); // 1 token ≈ 4 chars (GPT heuristic)
}
```

**Accurate Counting** (optional):
```typescript
// Uses tiktoken library for precise token counts
tokenCounter: async (text: string) => countTokensAccurate(text)
```

### Streaming API for Memory Efficiency

```typescript
async *chunkContentStream(
  content: string,
  fileRecordId: string,
  options: ChunkingOptions
): AsyncGenerator<FileChunkInsert> {
  // Yields chunks one at a time instead of materializing entire array
  // Prevents memory spikes on large files
  for (const chunk of chunks) {
    yield chunk;
  }
}
```

## Stage 2: Embedding Generation

### Model Architecture

BrainStrike supports multiple embedding providers:

**Local Models** (runs in browser/Electron):
- `BAAI/bge-m3` (1024 dimensions) - Default
- `Xenova/all-MiniLM-L6-v2` (384 dimensions)
- Runs via Transformers.js + WASM/WebGPU

**Hosted Models** (API-based):
- OpenAI: `text-embedding-3-small` (1536d), `text-embedding-3-large` (3072d)
- Google: `text-embedding-004` (768d)
- Voyage AI: `voyage-3` (1024d)
- Cohere: `embed-english-v3.0` (1024d)

### Model Registry

```typescript
// packages/embeddings/src/model-registry.ts
const MODEL_REGISTRY: ModelConfig[] = [
  {
    id: 'BAAI/bge-m3',
    name: 'BGE-M3 (Multilingual)',
    dimensions: 1024,
    quantized: false,
    description: 'State-of-the-art multilingual embedding model',
    tags: ['multilingual', 'high-accuracy', 'code'],
    origin: 'local',
    size: '2.3GB',
  },
  {
    id: 'text-embedding-3-small',
    name: 'OpenAI Small (Hosted)',
    dimensions: 1536,
    description: 'OpenAI hosted embedding model',
    tags: ['hosted', 'openai', 'fast'],
    origin: 'hosted',
    provider: 'openai',
  },
  // ... more models
];
```

### Provider Architecture

**Interface** (`packages/embeddings/src/interfaces/provider.ts`):
```typescript
interface EmbeddingProvider {
  embed(request: EmbedRequest): Promise<Result<EmbedResponse, EmbeddingProviderError>>;
  batchEmbed(requests: EmbedRequest[]): Promise<Result<EmbedBatchResponse, EmbeddingProviderError>>;
  isHealthy(): Promise<boolean>;
}

type EmbedRequest = {
  text: string;
  modelId: string;
  dimensions?: number;  // For models supporting dynamic dimensions
};

type EmbedResponse = {
  embedding: number[];
  modelId: string;
  usage?: { promptTokens: number; totalTokens: number };
};
```

**OpenAI Provider** (example):
```typescript
// packages/embeddings/src/providers/hosted/openai-provider.ts
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  async embed(request: EmbedRequest): Promise<Result<EmbedResponse, EmbeddingProviderError>> {
    const apiKey = await resolveApiKey('openai'); // From env or config

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: request.text,
        model: request.modelId,
        dimensions: request.dimensions, // Optional: 512, 1536, 3072
      }),
    });

    const data = await response.json();
    return {
      ok: true,
      value: {
        embedding: data.data[0].embedding,
        modelId: request.modelId,
        usage: {
          promptTokens: data.usage.prompt_tokens,
          totalTokens: data.usage.total_tokens,
        },
      },
    };
  }
}
```

**Local Transformers Provider**:
```typescript
// packages/embeddings/src/providers/local/transformers-provider.ts
class TransformersEmbeddingProvider implements EmbeddingProvider {
  private pipeline?: Pipeline;
  private backend: 'webgpu' | 'wasm' | 'cpu' = 'wasm';

  async initialize(modelId: string, device?: 'webgpu' | 'wasm' | 'cpu') {
    // Load model in Web Worker to avoid blocking UI
    this.pipeline = await pipeline('feature-extraction', modelId, {
      device: device ?? this.backend,
      quantized: true, // Use quantized models for faster inference
    });
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const output = await this.pipeline(request.text, {
      pooling: 'mean',      // Average all token embeddings
      normalize: true,       // L2 normalize to unit length
    });

    return {
      embedding: Array.from(output.data), // Float32Array → number[]
      modelId: request.modelId,
    };
  }
}
```

### TransformersBackend Architecture

Critical for local model execution:

```typescript
// packages/embeddings/src/transformers-backend.ts
class TransformersBackend {
  private worker?: Worker;
  private queue: Map<string, QueuedRequest> = new Map();

  // CRITICAL: Local models MUST run in Web Workers
  // Blocking the main thread freezes the UI
  private async ensureWorker() {
    if (this.worker) return;

    this.worker = new Worker(new URL('./model-worker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = (e) => {
      const { requestId, embedding, error } = e.data;
      const request = this.queue.get(requestId);
      if (request) {
        if (error) request.reject(error);
        else request.resolve(embedding);
        this.queue.delete(requestId);
      }
    };
  }

  async generateEmbedding(text: string): Promise<number[]> {
    await this.ensureWorker();
    const requestId = generateUUID();

    return new Promise((resolve, reject) => {
      this.queue.set(requestId, { resolve, reject });
      this.worker!.postMessage({ requestId, text, modelId: this.modelId });
    });
  }
}
```

## Stage 3: Job Queue (Decoupling)

### Why a Job Queue?

**Problem**: Embedding generation is expensive (100ms - 2s per chunk)
**Solution**: Async job queue with retry logic

### Job Structure

```typescript
interface Job {
  id: string;
  queue: 'embeddings';
  jobType: 'embed_chunk';
  payload: {
    chunkId: string;
    fileRecordId?: string;
    embeddingSetId?: string;      // Which collection/model to use
    expectedDimension?: number;   // 768, 1024, 1536, etc.
    modelKey?: string;            // "openai/text-embedding-3-small"
    provider?: EmbeddingProviderType;
  };
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  runAt: string;              // ISO timestamp - when to run
  attempts: number;           // How many times we've tried
  maxAttempts: number;        // Give up after this many (default: 5)
  backoffMs: number;          // How long to wait before retry
  leaseToken?: string;        // UUID - prevents double-processing
  leasedUntil?: string;       // When lease expires (60s default)
  workerId?: string;          // Which worker claimed this
  dedupeKey?: string;         // Prevent duplicate jobs
  error?: string;             // Last error message
}
```

### Job Lifecycle

```
1. ENQUEUE    → state: 'queued', attempts: 0
2. CLAIM      → state: 'running', attempts: 1, lease_token: UUID
3. HEARTBEAT  → Extend lease by 60s (prevents timeout)
4. COMPLETE   → state: 'succeeded'
   OR FAIL    → state: 'queued', attempts: 2, backoff: 2s
   OR FAIL    → (after 5 attempts) state: 'failed' (POISON PILL)
```

### Idempotent Enqueue

Prevents duplicate jobs using `dedupeKey`:

```typescript
async enqueue(params: EnqueueParams): Promise<Job> {
  const dedupeKey = params.dedupeKey ?? null;

  // CTE (Common Table Expression) for atomic upsert
  const result = await db.query(`
    WITH existing AS (
      SELECT * FROM job_queue
      WHERE dedupe_key = $7
        AND state IN ('queued', 'running')
      LIMIT 1
    ),
    upd AS (
      UPDATE job_queue
      SET run_at = LEAST(run_at, $5),
          updated_at = GREATEST(updated_at, $8)
      WHERE id IN (SELECT id FROM existing)
      RETURNING *
    ),
    ins AS (
      INSERT INTO job_queue (...)
      SELECT $1, $2, ...
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING *
    )
    SELECT * FROM upd UNION ALL SELECT * FROM ins
  `);

  return result.rows[0]; // Either existing job or new job
}
```

### Retry Policy

Exponential backoff with jitter:

```typescript
retryPolicy(attempts: number): number {
  const base = 1000;              // 1 second
  const cap = 5 * 60 * 1000;      // 5 minutes max
  const exp = Math.min(cap, base * 2 ** attempts);  // 1s, 2s, 4s, 8s, ...
  const jitter = Math.floor(exp * (0.2 + Math.random() * 0.3));
  return Math.min(cap, Math.max(base, jitter));
}

// Attempt 1: ~1-1.5s
// Attempt 2: ~2-3s
// Attempt 3: ~4-6s
// Attempt 4: ~8-12s
// Attempt 5: ~16-24s (then fails permanently)
```

## Stage 4: Embedding Worker

### Worker Architecture

Located in `packages/embeddings/src/worker/embedding-worker.ts`

**Key Features**:
- Concurrency control (1-4 parallel jobs)
- Lease heartbeats (prevent job timeout)
- Periodic service reinitialization (release GPU memory)
- Fallback to CPU after failures (stability)
- Metrics logging (observability)

### Worker Startup

```typescript
async function startEmbeddingWorker(options: EmbeddingWorkerOptions) {
  const workerId = `embed-worker-${generateUUID().slice(0, 8)}`;
  const queueName = 'embeddings';
  const concurrency = 4; // Process 4 chunks in parallel
  const leaseMs = 60_000; // Hold lease for 60 seconds

  // Initialize embedding service (local or hosted)
  const service = new SimpleEmbeddingService();
  await service.initializeWithModel('BAAI/bge-m3', undefined, 'webgpu');

  // Start worker loops
  const loops = [];
  for (let i = 0; i < concurrency; i++) {
    loops.push(workerLoop());
  }

  return {
    stop: async () => {
      running = false;
      await Promise.allSettled(loops);
      await service.dispose();
    }
  };
}
```

### Worker Loop (Simplified)

```typescript
async function workerLoop() {
  while (running) {
    // 1. Claim next job
    const job = await jobQueue.claim({
      queue: 'embeddings',
      leaseMs: 60_000,
      workerId,
    });

    if (!job) {
      await sleep(400); // No work available, back off
      continue;
    }

    // 2. Start heartbeat (extend lease every 10s)
    const heartbeat = setInterval(() => {
      jobQueue.heartbeat({
        id: job.id,
        leaseToken: job.lease_token,
        extendMs: 60_000,
      });
    }, 10_000);

    try {
      // 3. Load chunk from database
      const chunk = await loadChunk(db, job.payload.chunkId);

      // 4. Check if embedding already up-to-date
      const expectedHash = sha256(`${chunk.contentHash}:${modelKey}`);
      if (chunk.embeddingHash === expectedHash) {
        await jobQueue.complete({ id: job.id, leaseToken: job.lease_token });
        continue; // Skip - already embedded
      }

      // 5. Generate embedding
      const embedding = await service.generateEmbedding(chunk.content);

      // 6. Validate dimensions
      const expectedDim = await resolveEmbeddingSetDimension(db, embeddingSetId);
      if (embedding.length !== expectedDim) {
        throw new Error(`Dimension mismatch: got ${embedding.length}, expected ${expectedDim}`);
      }

      // 7. Store in database
      await updateChunkEmbedding(
        db,
        chunk.id,
        embedding,
        embeddingSetId,
        expectedHash,
        vectorEnabled
      );

      // 8. Mark job complete
      await jobQueue.complete({ id: job.id, leaseToken: job.lease_token });

    } catch (error) {
      // 9. Fail job (will retry with backoff)
      await jobQueue.fail({
        id: job.id,
        leaseToken: job.lease_token,
        error: error.message,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
```

### Dimension Validation

Critical safety check:

```typescript
// pgvector requires EXACT dimension match
// Mismatch crashes the database query
async function resolveEmbeddingSetDimension(
  db: IDatabase,
  embeddingSetId: string
): Promise<number> {
  const result = await db.query(
    'SELECT dimensions FROM embedding_sets WHERE id = $1',
    [embeddingSetId]
  );

  const dimension = result.rows[0]?.dimensions;
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error(`Invalid dimension for set ${embeddingSetId}`);
  }

  return dimension;
}
```

### Hosted Provider Handling

```typescript
// For hosted models (OpenAI, Google)
if (jobModel.provider !== 'local') {
  const config = buildHostedProviderConfig(
    jobModel.provider,
    jobModel.modelId,
    expectedDimension
  );

  const provider = await createHostedProviderInstance(config);
  const result = await provider.embed({
    text: chunk.content,
    modelId: jobModel.modelId,
  });

  if (!result.ok) {
    throw new Error(formatHostedEmbedError(jobModel.provider, result.error));
  }

  embedding = result.value.embedding;
}
```

### Stability Features

**Periodic Reinitialization**:
```typescript
// Reinit service every 100 successful embeddings
// Releases WebGPU/WASM memory to prevent leaks
if (processedSinceInit >= 100) {
  await service.dispose();
  service = new SimpleEmbeddingService();
  await service.initializeWithModel(modelKey);
  processedSinceInit = 0;
}
```

**CPU Fallback**:
```typescript
// After 3 consecutive failures, switch to CPU
if (consecutiveFailures >= 3) {
  logger.warn('Falling back to CPU after repeated GPU failures');
  await service.dispose();
  service = new SimpleEmbeddingService();
  await service.initializeWithModel(modelKey, undefined, 'cpu');
}
```

## Stage 5: Database Storage

### Database Write

```typescript
async function updateChunkEmbedding(
  db: IDatabase,
  chunkId: string,
  embedding: number[],
  embeddingSetId: string,
  embeddingHash: string,
  vectorEnabled: boolean
) {
  const now = new Date().toISOString();
  const vectorString = `[${embedding.join(',')}]`;

  const sql = vectorEnabled
    ? `UPDATE file_chunks SET
         embedding = $1::vector,           -- pgvector type
         embedding_set_id = $2,
         embedding_updated_at = $3,
         embedding_hash = $4,
         updated_at = $3
       WHERE id = $5`
    : `UPDATE file_chunks SET
         embedding = $1,                   -- JSON array fallback
         embedding_set_id = $2,
         embedding_updated_at = $3,
         embedding_hash = $4,
         updated_at = $3
       WHERE id = $5`;

  await db.query(sql, [vectorString, embeddingSetId, now, embeddingHash, chunkId]);
}
```

### Embedding Hash (Idempotency)

```typescript
// Hash = SHA256(content_hash + model_key)
// If hash matches, skip re-embedding
const embeddingHash = await sha256Hex(`${chunk.contentHash}:openai/text-embedding-3-small`);

// Check before embedding
if (chunk.embeddingHash === embeddingHash) {
  return; // Already embedded with this model
}
```

## End-to-End Example

**User imports a TypeScript file (`auth.ts`, 500 lines)**:

1. **Chunking**:
   - ChunkingService detects `.ts` extension
   - Uses recursive strategy with code separators
   - Produces 12 chunks (avg 200 tokens each)
   - Each chunk overlaps by 20 tokens with neighbors

2. **Queue**:
   - 12 jobs enqueued to `embeddings` queue
   - Each job: `{ chunkId: "file123_chunk_0", embeddingSetId: "set-abc", modelKey: "BAAI/bge-m3" }`
   - Deduplication prevents double-enqueue

3. **Worker**:
   - Worker claims job (lease 60s)
   - Loads chunk text from database
   - Generates 1024-dim embedding via local model
   - Heartbeat extends lease every 10s
   - Stores embedding in `file_chunks` table
   - Marks job complete

4. **Search Ready**:
   - User types: "JWT validation logic"
   - System embeds query using same model
   - pgvector finds 3 nearest chunks via cosine similarity
   - Returns matched code with context

## Visual Suggestion for Infographic

**Recommended Layout**:
- **Left Column**: File → Chunks (visual of text splitting)
- **Center Column**: Queue → Worker → Embedding Generation
- **Right Column**: Database → Vector Storage → Search

**Key Visual Elements**:
- File being "sliced" into chunks with overlap indicators
- Job queue as a conveyor belt with retry arrows
- Worker as a processing unit with model selection
- Vector database as high-dimensional space with nearest neighbor search

**Complexity to Emphasize**:
- Different chunking strategies for different file types
- Retry mechanism with exponential backoff
- Dimension validation (critical for pgvector)
- Embedding hash for idempotency
- Worker heartbeats preventing job timeout
- Model selection (local vs hosted)

**Code Snippets to Highlight**:
- Chunk output structure
- Job state transitions
- Embedding provider interface
- Dimension validation

This pipeline transforms unstructured code into searchable semantic vectors while handling failures gracefully and preventing resource exhaustion.
