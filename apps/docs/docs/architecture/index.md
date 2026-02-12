---
title: Architecture Overview
sidebar_position: 1
slug: /architecture
---

![Architecture system map](/img/architecture/brainstrike-architecture-hero.webp)
![Runtime trust boundaries map](/img/architecture/2026-02-12-00-19-24-runtime-trust-boundaries.webp)

This architecture set documents Brainstrike's current production shape across web, desktop, shared packages, and AI infrastructure.

The trust-boundary view above highlights runtime separation and critical guardrails:
- Embedding worker executes in renderer only
- Main process handles lifecycle and IPC only
- Queue leases and retries enforce resilient processing
- Vector capability and model settings are explicit at runtime

## Included Views

1. [System Context](/architecture/system-context)
2. [Container View](/architecture/container-view)
3. [Embedding Pipeline](/architecture/embedding-pipeline)
4. [Chat and RAG Flow](/architecture/chat-rag)
5. [Agent Runtime and MCP](/architecture/agent-runtime)
6. [Web App Overview](/architecture/web-app)
7. [Desktop App Overview](/architecture/desktop-app)
8. [Data Model](/architecture/data-model)
9. [Deployment and Environments](/architecture/deployment)

## Foundation

- Monorepo: `apps/web`, `apps/desktop`, `packages/*`
- Local-first state and embedding workflows
- Renderer-only embedding worker execution
- Shared agent runtime and MCP integration surface
- Hosted provider integration for assistant and embeddings

Keep this section aligned with real code paths and package boundaries.
