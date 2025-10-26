# 7) Data Model (High-Level)

> High-level sketch inferred from migration filenames and repository names. Confirm exact columns and constraints from `packages/db/src/migrations/*`.

```mermaid
erDiagram
  EMBEDDING_SET ||--o{ FILE_RECORD : contains
  FILE_RECORD ||--o{ FILE_CHUNK : splits
  FILE_CHUNK ||--o{ EMBEDDING : embeds

  EMBEDDING_SET {
    uuid id PK
    string name
    int dimension
    json meta
  }
  FILE_RECORD {
    uuid id PK
    string path
    string mime
    json meta
  }
  FILE_CHUNK {
    uuid id PK
    uuid file_id FK
    int idx
    text content
  }
  EMBEDDING {
    uuid id PK
    uuid chunk_id FK
    vector vec
    json meta
  }
```

**Indices & Helpers**
- Vector index helpers (see `vector-index-helpers.ts`) likely manage `CREATE INDEX` and compatibility across dimensions.
- A migration called `010-flexible-embedding-dimensions.ts` implies schema supports multiple dimensions concurrently.
