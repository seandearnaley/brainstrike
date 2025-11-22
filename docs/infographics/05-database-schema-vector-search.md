# Infographic Design Brief: Database Schema & Vector Search Architecture

## Context

BrainStrike stores code files, text chunks, and high-dimensional vector embeddings in a PGlite database (PostgreSQL compiled to WebAssembly). The database enables:
- File and chunk metadata storage
- Vector embeddings for semantic search
- Fast similarity queries via pgvector extension
- Multi-model support (different embedding dimensions)
- Transactional consistency

## Database Technology: PGlite

**PGlite** = PostgreSQL running in the browser via WebAssembly

**Why PGlite?**
- ✅ Full PostgreSQL compatibility
- ✅ Runs in browser (no server required)
- ✅ Supports pgvector extension (vector similarity search)
- ✅ ACID transactions
- ✅ Persistent storage (IndexedDB)
- ✅ ~3MB WASM bundle (reasonable size)

**Comparison**:
```
SQLite:      Great, but no native vector support
Postgres:    Perfect, but requires server
PGlite:      PostgreSQL in browser! Best of both worlds
```

## Database Schema

### Core Tables

```
┌─────────────────┐
│ embedding_sets  │  (Collections/Models)
└────────┬────────┘
         │ 1:N
         │
┌────────▼────────┐
│  file_records   │  (Files)
└────────┬────────┘
         │ 1:N
         │
┌────────▼────────┐
│  file_chunks    │  (Text chunks with embeddings)
└─────────────────┘

┌─────────────────┐
│   job_queue     │  (Background jobs)
└─────────────────┘
```

### 1. embedding_sets

**Purpose**: Track different embedding models/collections

```sql
CREATE TABLE embedding_sets (
  id                TEXT PRIMARY KEY,           -- UUID
  name              TEXT NOT NULL UNIQUE,       -- "Default Collection", "Code Only"
  model_id          TEXT NOT NULL,              -- "BAAI/bge-m3", "text-embedding-3-small"
  dimensions        INTEGER NOT NULL,           -- 768, 1024, 1536, 3072
  distance          TEXT NOT NULL DEFAULT 'cosine', -- 'cosine', 'l2', 'ip'
  provider          TEXT,                       -- 'local', 'openai', 'google'
  is_active         BOOLEAN NOT NULL DEFAULT false,
  allow_duplicates  BOOLEAN NOT NULL DEFAULT false,
  metadata          TEXT,                       -- JSON: { description, tags, ... }
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_embedding_sets_active ON embedding_sets(is_active) WHERE is_active = true;
```

**Key Fields**:
- **dimensions**: Critical for pgvector - MUST match embedding size
- **distance**: Similarity metric - cosine (default), L2, inner product
- **is_active**: Only one active set at a time (for UI selection)
- **allow_duplicates**: Whether to allow same file in multiple sets

**Example Rows**:
```json
{
  "id": "set-001",
  "name": "Default (BGE-M3 1024D)",
  "model_id": "BAAI/bge-m3",
  "dimensions": 1024,
  "distance": "cosine",
  "provider": "local",
  "is_active": true
}
```

### 2. file_records

**Purpose**: Store metadata about imported files

```sql
CREATE TABLE file_records (
  id                TEXT PRIMARY KEY,           -- UUID
  name              TEXT NOT NULL,              -- "auth.ts"
  path              TEXT NOT NULL UNIQUE,       -- "/src/utils/auth.ts" (full path)
  size              INTEGER NOT NULL,           -- File size in bytes
  embedding_set_id  TEXT REFERENCES embedding_sets(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_file_records_path ON file_records(path);
CREATE INDEX idx_file_records_name ON file_records(name);
CREATE INDEX idx_file_records_updated_at ON file_records(updated_at);
CREATE INDEX idx_file_records_embedding_set ON file_records(embedding_set_id);
```

**Key Details**:
- `path` is UNIQUE: Re-importing same file updates existing record
- `embedding_set_id`: Which collection this file belongs to
- Indexes on path, name, updated_at for fast queries

### 3. file_chunks

**Purpose**: Store text chunks and their vector embeddings

```sql
CREATE TABLE file_chunks (
  id                    TEXT PRIMARY KEY,       -- "${fileRecordId}_chunk_${index}"
  file_record_id        TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  chunk_index           INTEGER NOT NULL,       -- 0, 1, 2, ... (position in file)
  content               TEXT NOT NULL,          -- The actual text chunk
  content_hash          TEXT NOT NULL,          -- SHA-256 of content
  token_count           INTEGER NOT NULL,       -- Estimated token count
  chunk_type            TEXT NOT NULL,          -- 'text', 'code', 'sentence', 'recursive'
  chunk_size            INTEGER NOT NULL,       -- Max tokens setting used

  -- Embedding columns (Phase 2: Multi-model support)
  embedding             vector(1024),           -- pgvector type - 1024D default
  embedding_set_id      TEXT REFERENCES embedding_sets(id) ON DELETE SET NULL,
  embedding_updated_at  TEXT,                   -- When embedding was generated
  embedding_hash        TEXT,                   -- SHA-256(content_hash + model_key) - idempotency

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,

  UNIQUE(file_record_id, chunk_index)
);

-- Indexes
CREATE INDEX idx_file_chunks_file_record ON file_chunks(file_record_id);
CREATE INDEX idx_file_chunks_embedding_set ON file_chunks(embedding_set_id);
CREATE INDEX idx_file_chunks_content_hash ON file_chunks(content_hash);
CREATE INDEX idx_file_chunks_embedding_hash ON file_chunks(embedding_hash);

-- Vector index for fast similarity search (HNSW)
CREATE INDEX ON file_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
```

**Key Fields**:

**embedding**: `vector(1024)` type from pgvector extension
- Stores high-dimensional vector (array of floats)
- Default dimension: 1024 (configurable per model)
- Can be NULL (chunk not yet embedded)

**embedding_hash**: Idempotency key
- Format: `SHA256(content_hash + ":" + model_key)`
- Prevents re-embedding when content and model unchanged
- Example: If content hash is `abc123` and model is `BAAI/bge-m3`, hash is `SHA256("abc123:BAAI/bge-m3")`

**chunk_type**: Strategy used for chunking
- `'sentence'`: Split by sentences
- `'recursive'`: Code-aware splitting
- `'text'`: Generic text splitting

### 4. Vector Index (HNSW)

**HNSW = Hierarchical Navigable Small World**

```sql
CREATE INDEX idx_file_chunks_embedding_hnsw
  ON file_chunks
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
```

**How HNSW Works**:
```
High-dimensional space → Graph structure → Nearest neighbor search in O(log N)

Traditional scan: O(N) - check every vector
HNSW index:      O(log N) - navigate graph
```

**Index Parameters** (tunable):
```sql
-- Build-time parameter
CREATE INDEX ... WITH (m = 16);              -- Connections per node (default: 16)

-- Query-time parameter
SET hnsw.ef_search = 100;                    -- Search effort (default: 40)
```

**Trade-offs**:
- Higher `m`: Better recall, larger index, slower build
- Higher `ef_search`: Better accuracy, slower queries

## Vector Similarity Metrics

### 1. Cosine Similarity (Default)

**Formula**: `1 - (A · B) / (||A|| * ||B||)`

```
Score: -1 to 1 (higher = more similar)

Example:
A = [0.5, 0.5, 0.5, 0.5]
B = [0.7, 0.3, 0.5, 0.5]

Cosine similarity ≈ 0.95 (very similar)
```

**When to use**: Most embedding models (default for semantic search)

**pgvector operator**: `<=>` (cosine distance)
```sql
SELECT * FROM file_chunks
ORDER BY embedding <=> $1::vector
LIMIT 10;
```

### 2. L2 Distance (Euclidean)

**Formula**: `sqrt(Σ(A_i - B_i)²)`

```
Score: 0 to ∞ (lower = more similar)

Example:
A = [1, 2, 3]
B = [4, 5, 6]

L2 distance = sqrt((1-4)² + (2-5)² + (3-6)²) = sqrt(27) ≈ 5.2
```

**When to use**: Image embeddings, certain embedding models

**pgvector operator**: `<->` (L2 distance)
```sql
SELECT * FROM file_chunks
ORDER BY embedding <-> $1::vector
LIMIT 10;
```

### 3. Inner Product (Dot Product)

**Formula**: `A · B = Σ(A_i * B_i)`

```
Score: -∞ to ∞ (higher = more similar)

Example:
A = [1, 2, 3]
B = [4, 5, 6]

Inner product = 1*4 + 2*5 + 3*6 = 32
```

**When to use**: Pre-normalized embeddings, certain recommender systems

**pgvector operator**: `<#>` (negative inner product - for ORDER BY ASC)
```sql
SELECT * FROM file_chunks
ORDER BY embedding <#> $1::vector
LIMIT 10;
```

## Database Migrations

BrainStrike uses a migration system to evolve the schema:

### Migration 001: Initial Schema

```sql
-- migration-001-initial-schema.ts
CREATE TABLE file_records (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_file_records_path ON file_records(path);
```

### Migration 002: Add Vector Columns

```sql
-- migration-002-add-vector-columns.ts
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE file_chunks ADD COLUMN embedding vector(768);
```

### Migration 006: Embedding Sets Support

```sql
-- migration-006-embedding-sets-and-columns.ts
CREATE TABLE embedding_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  distance TEXT NOT NULL DEFAULT 'cosine',
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE file_chunks ADD COLUMN embedding_set_id TEXT REFERENCES embedding_sets(id);
ALTER TABLE file_chunks ADD COLUMN embedding_updated_at TEXT;
ALTER TABLE file_chunks ADD COLUMN embedding_hash TEXT;
```

### Migration 010: Flexible Embedding Dimensions

```sql
-- migration-010-flexible-embedding-dimensions.ts
-- Drop old fixed-dimension index
DROP INDEX IF EXISTS idx_file_chunks_embedding_hnsw;

-- Recreate with dynamic dimensions based on embedding_set
-- pgvector requires creating separate indexes for each dimension

CREATE OR REPLACE FUNCTION create_embedding_index_for_dimension(dim INTEGER)
RETURNS void AS $$
BEGIN
  EXECUTE format('
    CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding_hnsw_%s
      ON file_chunks
      USING hnsw ((embedding::vector(%s)) vector_cosine_ops)
      WHERE embedding IS NOT NULL
        AND embedding_set_id IN (
          SELECT id FROM embedding_sets WHERE dimensions = %s
        )
  ', dim, dim, dim);
END;
$$ LANGUAGE plpgsql;
```

## Vector Search Implementation

### Repository Layer

```typescript
// packages/db/src/repositories/file-chunk-repository.ts

class FileChunkRepository {
  async searchSimilar(
    queryEmbedding: number[],
    options: ChunkSearchOptions = {}
  ): Promise<ChunkSearchResult[]> {
    const {
      limit = 10,
      threshold = 0.5,       // Minimum similarity score
      fileRecordId,          // Optional: filter by file
      chunkType,             // Optional: filter by chunk type
      embeddingSetId,        // Required: which model/collection
    } = options;

    // 1. Validate embedding set
    if (!embeddingSetId) {
      throw new Error('embeddingSetId required to avoid dimension mismatch');
    }

    // 2. Resolve distance metric and dimension
    const { similarityExpr, orderExpr } = await this.resolveDistanceConfig(
      embeddingSetId,
      queryEmbedding
    );

    // 3. Prepare query parameters
    const vectorParam = `[${queryEmbedding.join(',')}]`;
    const params: unknown[] = [vectorParam];
    let paramIndex = 2;
    const whereParts = ['embedding IS NOT NULL'];

    // 4. Apply filters
    if (fileRecordId) {
      whereParts.push(`file_record_id = $${paramIndex}`);
      params.push(fileRecordId);
      paramIndex += 1;
    }

    if (chunkType) {
      whereParts.push(`chunk_type = $${paramIndex}`);
      params.push(chunkType);
      paramIndex += 1;
    }

    whereParts.push(`embedding_set_id = $${paramIndex}`);
    params.push(embeddingSetId);
    paramIndex += 1;

    // 5. Tune HNSW parameters (optional)
    try {
      await this.db.query(`SET LOCAL hnsw.ef_search = 100`);
    } catch {
      // Ignore if HNSW not available
    }

    // 6. Execute similarity search
    const overfetchLimit = Math.max(limit * 10, 100);
    const result = await this.db.query(`
      SELECT *,
        ${similarityExpr} as similarity,
        ROW_NUMBER() OVER (ORDER BY ${orderExpr}) as rank
      FROM file_chunks
      WHERE ${whereParts.join(' AND ')}
      ORDER BY ${orderExpr}
      LIMIT $${paramIndex}
    `, [...params, overfetchLimit]);

    // 7. Map results and apply threshold
    const mapped = result.rows.map((row) => ({
      chunk: this.mapRowToChunk(row),
      similarity: parseFloat(row.similarity),
      rank: parseInt(row.rank, 10),
    }));

    // 8. Filter by threshold and limit
    const filtered = mapped.filter(r =>
      Number.isFinite(r.similarity) && r.similarity >= threshold
    );

    return filtered.slice(0, limit);
  }

  private async resolveDistanceConfig(
    embeddingSetId: string,
    queryEmbedding: number[]
  ): Promise<{ similarityExpr: string; orderExpr: string }> {
    // Load embedding set config
    const setRes = await this.db.query(`
      SELECT distance, dimensions FROM embedding_sets WHERE id = $1
    `, [embeddingSetId]);

    const setRow = setRes.rows[0];
    if (!setRow) {
      throw new Error(`Embedding set ${embeddingSetId} not found`);
    }

    const expectedDimension = Number(setRow.dimensions);
    if (!Number.isFinite(expectedDimension) || expectedDimension <= 0) {
      throw new Error(`Invalid dimension for set ${embeddingSetId}`);
    }

    // Validate query embedding dimension
    if (queryEmbedding.length !== expectedDimension) {
      throw new Error(
        `Query embedding dimension mismatch: ` +
        `received ${queryEmbedding.length}, expected ${expectedDimension}`
      );
    }

    const distance = (setRow.distance || 'cosine') as 'cosine' | 'l2' | 'ip';

    // Build distance expressions
    return this.buildDistanceExpressions(distance);
  }

  private buildDistanceExpressions(distance: 'cosine' | 'l2' | 'ip'): {
    similarityExpr: string;
    orderExpr: string;
  } {
    switch (distance) {
      case 'l2':
        return {
          // Convert L2 distance to similarity (0-1 range)
          similarityExpr: '(1.0 / (1.0 + (embedding <-> $1::vector)))',
          orderExpr: 'embedding <-> $1::vector',  // ASC (lower = better)
        };

      case 'ip':
        return {
          // Convert inner product to similarity
          similarityExpr: '(1.0 / (1.0 + exp(+(embedding <#> $1::vector))))',
          orderExpr: 'embedding <#> $1::vector',  // ASC (negative inner product)
        };

      case 'cosine':
      default:
        return {
          // Cosine similarity: 1 - (distance / 2)
          // pgvector cosine distance: 0 to 2
          // Convert to similarity: 0 to 1
          similarityExpr: '(1 - ((embedding <=> $1::vector) / 2.0))',
          orderExpr: 'embedding <=> $1::vector',  // ASC (lower distance = higher similarity)
        };
    }
  }
}
```

### Search Query Example

**User Query**: "JWT authentication logic"

**Step 1: Embed Query**
```typescript
const queryText = "JWT authentication logic";
const embeddingService = new SimpleEmbeddingService();
const queryResult = await embeddingService.generateEmbedding(queryText);
const queryEmbedding = queryResult.embedding; // [0.123, -0.456, ...]
```

**Step 2: Search Similar Chunks**
```typescript
const chunkRepo = new FileChunkRepository(db);
const results = await chunkRepo.searchSimilar(queryEmbedding, {
  limit: 5,
  threshold: 0.7,              // Only > 70% similarity
  embeddingSetId: 'set-001',   // Active embedding set
});
```

**Step 3: Results**
```typescript
[
  {
    chunk: {
      id: "file-123_chunk_5",
      content: "export function verifyJWT(token: string) { ... }",
      path: "/src/auth/jwt.ts",
      chunkIndex: 5,
    },
    similarity: 0.92,
    rank: 1,
  },
  {
    chunk: {
      id: "file-456_chunk_12",
      content: "// JWT token validation middleware ...",
      path: "/src/middleware/auth.ts",
      chunkIndex: 12,
    },
    similarity: 0.85,
    rank: 2,
  },
  // ... more results
]
```

## Dimension Validation

Critical safety check to prevent pgvector crashes:

```typescript
async function validateEmbeddingDimension(
  db: Queryable,
  embedding: number[] | undefined,
  context: { embeddingSetId: string | null }
): Promise<void> {
  if (!embedding) return; // No embedding to validate

  // 1. Resolve expected dimension from embedding set
  const embeddingSetId = context.embeddingSetId;
  if (!embeddingSetId) {
    throw new Error('embeddingSetId required for dimension validation');
  }

  const result = await db.query(
    'SELECT dimensions FROM embedding_sets WHERE id = $1',
    [embeddingSetId]
  );

  const expectedDim = Number(result.rows[0]?.dimensions);
  if (!Number.isFinite(expectedDim) || expectedDim <= 0) {
    throw new Error(`Invalid dimension for set ${embeddingSetId}`);
  }

  // 2. Validate actual embedding dimension
  if (embedding.length !== expectedDim) {
    throw new Error(
      `Embedding dimension mismatch: ` +
      `received ${embedding.length}, expected ${expectedDim} ` +
      `for embedding set ${embeddingSetId}`
    );
  }
}
```

**Why Critical?**: pgvector will crash the query if dimensions don't match:
```
ERROR: vector dimension mismatch
DETAIL: expected 1024, got 768
```

## Multi-Model Support

BrainStrike supports multiple embedding models with different dimensions:

```typescript
// Example: Switch between models
const sets = [
  {
    id: 'set-bge-m3',
    name: 'BGE-M3 (1024D)',
    modelId: 'BAAI/bge-m3',
    dimensions: 1024,
    provider: 'local',
  },
  {
    id: 'set-openai-small',
    name: 'OpenAI Small (1536D)',
    modelId: 'text-embedding-3-small',
    dimensions: 1536,
    provider: 'openai',
  },
  {
    id: 'set-openai-large',
    name: 'OpenAI Large (3072D)',
    modelId: 'text-embedding-3-large',
    dimensions: 3072,
    provider: 'openai',
  },
];

// Create embedding set
await embeddingSetRepo.create({
  id: generateUUID(),
  name: 'Code Embeddings (BGE-M3)',
  modelId: 'BAAI/bge-m3',
  dimensions: 1024,
  distance: 'cosine',
  provider: 'local',
  isActive: true,
});

// Chunks reference embedding set
await chunkRepo.insert({
  ...chunk,
  embeddingSetId: 'set-bge-m3',
  embedding: embedding1024D, // Must be 1024 dimensions
});
```

## Performance Optimizations

### 1. Batch Operations

**Batch Insert Chunks**:
```typescript
async insertMany(chunks: FileChunkInsert[]): Promise<FileChunk[]> {
  const BatchSize = 250; // SQL parameter limit
  const batches = batchArray(chunks, BatchSize);

  await this.db.query('BEGIN');
  try {
    for (const batch of batches) {
      const values = batch.map((_, i) => {
        const base = i * 14;
        return `($${base + 1}, $${base + 2}, ..., $${base + 14})`;
      }).join(', ');

      const params = batch.flatMap(chunk => [
        chunk.id,
        chunk.fileRecordId,
        chunk.chunkIndex,
        chunk.content,
        // ... more fields
      ]);

      await this.db.query(`
        INSERT INTO file_chunks (...)
        VALUES ${values}
        ON CONFLICT (id) DO UPDATE SET ...
        RETURNING *
      `, params);
    }
    await this.db.query('COMMIT');
  } catch (error) {
    await this.db.query('ROLLBACK');
    throw error;
  }
}
```

### 2. Index Tuning

**HNSW Build Parameters**:
```sql
-- More connections = better recall, larger index
CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16);  -- Default: 16, Range: 2-100
```

**HNSW Search Parameters**:
```sql
-- Higher ef_search = better accuracy, slower queries
SET hnsw.ef_search = 100;  -- Default: 40, Range: 1-1000
```

**IVFFlat Parameters** (alternative to HNSW):
```sql
SET ivfflat.probes = 10;  -- Number of clusters to search
```

### 3. Query Optimization

**Overfetching + Threshold Filtering**:
```typescript
// Fetch 10x limit, then filter in JS
const overfetchLimit = Math.max(limit * 10, 100);

const result = await db.query(`
  SELECT *, (1 - (embedding <=> $1::vector) / 2.0) as similarity
  FROM file_chunks
  WHERE embedding IS NOT NULL
    AND embedding_set_id = $2
  ORDER BY embedding <=> $1::vector
  LIMIT $3
`, [vectorParam, embeddingSetId, overfetchLimit]);

// Filter by threshold in application code
const filtered = result.rows
  .map(row => ({ ...row, similarity: parseFloat(row.similarity) }))
  .filter(r => r.similarity >= threshold)
  .slice(0, limit);
```

**Why?**: pgvector distance operators don't support `WHERE similarity >= 0.7` directly.

## Visual Suggestion for Infographic

**Recommended Layout**:
- **Top Left**: Schema diagram (tables with relationships)
- **Top Right**: Vector space visualization (high-D → 2D projection)
- **Middle**: Search query flow (query embedding → similarity calculation → ranked results)
- **Bottom Left**: Distance metrics comparison (cosine vs L2 vs IP)
- **Bottom Right**: HNSW index structure

**Key Visual Elements**:
- Table relationships with foreign keys
- Vector as array of numbers: `[0.123, -0.456, 0.789, ...]`
- HNSW graph structure (hierarchical layers)
- Similarity scoring visualization (color gradient: red = low, green = high)
- Dimension validation checkpoint (error if mismatch)

**Complexity to Emphasize**:
- pgvector extension enabling vector operations in SQL
- Dimension validation (critical safety check)
- Multi-model support (different dimensions per embedding set)
- Distance metric selection (cosine, L2, inner product)
- HNSW index for O(log N) search
- Batch operations for performance
- ON CONFLICT for idempotent inserts

**Code Snippets to Highlight**:
- CREATE TABLE with vector column
- CREATE INDEX using HNSW
- Search query with similarity calculation
- Distance expression builders (cosine, L2, IP)
- Dimension validation logic

This schema provides a robust foundation for semantic code search with multi-model support and efficient vector similarity queries.
