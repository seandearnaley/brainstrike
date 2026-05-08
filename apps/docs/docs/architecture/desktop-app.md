---
title: Desktop App Overview
sidebar_position: 8
---

# Desktop App (Electron) Overview

```mermaid
flowchart LR
  subgraph Electron
    Main["Main Process\\n(IPC, assistant server, DB init, host lifecycle)"]
    Renderer["Visible Renderer\\n(Vector Status + UI)"]
    Host["Hidden Host Renderer\\n(EmbeddingHostRuntime)"]
  end

  subgraph Adapters
    FSA[file-system: electron-adapter.ts]
    STA[storage: electron-storage-adapter.ts]
    DRepo[db: electron-file-* / chunk repos]
  end

  User --> Renderer
  Renderer <--> Main
  Main <--> Host
  Main --> FSA
  Main --> STA
  Main --> DRepo
  Host --> Worker["Embedding Worker\\nstartEmbeddingWorker()"]
  Worker --> DB[(local DB\\nPGlite + pgvector + job_queue)]
```

**Notes**
- Desktop keeps embedding work in renderer context for privacy and to ensure Web Workers are available for local models.
- The visible window no longer starts the worker. Electron main owns a hidden host `BrowserWindow` and exposes lifecycle/status through `window.embeddingHost`.
- Hosted embedding providers (OpenAI/Google) still run through the same hidden renderer worker path today; main process remains IPC + lifecycle only.
- Only the hidden host disables `backgroundThrottling`; the visible window explicitly keeps
  Chromium background throttling enabled.
- DB providers/repositories have electron-specific implementations for performance and sandboxing.
