# 7) Data Model (High-Level)

> High-level sketch based on `packages/db/src/schema/index.ts` and migrations. Confirm exact columns and constraints from `packages/db/src/migrations/*`.

```mermaid
erDiagram
  PROVIDER ||--o{ MODEL : offers
  FILE_RECORD ||--o{ FILE_CHUNK : splits
  EMBEDDING_SET ||--o{ FILE_CHUNK : assigns

  EMBEDDING_SET {
    uuid id PK
    string model_key
    string model_id
    int dimensions
    string distance
  }
  FILE_RECORD {
    uuid id PK
    string path
    string mime
    int size
    string content_hash
  }
  FILE_CHUNK {
    uuid id PK
    uuid file_record_id FK
    int idx
    text content
    vector embedding
    uuid embedding_set_id
  }
  JOB_QUEUE {
    uuid id PK
    string queue
    string job_type
    string state
    json payload
  }
  EMBEDDING_CACHE {
    uuid id PK
    string content_hash
    string model_key
    vector embedding
    int dimensions
  }
  TOKEN_CACHE {
    uuid id PK
    string file_path
    string content_hash
    int token_count
  }
  FILE_TOKEN_CACHE {
    int id PK
    string folder_id
    string file_path
    string content_hash
    int token_count
  }
  PROVIDER {
    string id PK
    string name
    bool is_enabled
  }
  MODEL {
    string id PK
    string provider_id FK
    string name
    json capabilities
  }
```

**Indices & Helpers**
- `file_chunks.embedding` is a dimensionless `VECTOR` column; dimension-specific indexes are created via expression casts (see `dimension-index-helpers.ts`).
- `embedding_sets.dimensions` is the source of truth for expected vector length.
- `job_queue.payload` references `chunkId` and `embeddingSetId` (no direct FK).
