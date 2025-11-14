# Brainstrike — Architecture Pack

> **Status**: Living documentation reflecting the current monorepo structure. Updated regularly as the architecture evolves.

This pack contains a concise set of C4-style views, sequence diagrams, and state machines to make the system legible at a glance and deep-diveable when needed.

**Contents**

1. [System Context](./01-system-context.md)
2. [Container / Module View](./02-container-view.md)
3. [Embedding Pipeline](./03-embedding-pipeline.md)
4. [Chat & RAG Flow](./04-chat-rag.md)
5. [Agent Runtime & MCP](./05-agent-runtime.md)
6. [Web App (Vite/React) Overview](./06-web-app.md)
7. [Desktop App (Electron) Overview](./07-desktop-app.md)
8. [Data Model (High-Level)](./08-data-model.md)
9. [Deployment & Environments](./09-deployment.md)

**Architecture Foundation**

- **Monorepo**: Turborepo-based monorepo with `apps/web`, `apps/desktop`, and `packages/*`
- **Embeddings & Vector Management**: `packages/embeddings`, `packages/embedding-worker`, `packages/vector-management`, `packages/db` (migrations with embedding sets, flexible dimensions, and vector helpers), `packages/db-explorer`
- **Workers & Queues**: Renderer-based embedding workers in both web and desktop apps, utilizing `packages/embedding-worker` and PGlite-backed job queues
- **Cross-Platform Adapters**: `packages/file-system` and `packages/storage` provide platform-agnostic interfaces for Node.js, Web, and Electron environments
- **Agent Runtime**: `packages/agent` with Mastra AI integration and MCP tooling support
- **Build Configuration**: Vite 7 for both web and desktop renderer, with shared Tailwind v4 configuration

Note: Some diagrams may include **(verify)** labels indicating areas pending validation or upcoming changes.
