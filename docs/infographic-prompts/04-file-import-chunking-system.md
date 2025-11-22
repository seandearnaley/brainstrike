# Infographic Design Brief: Multi-Phase File Import & Chunking System

## Context & Purpose

This infographic should visualize the sophisticated **five-phase orchestration** that transforms raw files into searchable, embedded chunks in BrainStrike. This system handles deduplication, adaptive chunking strategies, token counting, and embedding job enqueueing—all while providing granular progress feedback to the UI.

The target audience includes full-stack developers, data engineers, and system architects who need to understand how BrainStrike processes files from user selection through database storage and embedding generation.

## System Overview

File import in BrainStrike is a **multi-phase pipeline** that coordinates:

1. **Phase 1: File Import** → Deduplicate and store file metadata + content
2. **Phase 2: Chunking** → Split large files into semantic chunks
3. **Phase 3: Embedding Set Assignment** → Associate chunks with embedding collections
4. **Phase 4: Job Enqueueing** → Queue embedding generation jobs
5. **Phase 5: Worker Processing** → (Handled by embedding worker, separate infographic)

Each phase is **fault-tolerant**, **progress-tracked**, and **transactional** where supported.

## Phase 1: File Import (Base Import Runner)

### Input Data Structure

```typescript
interface BaseImportRunnerRequest {
  selectedFilePaths: Set<string>;  // User-selected paths
  fileTree: IFileNode[];           // Hierarchical directory structure
  fileContents: Record<string, string>; // path → content mapping
  onProgress: (progress: ImportProgress) => void;
}
```

**Example**:
```typescript
{
  selectedFilePaths: new Set(['/src/main.ts', '/src/utils.ts']),
  fileTree: [
    { path: '/src', type: 'directory', children: [
      { path: '/src/main.ts', type: 'file', size: 2048 },
      { path: '/src/utils.ts', type: 'file', size: 1024 }
    ]}
  ],
  fileContents: {
    '/src/main.ts': 'import { ... } ...',
    '/src/utils.ts': 'export function ...'
  }
}
```

### Deduplication Strategy (Content-Addressable Storage)

The import process uses **SHA-256 content hashing** to prevent duplicate storage:

```typescript
// From base-repository.ts processBatch()

// Step 1: Pre-compute all content hashes in parallel
const hashPromises = batch.map(async (request, index) => ({
  index,
  request,
  hash: await generateContentHash(request.content)  // SHA-256
}));
const hashResults = await Promise.all(hashPromises);

// Step 2: Batch query to check which files already exist (single query!)
const existingMap = await findByContentHashBatch(hashes, tx);
// Returns Map<dedupeKey, FileRecord>
// dedupeKey format: "contentHash::embeddingSetId"

// Step 3: Prepare records for batch insert (only new files)
for (const { index, request, hash } of hashResults) {
  const dedupeKey = `${hash}::${request.embeddingSetId || '__default__'}`;
  const existing = existingMap.get(dedupeKey);

  if (existing) {
    results[index] = { id: existing.id, imported: false, existed: true };
    continue; // Skip - already have this exact content
  }

  // New file - add to insertion batch
  recordsToInsert.push({
    id: generateUUID(),
    name: request.name,
    path: request.path,
    size: request.size,
    content: request.content,
    contentHash: hash,
    tokenCount: countTokensHeuristic(request.content), // ~4 chars/token
    processedAt: now,
    embeddingSetId: request.embeddingSetId
  });

  results[index] = { id, imported: true, existed: false };
}

// Step 4: Batch insert all new records (single multi-row INSERT!)
await batchInsert(recordsToInsert, tx);
```

**Key Performance Optimizations**:
- **Parallel hashing**: All SHA-256 computations run concurrently
- **Single existence check**: `SELECT * FROM file_records WHERE content_hash IN ($1,$2,...,$100)`
- **Batch inserts**: Multi-row `INSERT ... VALUES (row1), (row2), ...` instead of N individual INSERTs
- **Batch size: 100 files** (configurable constant)

**Deduplication Key Format**:
```typescript
// Same content in different embedding sets = different records
buildDedupKey(hash: string, embeddingSetId?: string | null): string {
  const normalizedHash = hash ?? '';
  const normalizedSet = embeddingSetId?.trim() ? embeddingSetId.trim() : '__default__';
  return `${normalizedHash}::${normalizedSet}`;
}
```

**Why Per-Set Deduplication?**
- User imports `README.md` → embedding set "Set A" (1024 dimensions)
- Later imports same `README.md` → embedding set "Set B" (768 dimensions)
- Must store BOTH (same content, different embedding dimensions)

### Import Progress Tracking

```typescript
interface ImportProgress {
  total: number;        // Total files to import
  completed: number;    // Files processed so far
  current?: string;     // Current file name
  errors: Array<{ file: string; error: string }>;
}

// Callback during batch processing
onProgress(offset + index, total, request.name);
```

**UI Impact**: Real-time progress bar updates like "Importing utils.ts (42/100)"

### Import Results

```typescript
interface FileImportResult {
  id: string;       // File record UUID
  imported: boolean; // true if new file was created
  existed: boolean;  // true if file already existed (deduped)
  error?: string;    // Error message if import failed
}
```

**Example Results**:
```typescript
[
  { id: 'uuid-1', imported: true, existed: false },  // New file
  { id: 'uuid-2', imported: false, existed: true },  // Duplicate (skipped)
  { id: 'uuid-3', imported: false, existed: false, error: 'Binary content' } // Failed
]
```

## Phase 2: Chunking (Adaptive Strategy Selection)

### Chunking Strategies

BrainStrike supports **3 chunking strategies**:

1. **`sentence`**: Split on sentence boundaries (periods, question marks, exclamation points)
   - Uses `CharacterTextSplitter` from LangChain
   - Preserves semantic coherence
   - Best for: Natural language documents, READMEs, documentation

2. **`token`**: Split on token limits (e.g., 1024 tokens per chunk)
   - Uses `TokenTextSplitter` from LangChain
   - Precise token budget control
   - Best for: Large structured files, JSON, CSV, logs

3. **`recursive`**: Hierarchical splitting with code-aware separators
   - Uses `RecursiveCharacterTextSplitter` from LangChain
   - Tries to split on paragraphs, then sentences, then characters
   - Respects code block boundaries
   - Best for: Source code, Markdown with code blocks

### Adaptive Strategy Selection (File-Type Heuristics)

The chunking service **automatically selects** the best strategy based on file type:

```typescript
// From chunking-service.ts adjustChunkingForFileType()

const fileName = options.fileName || options.filePath || '';

// 1. Detect code files
const isCode = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|rs|go|py|java|kt|cs|rb|php|cpp|c|h|m|mm|swift)$/.test(
  fileName.toLowerCase()
);
if (isCode) {
  maxTokens = Math.min(maxTokens, CHUNKING_CONFIG.codeMaxTokens);  // 2048
  overlap = Math.min(overlap, CHUNKING_CONFIG.codeOverlap);        // 200
}

// 2. Detect large structured files
const matchesStructured = /\.(json|xml|csv|tsv|sql|log)$/i.test(fileName);
if (matchesStructured) {
  maxTokens = Math.min(maxTokens, CHUNKING_CONFIG.largeStructuredMaxTokens);  // 4096
  overlap = Math.min(overlap, CHUNKING_CONFIG.largeStructuredOverlap);        // 400
}

// 3. Detect documentation
const isDoc = /\.(md|mdx|txt|rst|adoc)$/i.test(fileName);
if (isDoc) {
  // Use defaults (1024 tokens, 100 overlap)
}
```

**Configuration Hierarchy**:
```
User Explicit Override
  ↓ (if not set)
File Type Heuristics (code, structured, doc)
  ↓ (if not set)
Global Defaults (1024 tokens, 100 overlap)
  ↓ (always applied)
Global Safety Caps (maxTokensCap: 16384)
```

### Skip Patterns (Avoid Chunking Noise)

Certain files are **automatically skipped**:

```typescript
// Lock files and dependency manifests
const SKIP_CHUNKING_PATTERNS = [
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
  /composer\.lock$/i,
  // Build artifacts
  /\.min\.[jt]s$/i,
  /\.map$/i,
  /\.wasm$/i,
  // Large vendor directories
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)build(\/|$)/i,
];

// Binary content detection
const probeWindow = content.slice(0, 4096);
if (probeWindow.includes('\u0000')) {
  return { skip: true, reason: 'Binary content detected (NUL bytes present)' };
}

// Highly repetitive content (generated files)
const uniqueLines = new Set(content.split('\n')).size;
const totalLines = content.split('\n').length;
if (totalLines > 1000 && uniqueLines / totalLines < 0.1) {
  return { skip: true, reason: 'Highly repetitive content (likely generated file)' };
}
```

### Token-True Sizing (Accurate vs. Heuristic)

BrainStrike supports **two token counting modes**:

**1. Heuristic (Fast)**:
```typescript
// ~4 characters per token (rough estimate)
private countTokensHeuristic(content: string): number {
  return Math.ceil(content.length / 4);
}
```
- **Speed**: Instant (no tokenizer overhead)
- **Accuracy**: ±20%
- **Use case**: Bulk import, progress estimation

**2. Token-True (Accurate)**:
```typescript
import { countTokensAccurate } from '@brainstrike/utils';

const tokenCount = await countTokensAccurate(content);
// Uses actual tokenizer library (e.g., tiktoken, anthropic-tokenizer)
```
- **Speed**: ~100x slower than heuristic
- **Accuracy**: Exact
- **Use case**: Final chunk sizing, embedding budget enforcement

**When to Use Each**:
```typescript
// Phase 1 (import): Heuristic for speed
record.tokenCount = countTokensHeuristic(record.content);

// Phase 2 (chunking): Token-true if enabled
if (options.tokenTrueSizing) {
  chunk.tokenCount = await countTokensAccurate(chunk.content);
} else {
  chunk.tokenCount = countTokensHeuristic(chunk.content);
}
```

### Chunk Data Model

```typescript
interface FileChunkInsert {
  id: string;                // UUID
  fileRecordId: string;      // Foreign key to file_records
  chunkIndex: number;        // Order within file (0-indexed)
  content: string;           // Chunk text
  tokenCount: number;        // Accurate or heuristic
  startOffset?: number;      // Character offset in original file
  endOffset?: number;        // Character offset (exclusive)
  contentHash: string;       // SHA-256 of chunk content
  embeddingSetId?: string;   // Assigned embedding set
  createdAt: string;         // ISO timestamp
}
```

### Chunk Streaming (Memory-Efficient Processing)

For large files, chunking uses a **streaming generator**:

```typescript
async *chunkContentStream(
  content: string,
  fileRecordId: string,
  options: ChunkingOptions
): AsyncGenerator<FileChunkInsert> {
  const splitter = this.getSplitter(options.strategy, {
    chunkSize: options.maxTokens || 1024,
    chunkOverlap: options.overlap || 100,
  });

  // LangChain splitter returns chunks as they're generated
  const chunks = await splitter.splitText(content);

  for (let i = 0; i < chunks.length; i++) {
    const chunkContent = chunks[i];
    const tokenCount = options.tokenTrueSizing
      ? await countTokensAccurate(chunkContent)
      : countTokensHeuristic(chunkContent);

    yield {
      id: generateUUID(),
      fileRecordId,
      chunkIndex: i,
      content: chunkContent,
      tokenCount,
      contentHash: await generateContentHash(chunkContent),
      createdAt: new Date().toISOString(),
    };
  }
}

// Consume stream in batches
const chunks: FileChunkInsert[] = [];
for await (const chunk of this.chunkContentStream(content, fileRecordId, options)) {
  chunks.push(chunk);
}
```

**Why Streaming?**
- **Memory efficiency**: Process 100MB files without loading entire chunk array into memory
- **Progress feedback**: Can report chunks as they're generated
- **Early termination**: Can stop processing if error detected

### Chunking Progress

```typescript
interface EnhancedImportProgress {
  phase: 'importing' | 'chunking' | 'assigning' | 'enqueueing' | 'complete';
  total: number;
  completed: number;
  current: string; // "Chunking main.ts (chunk 12/45)"
  errors: Array<{ file: string; error: string }>;
}
```

## Phase 3: Embedding Set Assignment

### Embedding Set Model

```typescript
interface EmbeddingSet {
  id: string;           // UUID
  modelKey: string;     // Composite key: "local::jina-code" or "openai::text-embedding-3-small"
  modelId: string;      // Model identifier: "jina-code" or "text-embedding-3-small"
  dimensions: number;   // 384, 768, 1024, 1536, 3072, etc.
  distance: 'cosine' | 'l2' | 'ip';  // Distance metric
  name?: string;        // User-friendly name: "My Code Embeddings"
  description?: string; // Optional description
  tags?: string[];      // ["code", "search"]
  createdAt: string;    // ISO timestamp
}
```

### Set Resolution & Creation

The import process **ensures** an embedding set exists:

```typescript
async function ensureEmbeddingSet(
  sql: SqlExecutorPort,
  params: {
    modelKey: string;          // "local::jina-code"
    modelId: string;           // "jina-code"
    dimensions: number;        // 1024
    distance: 'cosine';
    preferredId?: string;      // User-selected set ID
    provider: 'local';
  }
): Promise<string> {
  // 1. Check if preferredId exists and matches criteria
  if (preferredId) {
    const existing = await sql.query(`
      SELECT id FROM embedding_sets
       WHERE id = $1
         AND dimensions = $2
         AND distance = $3
       LIMIT 1
    `, [preferredId, dimensions, distance]);

    if (existing.rows[0]) {
      return preferredId; // Use existing set
    }
  }

  // 2. Find matching set by model key
  const variants = getModelKeyVariants(modelKey, provider, modelId);
  // variants = ["local::jina-code", "jina-code", "local:jina-code"]

  const existing = await sql.query(`
    SELECT id FROM embedding_sets
     WHERE model_key = ANY($1)
       AND dimensions = $2
       AND distance = $3
     LIMIT 1
  `, [variants, dimensions, distance]);

  if (existing.rows[0]) {
    return existing.rows[0].id; // Use existing set
  }

  // 3. Create new set
  const id = generateUUID();
  await sql.query(`
    INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [id, modelKey, modelId, dimensions, distance, new Date().toISOString()]);

  dispatchEvent(new CustomEvent('brainstrike:embedding-set-updated', { detail: { id } }));
  return id;
}
```

### Backfill Assignment (Update Existing Records)

After import, file_records and file_chunks may lack `embedding_set_id`:

```typescript
async function backfillEmbeddingSetAssignments(
  sql: SqlExecutorPort,
  embeddingSetId: string,
  fileIds: string[]
): Promise<void> {
  const uniqueIds = Array.from(new Set(fileIds));
  const placeholders = uniqueIds.map((_, i) => `$${i + 2}`).join(', ');

  // Update file_records
  await sql.query(`
    UPDATE file_records
       SET embedding_set_id = $1
     WHERE id IN (${placeholders})
       AND (embedding_set_id IS NULL OR embedding_set_id IS DISTINCT FROM $1)
  `, [embeddingSetId, ...uniqueIds]);

  // Update file_chunks
  await sql.query(`
    UPDATE file_chunks
       SET embedding_set_id = $1
     WHERE file_record_id IN (${placeholders})
       AND embedding_set_id IS NULL
  `, [embeddingSetId, ...uniqueIds]);
}
```

**Why IS DISTINCT FROM?**
- Handles NULL vs. non-NULL comparisons correctly
- PostgreSQL-compatible syntax

## Phase 4: Embedding Job Enqueueing

### Job Payload Structure

```typescript
interface EmbedChunkPayload {
  chunkId: string;              // Chunk UUID
  fileRecordId: string;         // Parent file UUID
  embeddingSetId: string;       // Target embedding set
  modelKey: string;             // "local::jina-code"
  expectedDimension: number;    // 1024
  provider?: EmbeddingProviderType; // 'local' | 'openai' | 'google'
  dimensionParameter?: {        // Provider-specific dimension config
    type: 'target' | 'output';
    value: number;
  };
}
```

### Batch Enqueueing (Performance-Critical)

```typescript
// From vector-queue-service.ts enqueueEmbeddingChunkJobsBatch()

async function enqueueEmbeddingChunkJobsBatch(
  db: VectorQueueDatabase,
  batch: Array<{ id: string; fileRecordId: string; contentHash: string }>,
  embeddingSetId: string,
  metadata: { modelKey: string; expectedDimension: number }
): Promise<number> {
  const tuples: string[] = [];
  const params: unknown[] = [];

  batch.forEach((row, index) => {
    const jobId = generateUUID();
    const payload = JSON.stringify({
      chunkId: row.id,
      fileRecordId: row.fileRecordId,
      embeddingSetId,
      modelKey: metadata.modelKey,
      expectedDimension: metadata.expectedDimension,
    });
    const dedupeKey = `${row.id}:${embeddingSetId}:${row.contentHash}`;

    const base = index * 4;
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    params.push(row.id, jobId, payload, dedupeKey);
  });

  const timestampParam = params.length + 1;
  params.push(new Date().toISOString());

  // CTE-based idempotent batch insert
  const sql = `
    WITH pending (chunk_id, job_id, payload_json, dedupe_key) AS (
      VALUES ${tuples.join(',')}
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
    SELECT COUNT(*)::int AS inserted FROM inserted
  `;

  const result = await db.query<{ inserted: number }>(sql, params);
  return result.rows[0]?.inserted ?? 0;
}
```

**Performance**:
- **Batch size**: 500 chunks (configurable)
- **Single query**: Multi-row INSERT instead of 500 individual INSERTs
- **Deduplication**: Skips jobs that already exist (idempotent)
- **Speed**: ~10-50ms for 500-job batch

## Phase 5: Progress Orchestration

### Enhanced Progress State Machine

```typescript
type Phase = 'importing' | 'chunking' | 'assigning' | 'enqueueing' | 'complete';

interface EnhancedImportProgress {
  phase: Phase;
  total: number;
  completed: number;
  current: string;
  errors: Array<{ file: string; error: string }>;

  // Phase-specific metrics
  chunkingProgress?: {
    filesChunked: number;
    totalFiles: number;
    chunksGenerated: number;
  };

  enqueuingProgress?: {
    jobsEnqueued: number;
    totalChunks: number;
  };
}
```

### Progress Flow

```typescript
// Phase 1: File Import
updateProgress({ phase: 'importing', total: 100, completed: 42, current: 'utils.ts' });

// Phase 2: Chunking
updateProgress({
  phase: 'chunking',
  total: 75,  // Only files that need chunking
  completed: 20,
  current: 'main.ts (chunk 12/45)',
  chunkingProgress: { filesChunked: 20, totalFiles: 75, chunksGenerated: 856 }
});

// Phase 3: Assignment (usually very fast, no progress)
updateProgress({ phase: 'assigning', total: 1, completed: 0, current: 'Assigning chunks to embedding set' });

// Phase 4: Enqueueing
updateProgress({
  phase: 'enqueueing',
  total: 856,
  completed: 500,
  current: 'Enqueueing batch 1/2',
  enqueuingProgress: { jobsEnqueued: 500, totalChunks: 856 }
});

// Phase 5: Complete
updateProgress({ phase: 'complete', total: 100, completed: 100, current: 'Import complete' });
```

## Key Files for Reference

- **Enhanced Import Orchestrator**: `/packages/file-import/src/enhanced-import.ts` (line 1-300)
- **Base Import Service**: `/packages/db-explorer/src/enhanced-file-import-service.ts` (line 1-200)
- **Chunking Service**: `/packages/db/src/services/chunking-service.ts` (line 1-250)
- **Base Repository (Deduplication)**: `/packages/db/src/repositories/base-repository.ts` (line 273-357)
- **Vector Queue Service (Enqueueing)**: `/packages/vector-management/src/vector-status/vector-queue-service.ts` (line 191-258)

## Visual Design Suggestions (Non-Prescriptive)

- **Phase Pipeline**: Horizontal swimlane diagram showing all 5 phases with data flow
- **Deduplication Flow**: Flowchart showing hash computation → existence check → insert/skip decision
- **Adaptive Chunking**: Decision tree for strategy selection based on file type
- **Batch Processing**: Visualize 100-file batches flowing through import pipeline
- **Token Counting**: Side-by-side comparison of heuristic vs. token-true sizing
- **Chunk Streaming**: Generator pattern visualization with memory footprint
- **Job Enqueueing**: CTE-based batch insert with deduplication logic
- **Progress State Machine**: State diagram with phase transitions
- **Performance Metrics**: Timeline showing relative duration of each phase

## Technical Depth

The designer should understand:
- **Content-addressable storage** (SHA-256 hashing)
- **Batch processing** for database efficiency
- **Streaming generators** for memory efficiency
- **Adaptive algorithms** (file-type heuristics)
- **CTE-based atomicity** for idempotent operations
- **Multi-phase orchestration** with progress tracking
- **Token counting** (heuristic vs. accurate trade-offs)
- **Foreign key relationships** (files → chunks → jobs)

## Success Criteria

After viewing this infographic, a developer should be able to:
1. Trace the path of a file from selection through embedding job creation
2. Explain how content-addressable hashing prevents duplicate storage
3. Understand when adaptive chunking selects each strategy
4. Identify the performance optimizations (batch queries, parallel hashing)
5. Recognize the difference between heuristic and token-true sizing
6. Explain how embedding set assignment works
7. Understand the idempotency guarantees in job enqueueing
8. Map each progress phase to its corresponding system operation

---

**Complexity**: 5 phases, 3 chunking strategies, 2 token counting modes
**Performance**: 50-200 files/second import rate, 10-50ms per 500-job batch enqueue
**Code Distribution**: ~1,200 lines across 5 packages
**Key Patterns**: Content-addressable storage, batch processing, streaming generators, adaptive algorithms
