---
title: Monorepo Workflow
sidebar_position: 2
---

# Monorepo Workflow

Brainstrike uses a package-first monorepo model:

- `apps/*` consume reusable code
- `packages/*` own shared primitives and runtime modules
- Turborepo task graph enforces dependency-aware execution

## Repository Shape

- `apps/web`: React + Vite web client
- `apps/desktop`: Electron app (main + renderer)
- `packages/*`: shared libraries (db, embeddings, queue, agent, UI, etc.)

## Task Graph Expectations

- Build dependencies before dependents
- Type-check and tests run on built artifacts where required
- Use filtered tasks for iteration speed

Examples:

```bash
pnpm turbo run build --filter @brainstrike/web
pnpm turbo run test --filter @brainstrike/db
pnpm turbo run type-check --filter @brainstrike/agent
```

## Package Boundary Rules

- No app-to-app imports
- No copy-paste divergence when shared code belongs in a package
- Keep shared types and interfaces explicit and versioned via workspace packages

## Definition of Done

A change is complete only when the touched surfaces pass lint, build, type-check, and tests together.
