# Brainstrike — Architecture Pack (Draft)

> **Status**: Draft, based on repository structure & filenames accessible via the GitHub connector. Some specifics are placeholders pending full code ingestion.

This pack contains a concise set of C4-style views, sequence diagrams, and state machines to make the system legible at a glance and deep-diveable when needed.

**Contents**

1. [System Context](./10-system-context.md)
2. [Container / Module View](./20-container-view.md)
3. [Embedding Pipeline](./30-embedding-pipeline.md)
4. [Agent Runtime & MCP](./40-agent-runtime.md)
5. [Web App (Vite/React) Overview](./50-web-app.md)
6. [Desktop App (Electron) Overview](./60-desktop-app.md)
7. [Data Model (High-Level)](./70-data-model.md)
8. [Deployment & Environments](./80-deployment.md)
9. [Chat & RAG Flow](./35-chat-rag.md)

**Grounding (discovered paths & clues)**

- Monorepo: `seandearnaley/brainstrike` with `apps/web`, `apps/desktop`, and `packages/*`.
- Embeddings & Vector mgmt: `packages/embeddings`, `packages/embedding-worker`, `packages/vector-management`, `packages/db` (migrations mention embedding sets, flexible dimensions, and vector helpers), `packages/db-explorer`.
- Workers & Queues: `apps/web/src/workers/embedding-worker-web.ts`, `apps/desktop/src/renderer/create-embedding-queue.ts`, `packages/embedding-worker/src/embedding.worker.ts`.
- Desktop/Electron: adapters in `packages/file-system`, `packages/storage`, Electron-specific DB repositories.
- Agent runtime: `packages/agent` with MAStra integration and MCP config (`mcp.config.json`).
- Web build: `apps/web/vite.config.mts` (separate `brainstrike-web` repo includes `docs/next-to-vite-migration.md`).
- API/Infra: separate private repo `brainstrike-api` contains an `cdk/` folder (AWS CDK based infra).

Where a diagram includes a **(verify)** label, it marks an assumption to confirm once full code access is available.
