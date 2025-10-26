# 5) Web App (Vite/React) Overview

## 5.1 Page/App Shell

```mermaid
flowchart TB
  subgraph App
    R[React Router] --> Layout[AppShell]
    Layout --> Home[Home Page]
    Layout --> Explore["DB Explorer\\n(packages/db-explorer)"]
    Layout --> Vectors["Vector Mgmt\\n(packages/vector-management)"]
    Layout --> Settings["Preferences\\n(embedding, import, providers)"]
  end

  Home --> ImportFlow[Import Flow]
  ImportFlow --> Queue[Embedding Queue Provider]
  Queue --> Worker[Web Worker]
  Worker --> Status[Vector Status Widgets]
```

## 5.2 Homepage “Happy Path”

```mermaid
sequenceDiagram
  actor User
  participant UI as Home (Web)
  participant Import as Import UI
  participant Q as Queue Provider
  participant W as Web Worker
  participant DB as DB via API

  User->>UI: Select folder
  UI->>Import: preview + options
  Import->>Q: enqueue(file chunks)
  Q->>W: start
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
