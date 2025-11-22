# Infographic Design Brief: PGlite Database Schema Evolution & Migration System

## Context & Purpose

This infographic should visualize the complex evolution of BrainStrike's database schema over time, showing how a simple file storage system evolved into a sophisticated multi-model vector database with job queuing, chunking, and embedding support. The target audience includes developers, architects, and technical stakeholders who need to understand how the database schema adapts to new requirements while maintaining backward compatibility.

## System Overview

BrainStrike uses **PGlite** (a lightweight PostgreSQL implementation that runs in the browser via WASM) as its primary database. The schema has evolved through **11 distinct migrations**, each adding capabilities while preserving existing data. This is a **database-native approach** where all persistence, including job queues and vector embeddings, lives in SQL tables rather than external services.

## Core Architectural Patterns

### 1. Migration-Based Schema Evolution

The system uses a formal migration pattern where each schema change is versioned and reversible:

```typescript
export interface Migration {
  version: number;
  name: string;
  up: string;   // SQL to apply migration
  down: string; // SQL to roll back migration
}
```

Migrations run sequentially and are tracked in a `schema_migrations` table to prevent re-execution. This is similar to Rails migrations, Flyway, or Liquibase patterns.

### 2. Repository Pattern with Shared Base Class

All database operations go through **Repository classes** that abstract SQL generation:

```typescript
// Abstract base with shared logic
export abstract class BaseFileRecordRepository implements IFileRecordRepository {
  protected readonly tableName = 'file_records';

  constructor(protected db: IDatabase) {}

  // Field name mapping: camelCase (TypeScript) ↔ snake_case (SQL)
  protected toDbField(field: string): string {
    // 'createdAt' → 'created_at'
    // 'embeddingSetId' → 'embedding_set_id'
  }

  // Row mapping: database row → domain model
  protected fromRow(row: Record<string, unknown>): FileRecord {
    // Handle nullable fields, type conversions
  }
}
```

This pattern keeps SQL isolated and testable, with platform-specific subclasses for web vs. Electron IPC.

## The Migration Timeline: From Simple to Sophisticated

### Migration 001: Initial Schema (The Foundation)

**Purpose**: Basic file metadata storage

```sql
CREATE TABLE file_records (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Query optimization indexes
CREATE INDEX idx_file_records_path ON file_records(path);
CREATE INDEX idx_file_records_name ON file_records(name);
CREATE INDEX idx_file_records_updated_at ON file_records(updated_at);
```

**Key Concepts**:
- TEXT primary keys (UUIDs stored as strings for portability)
- ISO timestamp strings (easier cross-platform than native TIMESTAMP)
- Indexes on common query patterns (path lookups, name searches, recent files)

### Migration 002: Vector Support

**Purpose**: Add embedding storage directly in file_records

```sql
ALTER TABLE file_records
  ADD COLUMN embedding REAL[],      -- pgvector array type
  ADD COLUMN embedding_hash TEXT;   -- Prevent re-computation
```

**Design Decision**: Initially, embeddings were stored directly on file records. This was later superseded by per-chunk embeddings, but the column remains for backward compatibility.

### Migration 003: Performance Indexes

**Purpose**: Optimize common queries

```sql
CREATE INDEX idx_file_records_content_hash ON file_records(content_hash);
CREATE INDEX idx_file_records_processed_at ON file_records(processed_at);
```

**Performance Implications**: Content hash index enables O(1) deduplication lookups in bulk imports.

### Migration 004: Chunking Support (Major Architecture Shift)

**Purpose**: Split large files into smaller chunks for better embedding quality

```sql
CREATE TABLE file_chunks (
  id TEXT PRIMARY KEY,
  file_record_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  created_at TEXT NOT NULL,

  FOREIGN KEY (file_record_id) REFERENCES file_records(id) ON DELETE CASCADE
);

CREATE INDEX idx_file_chunks_file ON file_chunks(file_record_id);
CREATE INDEX idx_file_chunks_index ON file_chunks(file_record_id, chunk_index);
```

**Key Relationships**:
- 1 file_record → N file_chunks (one-to-many)
- Chunks preserve order via `chunk_index`
- Offsets allow reconstruction of original positions

**Why Chunking?**
- Embedding models have token limits (e.g., 512, 1024, 8192 tokens)
- Smaller chunks = better semantic granularity
- Enable paragraph/section-level search

### Migration 006: Multi-Model Embedding Sets (Paradigm Shift)

**Purpose**: Support multiple embedding models simultaneously

```sql
CREATE TABLE embedding_sets (
  id TEXT PRIMARY KEY,
  model_key TEXT NOT NULL,        -- 'openai', 'local', 'cohere'
  model_id TEXT NOT NULL,         -- 'text-embedding-3-small'
  dimensions INTEGER NOT NULL,    -- 384, 1024, 1536, 3072
  distance TEXT NOT NULL CHECK (distance IN ('cosine','l2','ip')),
  created_at TEXT NOT NULL
);

ALTER TABLE file_chunks
  ADD COLUMN embedding_set_id TEXT,
  ADD COLUMN embedding_updated_at TEXT,
  ADD COLUMN embedding_hash TEXT,
  ADD COLUMN embedding REAL[];  -- Now per-chunk, not per-file

CREATE INDEX idx_file_chunks_set ON file_chunks(embedding_set_id);
CREATE INDEX idx_file_chunks_embedhash ON file_chunks(embedding_hash);
```

**Critical Design**:
- **Multi-tenancy for models**: The same chunk can have different embeddings for different models
- **Dimension safety**: Prevents mixing 1024-dim and 1536-dim vectors
- **Distance metric tracking**: Cosine similarity vs. L2 Euclidean vs. Inner Product
- **Embedding hash**: Deduplication key prevents recomputing identical text

**Data Flow**:
```
1. User selects "OpenAI text-embedding-3-small" (1536 dimensions, cosine)
2. System creates embedding_set record
3. File chunks get embedding_set_id assignment
4. Each chunk stores its embedding[] with this set
5. Later, user can add "Cohere embed-multilingual-v3" (1024 dimensions, l2)
6. Same chunks get NEW embeddings for the new set
```

### Migration 007: Job Queue (Async Processing Infrastructure)

**Purpose**: Background processing with retries, leasing, and deduplication

```sql
CREATE TABLE job_queue (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,                    -- 'embeddings', 'exports'
  job_type TEXT NOT NULL,                 -- 'embed', 'chunk'
  payload JSONB,                          -- Task-specific data

  -- State machine
  state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','canceled','expired'))
        DEFAULT 'queued',

  -- Scheduling
  run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  backoff_ms INTEGER NOT NULL DEFAULT 0,

  -- Leasing (distributed worker safety)
  lease_token TEXT,
  leased_until TEXT,
  worker_id TEXT,

  -- Idempotency
  dedupe_key TEXT,

  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CRITICAL: Partial unique index for active deduplication
CREATE UNIQUE INDEX idx_job_queue_dedupe_active
  ON job_queue(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');

CREATE INDEX idx_job_queue_scheduling ON job_queue(queue, state, run_at);
CREATE INDEX idx_job_queue_lease ON job_queue(state, leased_until);
```

**Advanced Concepts**:

1. **Lease-Based Claiming** (Prevents double-processing):
   ```
   Worker A claims job 123 with lease_token='uuid-a', leased_until='2025-01-22T10:05:00Z'
   Worker B tries to claim job 123 → sees lease is active → skips
   Worker A crashes → lease expires → Worker B can claim
   ```

2. **Exponential Backoff**:
   ```
   Attempt 1: Run immediately (backoff_ms = 0)
   Attempt 2: Wait 1s × 2^1 = 2s
   Attempt 3: Wait 1s × 2^2 = 4s
   Attempt 4: Wait 1s × 2^3 = 8s
   Attempt 5: Wait 1s × 2^4 = 16s (max 5min cap)
   ```

3. **Deduplication Key**:
   ```typescript
   // Example: Don't re-enqueue same chunk for same embedding set
   dedupe_key = `chunk:${chunkId}:set:${embeddingSetId}:hash:${contentHash}`
   ```
   The partial unique index ensures only ONE active job exists per dedupe_key.

### Migration 011: User-Facing Metadata

**Purpose**: Allow users to name, describe, and tag embedding sets

```sql
ALTER TABLE embedding_sets
  ADD COLUMN name TEXT,
  ADD COLUMN description TEXT,
  ADD COLUMN tags TEXT[];  -- PostgreSQL array for tagging
```

**UI Impact**: Users see "My Code Embeddings" instead of "openai:text-embedding-3-small:default".

## Complex Data Flows to Visualize

### Bulk Import Pipeline (4-Step Process)

The `bulkImport()` method is performance-critical:

```typescript
async bulkImport(
  requests: FileImportRequest[],
  onProgress?: (completed: number, total: number, current?: string) => void
): Promise<FileImportResult[]>
```

**Step-by-step**:

1. **Parallel Hash Computation**:
   ```typescript
   const hashPromises = batch.map(async (request) => ({
     request,
     hash: await generateContentHash(request.content)  // SHA-256
   }));
   const hashResults = await Promise.all(hashPromises);
   ```

2. **Batch Existence Check** (Single Query!):
   ```sql
   SELECT * FROM file_records
   WHERE content_hash IN ($1, $2, $3, ..., $100);
   ```
   Returns existing records in one database round-trip.

3. **Deduplication Map Building**:
   ```typescript
   const dedupeKey = `${contentHash}::${embeddingSetId || '__default__'}`;
   const existingMap = new Map<string, FileRecord>();
   // Same content can exist in different embedding sets
   ```

4. **Batch Insert** (Multi-Row VALUES):
   ```sql
   INSERT INTO file_records (id, name, path, size, content, content_hash, ...)
   VALUES
     ($1, $2, $3, $4, $5, $6, ...),
     ($101, $102, $103, $104, $105, $106, ...),
     ($201, $202, $203, $204, $205, $206, ...);
   ```

**Performance Numbers**:
- Batch size: 100 files
- Typical import speed: 50-200 files/second
- Deduplication overhead: ~10-20ms per 100 files

### Schema Relationships (Entity Relationship Diagram)

```
embedding_sets (1) ─────────┐
                            │
                            │ FK: embedding_set_id
                            ▼
file_records (1) ────────► file_chunks (N)
                            │
                            │ embedding[] stored here
                            ▼
                      [Embedding Worker]
                            │
                            ▼
                       job_queue
```

**Key Relationships**:
- `file_records.id` ← `file_chunks.file_record_id` (CASCADE DELETE)
- `embedding_sets.id` ← `file_chunks.embedding_set_id` (NULL on delete)
- `file_chunks` can have multiple embeddings for different sets

## Performance-Critical Indexes

```sql
-- Deduplication (O(1) lookups)
CREATE INDEX idx_file_records_content_hash ON file_records(content_hash);
CREATE INDEX idx_file_chunks_embedhash ON file_chunks(embedding_hash);

-- Job queue scheduling (composite index)
CREATE INDEX idx_job_queue_scheduling ON job_queue(queue, state, run_at);
-- Enables: WHERE queue = 'embeddings' AND state = 'queued' AND run_at <= NOW()

-- Unique constraint for idempotency
CREATE UNIQUE INDEX idx_job_queue_dedupe_active
  ON job_queue(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');
-- Only indexes active jobs to allow duplicate dedupe_keys in succeeded/failed
```

## Cross-Platform Considerations

### Why TEXT timestamps instead of TIMESTAMP?

```typescript
// Portable ISO strings work everywhere
createdAt: "2025-01-22T09:30:45.123Z"

// vs. Native timestamps with timezone complexity
created_at: TIMESTAMP WITH TIME ZONE
```

PGlite runs in browsers (WASM), Node.js, and Electron. ISO strings serialize cleanly to JSON and work identically across all platforms.

### Why snake_case columns with camelCase models?

```typescript
// TypeScript domain model (idiomatic JavaScript)
interface FileRecord {
  embeddingSetId?: string;
  createdAt: string;
}

// SQL database (idiomatic PostgreSQL)
CREATE TABLE file_records (
  embedding_set_id TEXT,
  created_at TEXT
);

// Repository handles mapping
protected toDbField(field: string): string {
  if (field === 'embeddingSetId') return 'embedding_set_id';
  if (field === 'createdAt') return 'created_at';
  return field;
}
```

This maintains conventions in each layer while providing clean abstractions.

## Transaction Support (Where Available)

```typescript
const batchResults = this.db.transaction
  ? await this.db.transaction(async (tx: IDatabase) => {
      return await this.processBatch(batch, tx, onProgress);
    })
  : await this.processBatch(batch, this.db, onProgress);
```

**Design Pattern**: Graceful degradation
- In full PGlite: Use transactions for atomicity
- In limited environments: Fall back to sequential operations
- Interface remains identical

## Token Counting Strategies

```typescript
// Fast heuristic (used in bulk import)
private countTokensHeuristic(content: string): number {
  return Math.ceil(content.length / 4);  // ~4 chars per token
}

// Accurate counting (used in chunking)
import { countTokens } from '@anthropic-ai/tokenizer';
const exactCount = countTokens(content);
```

**Trade-off**: Heuristic is 100x faster but ±20% accurate. Exact counting uses tokenizer but adds latency.

## Key Files for Reference

- **Migrations**: `/packages/db/src/migrations/*.ts`
- **Base Repository**: `/packages/db/src/repositories/base-repository.ts` (line 27-555)
- **Models**: `/packages/db/src/models/file-record.ts`, `embedding-set.ts`, `job.ts`
- **Migration Runner**: `/packages/db/src/migrations/migration-runner.ts`

## Visual Design Suggestions (Non-Prescriptive)

- Show migration timeline as a **vertical evolution** with schema changes highlighted at each step
- Use **color coding** for different concerns: green for schema structure, blue for indexes, orange for relationships
- Visualize the **bulk import pipeline** as a flowchart with timing annotations
- Create an **entity relationship diagram** showing FK relationships with cardinality (1:N)
- Illustrate the **deduplication map** as a hash table with collision handling
- Show **state transitions** for the job queue as a state machine diagram
- Include **code snippets** directly in the infographic for key SQL patterns
- Use **animated sequences** to show how a file flows from import → chunking → embedding → storage
- Highlight **performance critical paths** with metrics (files/sec, query counts)

## Technical Depth

The designer should understand:
- Database normalization (why chunks are separate from files)
- Index strategies (B-tree vs. partial unique indexes)
- Eventual consistency (job queue processing)
- Content-addressable storage (hash-based deduplication)
- Vector similarity search (why dimensions and distance metrics matter)

## Success Criteria

After viewing this infographic, a developer should be able to:
1. Explain why embeddings are stored per-chunk rather than per-file
2. Understand how the system prevents duplicate job enqueueing
3. Trace the path of a file from import through embedding generation
4. Identify the performance-critical indexes and why they exist
5. Recognize the trade-offs between transaction support and cross-platform compatibility

---

**File Count**: ~15 migration files, ~8 repository classes, ~5 model interfaces
**Total Schema Complexity**: 4 tables, 15+ indexes, 3 foreign keys, 100+ fields
**Lines of Migration SQL**: ~500 lines
**Repository Logic**: ~2,000 lines of TypeScript
