# Domain Ownership Hotspot Inventory

Generated from current `codex/local-architecture-reset` HEAD on 2026-05-20.

This inventory tracks size and churn hotspots that remain after the legal domain-boundary checks reached `0/0` approved exceptions. The purpose is to keep the next architecture reset work focused on files where humans and agents still collide.

## Largest Source And Test Files

| LOC | File | Action |
|---:|---|---|
| 3150 | `apps/desktop/e2e/file-explorer-selection.desktop.test.ts` | Split after embedding E2E unless this lane becomes flaky first. |
| 2947 | `packages/file-explorer-ui/src/__tests__/optimized-file-tree.test.tsx` | Split by tree behavior: rows, virtualization, lazy loading, selection. |
| 2765 | `packages/app-shell/src/__tests__/assistant-ui-panel-wrapper.test.tsx` | Split by assistant contract, local runtime, thread/context wiring. |
| 2559 | `packages/file-explorer-ui/src/tree/optimized-file-tree.tsx` | Reduce to tree composition over row, windowing, telemetry, and keyboard modules. |
| 2344 | `apps/desktop/src/__tests__/main/ipc-handlers-db.test.ts` | Split by db IPC capability after handler registry exists. |
| 2258 | `packages/file-explorer-ui/src/__tests__/use-background-token-indexer-integration.test.tsx` | Split by indexer lifecycle, token cache, refresh and cancellation behavior. |
| 2242 | `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` | Reduce to thin composition over assistant contract and app-shell adapters. |
| 2181 | `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` | Split presentational assistant panel sections after wrapper is thinner. |
| 2074 | `packages/file-explorer/src/actions/__tests__/file-selection-actions.test.ts` | Split action tests by command family. |
| 2044 | `packages/app-shell/src/background-indexing/workspace-collection-sync-service.ts` | Move orchestration behind indexing-owned contracts. |
| 1853 | `packages/file-explorer-ui/src/indexing/use-background-token-indexer-integration.ts` | Split into indexer lifecycle, progress aggregation, and cache sync modules. |
| 1734 | `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-service.test.ts` | Split with service extraction. |
| 1689 | `packages/db-explorer/src/use-database-demo-data.ts` | Review after db internal decomposition. |
| 1629 | `apps/desktop/src/ipc-handlers.ts` | Move toward domain-keyed IPC registries. |
| 1614 | `packages/assistant-contract/src/local-runtime-model-catalog.ts` | Document or split catalog data if it keeps growing. |
| 1523 | `packages/file-explorer-ui/src/__tests__/preview-panel.test.tsx` | Split by preview table, footer, and report-action behavior. |
| 1504 | `packages/db-explorer/src/__tests__/use-database-demo-data.test.ts` | Review after db explorer ownership decision. |

## Six-Month Churn Hotspots

| Changes | File | Owning domain |
|---:|---|---|
| 38 | `packages/file-explorer-ui/src/file-explorer-left-panel.tsx` | File explorer shell. Historical path; current owner is `src/shell/file-explorer-left-panel.tsx`. |
| 32 | `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` | App-shell assistant adapter. |
| 31 | `packages/embeddings/src/worker/embedding-worker.ts` | Embeddings worker runtime. |
| 29 | `packages/file-explorer-ui/src/use-file-explorer-context.ts` | File explorer shell. Historical path; current owner is `src/shell/use-file-explorer-context.ts`. |
| 29 | `apps/desktop/src/main.ts` | Desktop platform bootstrap. |
| 29 | `apps/desktop/src/ipc-handlers.ts` | Desktop IPC platform. |
| 28 | `packages/file-explorer-ui/src/preview-panel.tsx` | File explorer preview. Historical path; current owner is `src/preview/preview-panel.tsx`. |
| 26 | `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` | UI assistant panel. |
| 25 | `packages/file-explorer-ui/src/use-background-token-indexer-integration.ts` | File explorer indexing. Historical path; current owner is `src/indexing/use-background-token-indexer-integration.ts`. |
| 25 | `packages/app-shell/src/__tests__/assistant-ui-panel-wrapper.test.tsx` | App-shell assistant adapter tests. |
| 25 | `apps/web/e2e/file-explorer.test.ts` | Web file explorer E2E. |
| 25 | `apps/desktop/src/preload.ts` | Desktop preload platform. |
| 24 | `packages/file-explorer-ui/src/optimized-file-tree.tsx` | File explorer tree. Historical path; current owner is `src/tree/optimized-file-tree.tsx`. |
| 24 | `packages/file-explorer-ui/src/__tests__/file-explorer-left-panel.test.tsx` | File explorer shell tests. |
| 24 | `packages/db-explorer/src/database-demo-panel.tsx` | DB explorer. |

## First Slice Completed

The file-explorer root package barrel now delegates to public slice barrels:

- `@brainstrike/file-explorer-ui/tree`
- `@brainstrike/file-explorer-ui/preview`
- `@brainstrike/file-explorer-ui/indexing`
- `@brainstrike/file-explorer-ui/shell`

Package-local architecture coverage now verifies:

- root exports do not bypass the owned slice barrels;
- each public slice barrel has an ownership README;
- implementation files remain inside their slice directories;
- public slice barrels still expose the same root symbols for current consumers.

## Embedding Worker Slice Started

`packages/embeddings/src/worker/embedding-worker.ts` is reduced from 2777 LOC to 1485 LOC by extracting ten responsibilities:

- `embedding-cache-types.ts` owns cache contract types.
- `embedding-model-config.ts` owns database-backed model metadata lookup and cache.
- `embedding-provider-runtime.ts` owns model resolution, runtime gating, hosted-provider setup, dimension validation, and rate-limit errors.
- `embedding-worker-cache-io.ts` owns embedding cache lookup, miss filtering, write scheduling, and result reconstruction.
- `embedding-worker-chunk-filter.ts` owns chunk loading, orphan handling, and up-to-date filtering for claimed jobs.
- `embedding-worker-db-io.ts` owns file chunk loading, vector-column assertions, embedding writes, and embedding-set dimension lookup.
- `embedding-worker-failures.ts` owns worker failure classification and job-processing error ownership.
- `embedding-worker-job-payload.ts` owns embed job payload validation and model-key resolution.
- `embedding-worker-scheduler.ts` owns claim-size and idle-backoff scheduling helpers.
- `embedding-stats-refresh-controller.ts` owns collection indexing stats refresh scheduling.

Compatibility re-exports remain in `embedding-worker.ts` while current consumers migrate. Package-local architecture coverage now verifies these responsibilities stay outside the lifecycle module and that `src/worker/README.md` documents ownership and focused verification.

## Desktop Embedding E2E Slice Started

`apps/desktop/e2e/embedding-worker-renderer.test.ts` is split into six executable specs, all below the 2,000 LOC test-file budget:

- `embedding-worker-renderer.smoke.desktop.test.ts`
- `embedding-worker-renderer.backfill-search.desktop.test.ts`
- `embedding-worker-renderer.memory.desktop.test.ts`
- `embedding-worker-renderer.diagnostics.desktop.test.ts`
- `embedding-worker-renderer.crash-a.desktop.test.ts`
- `embedding-worker-renderer.crash-b.desktop.test.ts`

`embedding-worker-renderer.shared.ts` is documented in `apps/desktop/e2e/README.md` as an explicit test fixture exception because it centralizes the former monolith's setup, DB fixtures, host diagnostics, and memory samplers without making the executable lane files large again. Verification so far is static and discovery-only: desktop E2E type-check passes and Playwright lists 36 split tests across the six files without running the expensive lane.

## Next Slices

1. Split `optimized-file-tree.tsx` and its 2947-line test file by extracting row/windowing/telemetry modules.
2. Continue splitting `embedding-worker.ts` by extracting provider execution, model resolution, queue scheduling/backpressure, telemetry, and host messaging.
3. Tighten E2E lane selection so the split desktop embedding diagnostic files are only selected for matching high-risk diffs.
4. Move `ipc-handlers.ts` toward a domain-keyed registry after the embedding E2E split reduces verification cost.
5. Decompose `packages/db` internally around queue, migrations, repositories, search, and schema while preserving public barrels.
