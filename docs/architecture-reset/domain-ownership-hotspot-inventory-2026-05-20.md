# Domain Ownership Hotspot Inventory

Generated from current `codex/local-architecture-reset` HEAD on 2026-05-20.

This inventory tracks size and churn hotspots that remain after the legal domain-boundary checks reached `0/0` approved exceptions. The purpose is to keep the next architecture reset work focused on files where humans and agents still collide.

## Largest Source And Test Files

| LOC | File | Action |
|---:|---|---|
| 1734 | `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-service.test.ts` | Split with service extraction. |
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

## Assistant Contract Catalog Slice Completed

`packages/assistant-contract/src/local-runtime-model-catalog.ts` is reduced from 1614 LOC to 1439 LOC by extracting public catalog state/result contracts into `local-runtime-model-catalog-types.ts`. The existing `@brainstrike/assistant-contract/local-runtime` public surface remains stable through re-exports, while the service file now owns runtime catalog behavior instead of also carrying the public type catalog.

Package-local architecture coverage now verifies the catalog service file stays under the 1500 LOC source budget. Verification for this slice:

- `pnpm --filter @brainstrike/assistant-contract exec vitest run src/__tests__/local-runtime-model-catalog-architecture.test.ts`
- `pnpm --filter @brainstrike/assistant-contract test`
- `pnpm --filter @brainstrike/assistant-contract type-check`

## File Explorer Tree Composition Slice Completed

`packages/file-explorer-ui/src/tree/optimized-file-tree.tsx` is reduced from 2559 LOC to 896 LOC and is now a composition module over:

- `optimized-file-tree-model.ts` for row model construction, selection state derivation, directory mutation helpers, worker rows, and normalized rows.
- `optimized-file-tree-selection-counts.ts` for selected-directory count projections and workspace-relative selection path matching.

All three owned tree files are below the 1500 LOC source budget. Package-local architecture coverage now verifies `optimized-file-tree.tsx` stays below budget. Verification for this slice:

- `pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/index.test.ts src/__tests__/optimized-file-tree.test.tsx`
- `pnpm --filter @brainstrike/file-explorer-ui type-check`

## File Explorer Tree Test Split Completed

`packages/file-explorer-ui/src/__tests__/optimized-file-tree.test.tsx` is split from 2947 LOC into four focused executable specs, all below the 2000 LOC test-file budget:

- `optimized-file-tree.test.tsx` for base render, lazy-load, row activation, and miscellaneous rendering behavior.
- `optimized-file-tree-selection.test.tsx` for explicit/query selection state projection.
- `optimized-file-tree-query-expansion.test.tsx` for query-selection expansion and covered-path behavior.
- `optimized-file-tree-selection-mutations.test.tsx` for mutation, capacity, and telemetry behavior.

`optimized-file-tree-test-support.tsx` owns the shared store bridge and baseline tree fixture. Package-local architecture coverage now verifies the split optimized tree test files stay below budget. Verification for this slice:

- `pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/index.test.ts src/__tests__/optimized-file-tree.test.tsx src/__tests__/optimized-file-tree-selection.test.tsx src/__tests__/optimized-file-tree-query-expansion.test.tsx src/__tests__/optimized-file-tree-selection-mutations.test.tsx`
- `pnpm --filter @brainstrike/file-explorer-ui type-check`

## File Explorer Indexing Source Slice Completed

`packages/file-explorer-ui/src/indexing/use-background-token-indexer-integration.ts` is reduced from 1853 LOC to 1478 LOC by extracting:

- `background-token-indexer-handles.ts` for Electron/web handle classification, synthetic Electron handles, and file-handle map construction.
- `background-token-indexer-dispatch-helpers.ts` for token-cache path normalization, large-selection diagnostics, and cooperative batch yields.
- `background-token-indexer-selection-shrink.ts` for in-flight selection-shrink reconciliation.

The integration hook remains the orchestration owner for effects, trigger dispatch, and cache writeback. Package-local architecture coverage now verifies the hook stays below the 1500 LOC source budget. Verification for this slice:

- `pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/index.test.ts src/__tests__/use-background-token-indexer-integration.test.tsx`
- `pnpm --filter @brainstrike/file-explorer-ui type-check`

## File Explorer Indexing Test Split Completed

`packages/file-explorer-ui/src/__tests__/use-background-token-indexer-integration.test.tsx` is split from 2258 LOC into two focused executable specs, both below the 2000 LOC test-file budget:

- `use-background-token-indexer-integration.test.tsx` for shrink reconciliation, hot-cache writeback, cache hydration, error handling, handle-map rebuilds, desktop synthetic handles, and Electron dispatch.
- `use-background-token-indexer-integration-web-resolver.test.tsx` for web resolver fallback parity, resolver retry behavior, resolver batching, oversize resolver guards, and mixed-separator synthetic desktop path coverage.

Package-local architecture coverage now verifies the split background token indexer tests stay below budget. Verification for this slice:

- `pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/index.test.ts src/__tests__/use-background-token-indexer-integration.test.tsx src/__tests__/use-background-token-indexer-integration-web-resolver.test.tsx`
- `pnpm --filter @brainstrike/file-explorer-ui type-check`

## App-Shell Assistant Wrapper Source Slice Completed

`packages/app-shell/src/assistant-ui-panel-wrapper.tsx` is reduced from 2242 LOC to 1388 LOC by extracting runtime-only helper responsibilities into `assistant-ui-panel-wrapper-runtime.ts`.

The wrapper remains the composition owner for React state, stores, effects, and UI wiring. The runtime helper now owns pure request/runtime transformations:

- assistant memory disabled-state decisions and run-record creation;
- request data construction for workspace context, native tools, provider options, and memory options;
- model/provider selection helpers for hosted, browser-local, Ollama, and LM Studio runtimes;
- local runtime model catalog projection;
- MCP/native tool menu shaping;
- provider settings, model settings, agent-loop settings, and draft-runtime construction.

Package-local architecture coverage now verifies `assistant-ui-panel-wrapper.tsx` stays below the 1500 LOC source budget. Verification for this slice:

- `pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/assistant-contract-boundary.test.ts src/__tests__/assistant-ui-panel-wrapper.test.tsx`
- `pnpm --filter @brainstrike/app-shell type-check`

## App-Shell Assistant Wrapper Test Fixture Slice Completed

`packages/app-shell/src/__tests__/assistant-ui-panel-wrapper.test.tsx` is reduced from 2765 LOC to 1760 LOC by extracting shared mocks, provider catalogs, DB fixtures, file-explorer stores, MCP bridge setup, and render helpers into `assistant-ui-panel-wrapper-test-support.tsx`.

The executable spec remains the behavioral owner for provider/model selection, MCP/native tools, workspace context updates, per-thread draft runtimes, Mastra memory wiring, and run-record lifecycle assertions. The support module is a shared fixture owner, not an additional behavioral lane.

Package-local architecture coverage now verifies the executable wrapper test stays below the 2000 LOC test-file budget. Verification for this slice:

- `pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/assistant-contract-boundary.test.ts src/__tests__/assistant-ui-panel-wrapper.test.tsx`
- `pnpm --filter @brainstrike/app-shell type-check`

## File Explorer Selection Action Test Slice Completed

`packages/file-explorer/src/actions/__tests__/file-selection-actions.test.ts` is reduced from 2074 LOC to 1982 LOC by extracting shared action-test fixtures into `file-selection-actions-test-support.ts` and moving null-folder early-return coverage into `file-selection-actions-null-folder.test.ts`.

The main executable spec remains the owner for selection mutation behavior, query-selection deltas, chunked large-selection behavior, cancellation, duplicate handling, and max-selection enforcement. The new focused spec owns only null-folder early returns.

Package-local architecture coverage now verifies the executable file-selection action test stays below the 2000 LOC test-file budget. Verification for this slice:

- `pnpm --filter @brainstrike/file-explorer exec vitest run src/__tests__/actions-architecture.test.ts src/actions/__tests__/file-selection-actions.test.ts src/actions/__tests__/file-selection-actions-null-folder.test.ts`
- `pnpm --filter @brainstrike/file-explorer build`

## UI Assistant Panel Source Slice Completed

`packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` is reduced from 2181 LOC to 1272 LOC by extracting:

- `assistant-controls-menu.tsx` for reasoning controls, tool controls, and provider-settings menu composition.
- `provider-settings-panel.tsx` for provider-specific reasoning, output, agent-loop, and memory-control form sections.

The root panel remains the composition owner for assistant-ui runtime selection, thread rendering, composer shell, message rendering, and provider/model header wiring. Existing imports of `ProviderSettingsPanel` from `@brainstrike/ui/assistant-ui-panel` remain stable through re-export.

Package-local architecture coverage now verifies the root panel stays below the 1500 LOC source-file budget and that the extracted controls/settings modules remain owned assistant-panel modules. Verification for this slice:

- `pnpm --filter @brainstrike/ui exec vitest run src/__tests__/assistant-ui-panel-architecture.test.ts src/__tests__/assistant-ui-panel.test.tsx src/__tests__/assistant-ui-panel-index.test.ts`
- `pnpm --filter @brainstrike/ui type-check`

## App-Shell Background Indexing Service Slice Completed

`packages/app-shell/src/background-indexing/workspace-collection-sync-service.ts` is reduced from 2044 LOC to 1015 LOC by extracting:

- `workspace-collection-sync-import.ts` for file-tree flattening, cache-change preparation, managed-cache mutation batches, and root-folder-cache import execution.
- `workspace-collection-sync-progress.ts` for abort handling, scan status throttling, backfill polling, queue-drained events, and status/progress mapping.

The service remains the orchestration owner for sync context resolution, access validation, recovery, scan/import/backfill sequencing, and status transitions. Package-local architecture coverage now verifies the service stays below the 1500 LOC source budget and composes through the owned import/progress helper modules. Verification for this slice:

- `pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/indexing-contract-boundary.test.ts src/background-indexing/__tests__/workspace-collection-sync-service.test.ts`
- `pnpm --filter @brainstrike/app-shell type-check`

## Desktop IPC Embedding Backfill Slice Completed

`apps/desktop/src/ipc-handlers.ts` is reduced from 1629 LOC to 1355 LOC by extracting `ipc-embedding-backfill.ts`.

The root IPC file remains the registry owner for storage, file-system, database, live-query batching, and shutdown cleanup. The new helper owns embedding-host backfill request validation, GPU reclaim configuration, in-flight/cancel state, progress events, and scheduled DB backfill execution. Package-local architecture coverage now verifies the root IPC file stays below the 1500 LOC source budget and composes through the owned embedding-backfill module. Verification for this slice:

- `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/platform/runtime-host-boundary.test.ts src/__tests__/main/ipc-handlers.test.ts src/__tests__/main/ipc-handlers-errors.test.ts src/__tests__/main/ipc-handlers-fs.test.ts src/__tests__/main/ipc-handlers-folder-restore.test.ts src/__tests__/main/ipc-handlers-db.test.ts`
- `pnpm --filter @brainstrike/desktop type-check`

## DB Explorer Demo Data Slice Completed

`packages/db-explorer/src/use-database-demo-data.ts` is reduced from 1689 LOC to 1306 LOC by extracting `database-demo-data-mappers.ts`.

The hook remains the orchestration owner for live queries, active-collection cache selection, lazy chunk loading, export loading, database status sync, and toast/error handling. The helper owns row-to-view-model mapping, cache snapshot/restore helpers, collection membership predicates, count normalization, and loaded-chunk diagnostics. Package-local architecture coverage now verifies the hook stays below the 1500 LOC source budget and composes through the owned mapper module. Verification for this slice:

- `pnpm --filter @brainstrike/db-explorer exec vitest run src/__tests__/architecture-boundary.test.ts src/__tests__/use-database-demo-data.test.ts`
- `pnpm --filter @brainstrike/db-explorer type-check`

## Desktop DB IPC Test Split Completed

`apps/desktop/src/__tests__/main/ipc-handlers-db.test.ts` is split from 2344 LOC into two focused executable specs and one shared fixture:

- `ipc-handlers-db.test.ts` is now 1247 LOC and owns database query/exec, managed cache, live query, reset, diagnostics, and clear-all behavior.
- `ipc-handlers-db-embedding-backfill.test.ts` is 783 LOC and owns embedding-host backfill request, progress, cancel, GPU reclaim, and in-flight behavior.
- `ipc-handlers-db-test-fixture.ts` centralizes Electron/DB IPC mocks so the executable specs stay focused without duplicating the platform harness.

Package-local architecture coverage now verifies the split database IPC executable specs stay below the 2000 LOC test-file budget. Verification for this slice:

- `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/platform/runtime-host-boundary.test.ts -t "keeps desktop IPC database tests split"`
- `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/main/ipc-handlers-db.test.ts src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts`
- `pnpm --filter @brainstrike/desktop type-check`

## Desktop File Explorer Selection E2E Split Completed

`apps/desktop/e2e/file-explorer-selection.desktop.test.ts` is split from 3150 LOC into two focused executable specs and one documented shared fixture:

- `file-explorer-selection.desktop.test.ts` is 617 LOC and owns interactive selection, select-all, limit, expansion, explicit selection, and mixed file/folder behavior.
- `file-explorer-selection-restore.desktop.test.ts` is 967 LOC and owns restored explicit, partial, query, snapshot-backed, and live replay selection behavior after desktop restart.
- `file-explorer-selection.shared.ts` is a documented test fixture exception that centralizes the desktop file-system fixture, persisted selection-state seeders, checkbox helpers, and renderer-settle helpers.

Package-local architecture coverage now verifies the executable desktop file-explorer selection E2E specs stay below the 2000 LOC test-file budget and that the shared fixture exception remains documented. Verification for this slice:

- `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/platform/runtime-host-boundary.test.ts -t "keeps desktop file explorer selection E2E executable specs split"`
- `pnpm --filter @brainstrike/desktop type-check:e2e`

## Next Slices

1. Tighten E2E lane selection so the split desktop embedding diagnostic files are only selected for matching high-risk diffs.
2. Split `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-service.test.ts` if the next background-indexing change adds more behavior coverage.
3. Continue desktop IPC decomposition by moving live-query batching and database-work scheduling behind owned platform modules.
4. Decompose `packages/db` internally around queue, migrations, repositories, search, and schema while preserving public barrels.
