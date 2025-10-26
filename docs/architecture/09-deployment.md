# 8) Deployment & Environments (Draft)

```mermaid
flowchart TB
  subgraph Local
    W[Web (Vite dev)]
    E[Electron App]
    PGL[PGlite (WASM) (verify)]
  end

  subgraph Cloud[AWS via brainstrike-api]
    AGW[API Gateway]
    L1[Lambda: Assistant/Embedding Proxy (verify)]
    L2[Lambda: Auth/Webhooks (verify)]
    VStore[(Managed DB / Vector Store) (verify)]
    CI[CI/CD via CDK Pipelines]
  end

  W -->|auth/api| AGW
  E -->|sync/updates| AGW
  AGW --> L1
  L1 --> VStore
  CI --> Cloud
```

**Observations**
- The presence of `cdk/` suggests IaC-managed stacks. Without reading CDK code, specific resources are marked **(verify)**.
- If most embedding runs locally (web worker, electron worker), cloud services may be used for user auth, sync, sharing, or heavy workloads.
