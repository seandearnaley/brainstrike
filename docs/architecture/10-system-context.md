# 1) System Context (C4 Level 1)

```mermaid
flowchart LR
  subgraph UserSpace[End Users]
    U1[User]
  end

  subgraph Clients[Clients]
    W[Web App (Vite/React)]
    D[Desktop App (Electron)]
  end

  subgraph Core[Brainstrike Monorepo]
    subgraph Pkgs[Packages]
      DB[packages/db\\n(migrations, repos, wasm loader)]
      EMB[packages/embeddings\\n(factory, types, math)]
      EW[packages/embedding-worker\\n(worker runtime)]
      VM[packages/vector-management\\n(status UI, controls)]
      FS[packages/file-system & storage\\n(adapters: electron/mock)]
      AG[packages/agent\\n(MAStra runtime, MCP tooling)]
      UI[packages/ui, hooks, preferences]
    end
    subgraph Apps[Apps]
      AWeb[apps/web\\n(assistant & chat API routes, workers)]
      ADesk[apps/desktop\\n(assistant-server, IPC, DB main)]
    end
  end

  subgraph Backend[Backend/Infra]
    API[brainstrike-api (AWS CDK)\\nAPI Gateway/Lambda (verify)]
    LLM[LLM & Embedding Providers\\n(OpenAI/others) (verify)]
  end

  U1 -->|interacts| W
  U1 -->|interacts| D

  W <--> DB
  W <--> EMB
  W <--> EW
  W <--> VM
  W <--> AG

  D <--> DB
  D <--> EMB
  D <--> EW
  D <--> VM
  D <--> FS
  D <--> AG

  AWeb <--> API
  ADesk <--> API
  EMB -->|create vectors| DB
  EW -->|batch/queue| EMB
  AG <--> LLM
  API <--> LLM
```
