# 6) Desktop App (Electron) Overview

```mermaid
flowchart LR
  subgraph Electron
    Main[Main Process]\\n(ipc-mcp.ts, assistant-server.ts, db-main.ts)
    Renderer[Renderer]\\n(embedding-worker-provider.tsx)
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
  Renderer --> Worker[embedding.worker.ts]
  Worker --> DB[(local DB\\nPGlite + pgvector?)]
```

**Notes**
- Desktop keeps processing local when possible for privacy & speed; IPC bridges UI to privileged capabilities.
- DB providers/repositories have electron-specific implementations for performance and sandboxing.
