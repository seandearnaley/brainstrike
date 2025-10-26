# 2) Container / Module View (C4 Level 2)

```mermaid
flowchart TB
  subgraph Web[apps/web]
    WUI[React UI]
    WAPI[/src/app/api/*/route.ts\\n(HTTP handlers)/]
    WWorker[/src/workers/embedding-worker-web.ts/]
  end

  subgraph Desktop[apps/desktop]
    DMain[Main Process\\nIPC, assistant-server]
    DRenderer[Renderer]
    DQueue[/renderer/create-embedding-queue.ts/]
  end

  subgraph Packages
    subgraph DB[packages/db]
      DBModels[(models: embedding-set, chunks, ...)]
      DBRepos[[repositories: electron-file-*, embedding-sets-*]]
      DBMigs[/migrations: vector-index-helpers, flexible-dimensions/]
      DBWasm[/wasm-loader.ts\\n(PGlite) (verify)/]
    end

    subgraph Embeddings[packages/embeddings]
      EMBFactory[[factory.ts]]
      EMBTypes[(types.ts, constants)]
      EMBMath[(embedding-math.ts)]
      EMBWorker[/worker/embedding-worker.ts/]
      EMBCLI[/cli/embed-code.ts/]
    end

    subgraph VectorMgmt[packages/vector-management]
      VStatus[vector-status.tsx]
      VControls[use-embedding-worker-controls.ts]
      VProvider[embedding-queue-provider.tsx]
    end

    FS[packages/file-system & storage\\n(adapters)]

    subgraph Agent[packages/agent]
      ARuntime[[mastra/agent-runtime.ts]]
      AProvider[[providers/provider-factory.ts]]
      AMCP[[mcp/tool-registry.ts, mcp-tool-loader.ts]]
      AStream[[stream/data-stream.ts]]
    end
  end

  subgraph Backend
    API[brainstrike-api\\n(AWS CDK-defined services)]
    Providers[LLM/Emb providers]
  end

  WUI --> WAPI
  WUI -.-> WWorker
  DRenderer --> DQueue
  DRenderer <--> DMain

  WAPI --> Agent
  DMain --> Agent

  WAPI <--> DB
  DMain <--> DB

  Embeddings <--> DB
  VectorMgmt --> Embeddings
  VectorMgmt --> DB

  Agent --> Providers
  WAPI --> API
  DMain --> API
```
