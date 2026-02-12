---
title: Web App Overview
sidebar_position: 7
---

# Web App (Vite/React) Overview

## 5.1 Page/App Shell

```mermaid
flowchart TB
  subgraph App
    R[React Router] --> Layout[AppShell]
    Layout --> Home[Home Page]
    Layout --> Explore["DB Explorer\\n(packages/db-explorer)"]
    Layout --> Vectors["Vector Mgmt\\n(Vector Status + Collections)"]
    Layout --> Settings["Preferences\\n(embedding, import, providers)"]
  end

  Home --> ImportFlow[Import Flow]
  ImportFlow --> Queue["JobQueue (PGlite)"]
  Vectors --> Worker["Embedding Worker (renderer)"]
  Worker --> Queue
  Worker --> DB[(PGlite + pgvector)]
```

## 5.2 Homepage “Happy Path”

```mermaid
sequenceDiagram
  actor User
  participant UI as Home (Web)
  participant Import as Import UI
  participant V as Vector Status
  participant Q as JobQueue
  participant W as Embedding Worker
  participant DB as DB (PGlite + pgvector)

  User->>UI: Select folder
  UI->>Import: preview + options
  Import->>Q: enqueue(embed_chunk jobs)
  User->>V: Backfill / Start worker
  V->>W: startEmbeddingWorker()
  loop until done
    W->>DB: upsert vectors
    UI-->>User: progress, ETA
  end
  UI->>DB: enable search in UI
  DB-->>UI: top-k results
```

**Implementation anchors**
- `apps/web/vite.config.mts`
- `apps/web/src/app/api/*` (assistant & chat routes)
- `apps/web/src/workers/embedding-worker-web.ts`
- `packages/vector-management/*`
- `packages/db-explorer/*`
