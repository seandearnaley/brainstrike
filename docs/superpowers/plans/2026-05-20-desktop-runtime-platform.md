# Desktop Runtime Platform Plan

Date: 2026-05-20
Branch: `codex/local-architecture-reset`
Mode: local only; no PRs, no pushes, no GitHub Actions.

## Objective

Turn desktop runtime, indexing, and local AI hosts into a typed, observable platform. The end state is deterministic ownership for IPC, hidden renderer hosts, reset, diagnostics, and indexing orchestration. Adding a platform capability should mean adding one contract, one handler implementation, and one focused test, not manually coordinating main, preload, renderer, docs, and diagnostics by memory.

## Current Inventory

Existing useful platform scaffolding:

- `apps/desktop/src/renderer-host-lifecycle.ts` already owns hidden renderer `BrowserWindow` creation, role tracking, startup serialization, status waiters, load failure handling, and process-gone handling.
- `apps/desktop/src/register-background-runtime-lifecycle-ipc.ts` already centralizes the common ensure/start/stop/reset/status/report-status lifecycle IPC pattern for background runtimes.
- `apps/desktop/src/platform/runtime-host-boundary.ts` already enforces that `@brainstrike/agent/local-llm` and `@brainstrike/embeddings/worker` are not imported into Electron main execution paths.
- `apps/desktop/src/desktop-factory-reset.ts` already stops background runtimes, resets the DB profile, deletes userData entries, and preserves logs.
- `packages/preferences/src/settings/system/factory-reset-helpers.ts` already clears localStorage, sessionStorage, Electron storage, secrets, settings, IndexedDB, and CacheStorage.
- `packages/app-shell/src/diagnostics/system-diagnostics-panel.tsx` already provides a user-facing diagnostics panel, but it only directly covers database, queue, worker/token-cache status today.
- `@brainstrike/pipeline` is no longer purely unreferenced: `packages/db-explorer/src/enhanced-file-import-service.ts` imports `createEmbeddingJobQueuePort` from it. Docs still say it is “not yet wired into the apps,” so ownership is ambiguous.

Primary drift/hotspot areas:

- `apps/desktop/src/ipc-handlers.ts` is still 1,355 LOC and mixes storage, filesystem, layout, DB, live query, scheduler, embedding backfill, reset, and diagnostics handlers.
- `apps/desktop/src/preload.ts` is 820 LOC and duplicates channel names and status shapes because sandboxed preloads cannot import arbitrary local modules at runtime.
- `EmbeddingHostStatus` and `LlmHostStatus` still use coarse states from the generic runtime status model: stopped, starting, running, stopping, error. The platform goal needs explicit observable states for ready, active, idle, failed, reset, restart, and disposed.
- IPC registration is inconsistent across modules: some use the lifecycle registrar, many call `ipcMain.handle` directly.
- Diagnostics are not yet one typed desktop platform snapshot covering reset, migration, telemetry, crash recovery, DB, indexing, embedding host, and LLM host state.
- Factory reset has strong clearing primitives, but lacks one typed platform evidence surface proving host state and first-run state after reset.

## Non-Negotiable Constraints

- No pushes, PRs, GitHub Actions reruns, or cloud CI.
- Do not run removed CI proof commands.
- Do not start duplicate long-running commands.
- Before any long-running command, state exactly what it proves.
- Targeted tests first. Wider build/lint/type/unit only after coherent slices are stable.
- No silent fallback. Invalid contracts or ambiguous status values must fail explicitly.
- Renderer-only execution for local LLM and embedding worker remains mandatory.

## Architecture Direction

### Typed IPC Registry

Introduce a desktop IPC registry layer that records domain ownership for channels and centralizes handler registration/unregistration. This should wrap Electron IPC without hiding Electron semantics.

Proposed domains:

- `db`
- `files`
- `storage`
- `preferences`
- `embeddings`
- `llm-host`
- `chunking-host`
- `diagnostics`
- `runtime`
- `agent`
- `tools`
- `mcp`
- `logging`

The registry must support:

- invoke channels via `ipcMain.handle`
- event channels via `ipcMain.on`
- unregister cleanup
- domain/channel metadata for architecture tests
- no duplicate channel registration inside one registry

The initial implementation should not move every channel at once. It should first wrap the existing lifecycle IPC registrar, then move root IPC groups out of `ipc-handlers.ts` one domain at a time.

### Preload Contract Strategy

`preload.ts` states that sandboxed preloads cannot depend on local runtime modules. Respect that constraint. Do not “fix” drift by importing main-process modules into preload.

Use one of these explicit strategies:

- extract channel constants into a preload-safe static contract file only if bundling proves it is safe; or
- keep preload self-contained and add tests that compare preload channel strings/status unions to the platform contract source; or
- generate a checked-in preload contract snapshot from platform contracts, with a test proving the snapshot is current.

No silent runtime fallback if contract generation/checking fails.

### Host Lifecycle State Machines

Keep `RendererHostLifecycle` as the window/process lifecycle owner. Add a platform-facing state model above it for embedding and LLM hosts.

Target state vocabulary:

- `stopped`
- `starting`
- `ready`
- `active`
- `idle`
- `resetting`
- `restarting`
- `failed`
- `stopping`
- `disposed`

This can be introduced as a derived platform state first, without breaking existing renderer status compatibility. Existing bridges can keep returning current status shapes while diagnostics gains the richer platform state. Once tests prove compatibility, status contracts can be narrowed.

### Pipeline Ownership

Do not delete `@brainstrike/pipeline` immediately. It has a production import in `db-explorer`, but the package docs and architecture docs still describe it as not wired.

The first pipeline slice should:

- classify the current `db-explorer` use as either a real production consumer or a transitional helper import;
- update stale docs if it is real;
- otherwise move that helper behind a clearer indexing-owned contract and remove the package from the workspace graph only when imports/scripts prove it is unused.

### Diagnostics Platform Snapshot

Add a typed desktop diagnostics surface that can aggregate:

- DB diagnostics
- DB scheduler snapshot
- indexing/background sync state where available
- embedding host status/platform state
- LLM host status/platform state
- reset capability/status
- migration/runtime corruption diagnostics
- telemetry/logging status
- crash/restart counters where currently available

The app-shell diagnostics panel should consume this through a single bridge when running in desktop mode, while retaining web-safe behavior without silent fake values.

## Phased Implementation

### Slice 1: IPC Registry Foundation

Goal: create the platform pattern without moving behavior.

TDD first:

- Add `apps/desktop/src/__tests__/platform/desktop-ipc-registry.test.ts`.
- Test duplicate channel registration throws.
- Test invoke/event handlers are registered with domain metadata.
- Test unregister removes handlers/listeners.
- Test domain snapshots are stable and machine-readable.

Implementation:

- Add `apps/desktop/src/platform/desktop-ipc-registry.ts`.
- Convert `register-background-runtime-lifecycle-ipc.ts` to use the registry wrapper.
- Keep existing public function signatures stable.

Targeted verification:

- `pnpm --dir apps/desktop vitest run src/__tests__/platform/desktop-ipc-registry.test.ts src/__tests__/register-background-runtime-lifecycle-ipc.test.ts`

Commit: `Add desktop IPC registry foundation`

### Slice 2: Runtime Host Platform State

Goal: make hidden host state observable without changing execution location.

TDD first:

- Add tests for platform state derivation from runtime status.
- Add tests for reset/restart/disposed transitions in `embedding-host-manager` and `llm-host-manager`.

Implementation:

- Add a shared host state module, likely `apps/desktop/src/platform/runtime-host-state.ts`.
- Extend `EmbeddingHostManager` and `LlmHostManager` with `getPlatformStatus()` or equivalent.
- Preserve renderer-only architecture and existing bridge methods.

Targeted verification:

- `pnpm --dir apps/desktop vitest run src/__tests__/embedding-host-manager.test.ts src/__tests__/llm-host-manager.test.ts src/__tests__/platform/runtime-host-boundary.test.ts`

Commit: `Model hidden AI host platform state`

### Slice 3: Desktop Diagnostics Contract

Goal: one typed platform diagnostics snapshot.

TDD first:

- Add a desktop diagnostics contract test that composes mocked DB, scheduler, host, reset, and logging providers.
- Add app-shell diagnostics tests for desktop bridge present/missing behavior.

Implementation:

- Add desktop diagnostics contract/collector module.
- Add an IPC domain for diagnostics through the new registry.
- Add preload exposure for `window.desktopDiagnostics.getSnapshot()` or a similarly explicit name.
- Update `SystemDiagnosticsPanel` to display desktop-only platform state when the bridge exists.

Targeted verification:

- `pnpm --dir apps/desktop vitest run src/__tests__/main/desktop-diagnostics.test.ts src/__tests__/preload-runtime-contract.test.ts`
- `pnpm --filter @brainstrike/app-shell test -- system-diagnostics-panel`

Commit: `Expose desktop platform diagnostics`

### Slice 4: Extract IPC Domain Modules From Root Handler

Goal: reduce `ipc-handlers.ts` under 500 LOC by moving owned groups behind typed registries.

Order:

1. storage/settings/layout
2. files/folder restore
3. DB query/exec/live-query/scheduler
4. embedding backfill DB integration
5. reset/userData paths

TDD first for each group:

- Move or preserve current focused tests.
- Add a registry/domain metadata assertion for the moved group.

Implementation:

- Keep `registerIpcHandlers()` as a composition root.
- Extract modules under `apps/desktop/src/ipc-domains/` or `apps/desktop/src/platform/ipc-domains/`.
- Do not change channel names in the same commit as moving handlers.

Targeted verification by group:

- files: `pnpm --dir apps/desktop vitest run src/__tests__/main/ipc-handlers-fs.test.ts src/__tests__/main/ipc-handlers-folder-restore.test.ts`
- DB: `pnpm --dir apps/desktop vitest run src/__tests__/main/ipc-handlers-db.test.ts src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts`
- errors/root: `pnpm --dir apps/desktop vitest run src/__tests__/main/ipc-handlers.test.ts src/__tests__/main/ipc-handlers-errors.test.ts`

Commit series: one commit per extracted domain.

### Slice 5: Renderer-Only Guards and Preload Contract Checks

Goal: prevent future local AI execution drift and preload/main channel drift.

TDD first:

- Add negative tests for forbidden transitive/main-path runtime imports if needed.
- Add preload contract tests for lifecycle channels and status state vocabulary.

Implementation:

- Strengthen `runtime-host-boundary.ts` only where it catches real drift risk without false positives.
- Add contract comparisons for embedding/LLM host channel names.
- Document why preload remains self-contained.

Targeted verification:

- `pnpm --dir apps/desktop vitest run src/__tests__/platform/runtime-host-boundary.test.ts src/__tests__/preload-runtime-contract.test.ts`

Commit: `Enforce AI host and preload IPC contracts`

### Slice 6: Pipeline Ownership Decision

Goal: make `@brainstrike/pipeline` either a real production owner or remove it.

TDD first:

- Add or update tests proving the current `db-explorer` production import exercises pipeline-owned behavior.
- If moving orchestration into pipeline, add package-local tests in `@brainstrike/pipeline`.

Implementation path A, keep/revive:

- Move more file -> chunk -> embed orchestration contracts behind pipeline exports.
- Update stale docs that say the package is not wired.
- Ensure inbound production use is explicit and intentional.

Implementation path B, remove:

- Move the one used helper to the actual owning package.
- Remove workspace dependency, tsconfig paths, vitest alias, docs references, and risk selector references.
- Run import/reference scans before deletion.

Targeted verification:

- `pnpm --filter @brainstrike/pipeline test`
- `pnpm --filter @brainstrike/db-explorer test -- enhanced-file-import-service`
- `pnpm run arch:domain-contract`
- `pnpm run arch:domain-boundaries`

Commit: `Resolve pipeline ownership`

### Slice 7: Reset and Crash Recovery Evidence

Goal: prove first-run reset and host recovery through focused tests before any full E2E.

TDD first:

- Unit/integration tests for `resetDesktopApplicationData` proving ordering and failure behavior.
- Targeted desktop E2E only after diagnostics/reset contracts are in place.

Implementation:

- Expose reset state in platform diagnostics.
- Add crash/restart counters or last-recovery details where the host managers already observe process-gone/load failures.
- Add focused E2E lane tags for reset and host recovery if missing.

Targeted verification:

- `pnpm --dir apps/desktop vitest run src/__tests__/main/desktop-factory-reset.test.ts src/__tests__/main/db-main.remote-reset.test.ts`
- Targeted Playwright reset/crash spec only when the slice is implemented and explicitly justified.

Commit: `Prove desktop reset and host recovery`

### Slice 8: Final Documentation and Wider Local Verification

Goal: leave the platform understandable and locally proven.

Deliverables:

- Update `AGENTS.md` if commands/contracts changed.
- Add/update `docs/architecture-reset/desktop-runtime-platform-report-2026-05-20.html`.
- Include final IPC domain map, diagnostics surface, pipeline ownership decision, and targeted evidence table.

Wider verification, only after slices are stable:

- `pnpm run arch:domain-contract`
- `pnpm run arch:domain-boundaries`
- Relevant risk selector tests to prove unrelated low-risk changes avoid expensive E2E lanes.
- Build/lint/type/unit wider run only after targeted checks are green.

Commit: `Document desktop runtime platform`

## Done Conditions Mapping

| Condition | Planned Evidence |
| --- | --- |
| `ipc-handlers.ts` under 500 LOC | Slice 4 line-count test in runtime boundary/platform tests |
| one contract + one handler + one focused test per new IPC channel | Registry metadata tests and domain module tests |
| no preload/main/renderer triple drift | Preload contract tests in Slice 5 |
| renderer-only AI guards fail on main imports | `runtime-host-boundary.test.ts` |
| pipeline production-owned or removed | Slice 6 import scan, tests, docs update |
| embedding host lifecycle modeled/tested/observable | Slice 2 manager tests + Slice 3 diagnostics |
| LLM host lifecycle modeled/tested/observable | Slice 2 manager tests + Slice 3 diagnostics |
| reset proves true first-run behavior | Slice 7 unit/integration and targeted E2E if justified |
| hidden host recovery tested | Slice 7 focused host recovery tests |
| central diagnostics surface | Slice 3 diagnostics contract + app-shell tests |
| domain boundaries pass 0/0 exceptions | `pnpm run arch:domain-contract` and `pnpm run arch:domain-boundaries` |
| risk-based pipeline stays selective | risk selector tests after pipeline-impacting changes |
| local-only work | no pushes, clean local commits |

## First Execution Step

Start with Slice 1. It is low risk because it creates a registry abstraction and routes the existing lifecycle IPC registrar through it without changing channel names or host behavior. It also sets up the testable contract needed before moving the larger IPC handler groups.
