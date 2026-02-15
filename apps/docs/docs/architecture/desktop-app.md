---
title: Desktop App Overview
sidebar_position: 8
---

# Desktop App (Electron) Overview

```mermaid
flowchart LR
  subgraph Electron
    Main["Main Process\\n(IPC, assistant server, DB init)"]
    Renderer["Renderer\\n(EmbeddingWorkerProvider + Vector Status)"]
  end

  subgraph Adapters
    FSA[file-system: electron-adapter.ts]
    STA[storage: electron-storage-adapter.ts]
    DRepo[db: electron-file-* / chunk repos]
  end

  User --> Renderer
  Renderer <--> Main
  Main --> FSA
  Main --> STA
  Main --> DRepo
  Renderer --> Worker["Embedding Worker\\nstartEmbeddingWorker()"]
  Worker --> DB[(local DB\\nPGlite + pgvector + job_queue)]
```

**Notes**
- Desktop keeps embedding work in the renderer for privacy and to ensure Web Workers are available for local models.
- Hosted embedding providers (OpenAI/Google) still run in the renderer today; main process remains IPC + lifecycle only.
- DB providers/repositories have electron-specific implementations for performance and sandboxing.
