# PRD: Workspace Index and Background Indexer Reliability

**Status**: Draft for phased implementation
**Owner**: Sean Dearnaley
**Created**: 2026-06-07
**Last revised**: 2026-06-07 v1.0
**Target packages**: `@brainstrike/db`, `@brainstrike/preferences`, `@brainstrike/app-shell`, `@brainstrike/vector-management`, `@brainstrike/ui`, `@brainstrike/db-explorer`, `@brainstrike/agent`, `apps/desktop`
**Rollout posture**: Phased, stacked PRs, red/green TDD, regular commits
**Source analysis**: `docs/background-indexer-deep-dive-2026-06-07.md`

---

## Revision History

| Date | Version | Change | Driven by |
|---|---:|---|---|
| 2026-06-07 | v0.1 | Initial PRD from background indexer deep dive. Defines product target, architecture, phased PR sequence, TDD rules, and validation plan. | Background indexer analysis |
| 2026-06-07 | v0.2 | Corrected DB test-lane verification to use the package-local script in `@brainstrike/db`. | Phase 1 implementation evidence |
| 2026-06-07 | v0.3 | Implemented Phase 1 DB system role, migration registration, repository API, and exported workspace-index defaults/constants. | Commit `243ddd895` |
| 2026-06-07 | v0.4 | Implemented Phase 2 bootstrap defaults, fresh/stale preference binding, `blocked:missing-provider-key`, early provider validation, and pause-preserving bootstrap. | Commits `4738f5566`, `896ace664`, `40cbe6e57` |
| 2026-06-07 | v0.5 | Implemented Phase 3 settings/status copy, idle pause affordance, missing-key status badge, and global blocked status handling for `state: blocked`. | Commits `c818931dd`, `ba775dcc3` |
| 2026-06-07 | v0.6 | Implemented Phase 4 protected collection UI: shared picker protection, durable `systemRole` propagation through selectors, and Database Explorer guards for selection, edit/delete, manual import, and hybrid search. | Commits `21d8d3f5d`, `8fe41ce97`, `0eecf7177` |
| 2026-06-07 | v0.7 | Implemented Phase 5 desktop backfill recovery: scoped queue repair before candidate counting and a background-specific drain timeout so large workspace index drains do not inherit the manual foreground cap. | Commit `fad21ca3b` |
| 2026-06-07 | v0.8 | Implemented Phase 6 assistant integration: runtime Workspace Index status reaches assistant requests, `queryEmbeddingSpace` can omit `embeddingSetId` for Workspace Index defaulting, blocked Workspace Index state returns structured tool output, and coverage remains available through `listEmbeddingSpaces({ includeStats: true })` instead of adding per-query stats overhead. | Commits `17e6ac800`, `004eab404` |
| 2026-06-07 | v0.9 | Implemented Phase 7 QoS v1 foundation: shared `@brainstrike/utils/workspace-indexing-qos` policy, app-shell scan/import/backfill policy wiring, visible-renderer activity/visibility and DB-pressure inputs, and desktop embedding worker claim sizing through the same policy. Desktop idle/power/thermal inputs remain a follow-up before Phase 7 is fully closed. | Commits `d6974dc1f`, `279fc8c88` plus current Phase 7 branch work |
| 2026-06-07 | v1.0 | Wired desktop platform QoS inputs: Electron `powerMonitor` snapshots flow through a typed preload `power.getSnapshot()` bridge into app-shell scan/import/backfill policy and hidden embedding worker claim sizing. | Commit `8ab97dc65` |
| 2026-06-07 | v1.1 | Added Phase 8 desktop verification coverage for fresh Workspace Index bootstrap, stale managed-id rebind, and pause/resume persistence; fixed a DB ESM import-extension runtime launch failure discovered by desktop e2e; made background-indexing preferences a renderer-global singleton so duplicate import paths cannot split pause state. | Commits `555c6b0cb`, `f71e68940` |
| 2026-06-07 | v1.2 | Manual Agent DevTools verification found and closed a protected-UI affordance gap: shared hybrid-search controls now support a disabled state and Database Explorer passes it when the active collection is the Workspace Index. | Commit `2d9f64c5b` |
| 2026-06-08 | v1.3 | Revised the default Workspace Index model to local `Xenova/all-MiniLM-L6-v2` (384D) to avoid automatic whole-workspace hosted embedding when users have an assistant API key; added a v4 preference migration for existing profiles and typed missing-provider-key validation reasons. | Current branch |

## 1. Goal

Make Brainstrike's desktop workspace index a first-class, self-healing product feature instead of a manually configured "background indexing" setting. A fresh app profile should create and manage a default workspace index collection, keep it updated through durable chunking and embedding, let the assistant query it reliably, and expose clear pause/resume/status controls without allowing normal collection workflows to corrupt it.

## 2. Problem Statement

Today, background indexing works only after the user creates a collection and selects it in settings. The managed collection is still treated like a normal collection in large parts of the UI, so it can be selected for hybrid search, edited, deleted, and confused with user-owned collections. The background pipeline does chunk and embed, but the import phase chunks first and only later enqueues embedding backfill; that phase split is not obvious in the UX. Desktop backfill also lacks queue repair used by manual backfill, which can make stuck jobs look like permanent missing embeddings.

The shortest implementation path would be to turn the existing preference on by default. That is not sufficient. The correct shape is a DB-owned system workspace index, with a bootstrap/self-heal service, system-aware collection UI, assistant retrieval defaults, desktop queue recovery, and an adaptive QoS policy.

## 3. Product Principles

- No fallbacks. If the default provider key, root folder access, model config, host runtime, or queue state is invalid, show a precise blocked/error state.
- No silent degradation. Do not switch providers, dimensions, devices, or collection targets without explicit user action.
- Local-first. Workspace state, indexing state, and queue state stay client-owned.
- Renderer-only embeddings. Do not move local embedding work into Electron main.
- Foreground queries win. Assistant query embeddings must not share GPU inference with background indexing.
- Visible but protected. The workspace index should be visible for trust and diagnostics, but protected from normal collection selection/edit/delete/import.
- Phase by phase. Each PR should be shippable, green, and small enough to review.
- Red/green TDD. Each behavior starts with a failing unit/integration/e2e test before implementation where the codebase allows a lint-clean red state.

## 4. Default Model Decision

Initial workspace index default:

| Field | Value |
|---|---|
| Provider/model key | `local::Xenova/all-MiniLM-L6-v2` |
| Model id | `Xenova/all-MiniLM-L6-v2` |
| Dimensions | `384` |
| Distance | `cosine` |
| Collection name | `Workspace Index` |
| System role | `workspace-index` |

Rationale:

- This model is already in Brainstrike's DB-backed local embedding catalog and is enabled by the existing default-local-model migration.
- It keeps the default Workspace Index local-first: an assistant API key must not silently authorize uploading the entire workspace to a hosted embedding provider.
- The hidden renderer embedding host can execute this model without moving embedding work into Electron main.
- If a user later changes the Workspace Index to a hosted provider, missing credentials enter `blocked:missing-provider-key` through a typed validation reason. It must not fall back to another provider.

Future model changes require the full model-catalog migration path from `AGENTS.md`.

## 5. Scope

### In Scope

- DB/system metadata for a protected workspace index collection.
- First-run bootstrap and stale-state self-heal.
- Preference/status integration for enabled, paused, blocked, updating, and ready states.
- Settings copy and controls renamed from "Background indexing" to "Workspace Index" where user-facing.
- Collection picker/select behavior that shows the workspace index but prevents normal selection/edit/delete/import/hybrid-search use.
- Dedicated workspace index status/inspector affordance.
- Assistant retrieval routing that defaults workspace/codebase search to the workspace index.
- Desktop backfill queue recovery parity with manual/vector backfill.
- Background drain behavior suitable for long-running indexing.
- Adaptive QoS controller v1.
- Unit, integration, desktop e2e, and manual DevTools/Computer Use validation.
- PRD updates as decisions change.

### Out of Scope

- Replacing the embedding model catalog.
- Moving local embeddings out of the hidden renderer host.
- Rewiring assistant per-tool guards or stream watchdogs.
- Adding remote API dependencies to latency-critical local indexing.
- Replacing the chunking algorithm.
- Full visual redesign of Database Explorer.
- Deleting existing user collections.

## 6. Success Criteria

| Area | Success criterion | Verification |
|---|---|---|
| First run | Fresh profile creates or binds exactly one protected workspace index. | Unit + desktop e2e |
| No fallback | Missing hosted provider key shows blocked state and no embedding jobs call another provider. | Unit + integration + manual |
| Embedding completion | Changed files progress from scan to chunk to durable `embed_chunk` jobs to persisted embeddings. | Integration + desktop e2e |
| Query coordination | Assistant query embedding drains active background batch, runs, and background indexing resumes. | Unit + desktop e2e |
| Protected UI | Workspace index is visible but cannot be selected for normal collection hybrid search, edit, delete, or manual import. | Unit + browser/e2e |
| Pause/resume | User pause stops new scan/enqueue/claim work and resume self-heals. | Unit + desktop e2e + manual |
| Queue recovery | Unclaimable queued jobs and failed scoped jobs are repaired before backfill concludes no candidates exist. | Unit + integration |
| QoS | Indexer rate changes based on foreground query, user activity, visibility, DB pressure, battery/thermal state, and manual pause. | Unit + manual diagnostics |
| Observability | Status explains `ready`, `updating`, `paused`, `yielding`, `blocked`, `recovering`, and `error`. | Unit + UI/e2e |
| Full gate | Final implementation branch passes `pnpm lint && pnpm type-check && pnpm build && pnpm test`. | Local gate |

## 7. Architecture Overview

### Current Invariants to Preserve

- Hidden embedding host renderer owns local embedding worker execution.
- Electron main owns hidden host lifecycle, IPC, DB init, and power lifecycle.
- Visible renderer does not start the desktop embedding worker directly.
- Background sync uses background-priority DB work.
- Foreground query gate blocks new background embedding claims while a query is in flight.
- Job queue remains durable, lease-based, retryable, and deduped.

### Target Components

| Component | Responsibility |
|---|---|
| System collection metadata | Durable marker that distinguishes `workspace-index` from user collections. |
| Workspace index bootstrap service | Create/find/rebind the protected collection and synchronize preferences/status. |
| Workspace index status model | One vocabulary for ready/updating/paused/yielding/blocked/recovering/error. |
| System-aware collection selectors | Render visible but disabled/protected workspace index rows. |
| Workspace index inspector | Read-only coverage, queue, model, provider, pause/resume, and last-error surface. |
| Assistant workspace retrieval router | Default workspace/codebase queries to the workspace index when available. |
| Desktop backfill recovery | Repair scoped unclaimable queued and failed jobs before candidate counting. |
| Adaptive QoS controller | Convert user/system/DB/query pressure into batch, delay, and concurrency settings. |

## 8. Data and State Ownership

### Durable Source of Truth

The DB should own whether a collection is system-managed. Preferences may cache selection and UI state, but they must not be the only proof that a collection is the workspace index.

Required collection metadata:

- `systemRole: 'workspace-index' | null`
- `systemManaged: boolean`
- `canEdit: boolean`
- `canDelete: boolean`
- `canManualImport: boolean`
- `canNormalSearchSelect: boolean`
- `disabledReason: string | null`

Implementation options:

1. Add first-class DB columns to `embedding_sets`.
2. If migration scope must stay smaller, use `category` and tags as a transitional marker only inside one PR, then migrate to first-class columns before UI gating ships.

Preferred direction: first-class columns. Tags/category are too weak for protected state.

### Preference State

`background-indexing-preferences-store` remains useful for:

- enabled/disabled
- paused/unpaused
- user-selected policy preset
- current managed collection id cache
- user-selected model override after the model-switch flow exists

It should not be the only ownership mechanism.

### Status State

Status should be derived from durable state plus live runtime signals:

- DB collection role and coverage.
- provider/key validation.
- root folder access.
- sync service state.
- queue state.
- hidden host state.
- QoS state.
- manual pause state.

## 9. User Experience

### First Run

1. User opens desktop app with a fresh profile.
2. Workspace root is selected/restored.
3. App creates or binds `Workspace Index`.
4. With the default local model, indexing starts when root access and the hidden embedding host are available.
5. If the Workspace Index is reconfigured to a hosted model and its provider key is missing, status shows the specific missing-key blocked state and links to settings.
6. No provider fallback occurs.

### Normal Operation

- Workspace index runs quietly.
- Status is available in settings and diagnostics.
- Background work yields to foreground assistant query embeddings.
- User can pause/resume.
- Coverage counts are accurate: files, chunks, embedded chunks, queued/running/failed jobs, last completed update.

### Collection Browser

- Workspace index appears with a `Workspace Index` badge and coverage.
- It is not selectable for ordinary collection browsing/hybrid search.
- Edit/delete/manual import are disabled.
- A read-only inspect action opens status/coverage details.

### Assistant

- Workspace/codebase questions use the workspace index without requiring the user to choose a search collection.
- If the workspace index is blocked or incomplete, the assistant receives structured status and can say what is missing.
- Query embeddings use the hidden host/gate path where applicable.

## 10. Work Breakdown and PR Sequence

Each phase should land as a separate PR unless implementation evidence shows two adjacent phases are smaller together. Every PR updates this PRD's revision history when scope, file paths, status vocabulary, or acceptance criteria change.

### Phase 0: PRD and Baseline Evidence

**Goal**: Land this PRD and preserve the deep-dive findings as source material.

**Files**

- Create: `docs/prd-workspace-index-background-indexer-2026-06.md`
- Keep: `docs/background-indexer-deep-dive-2026-06-07.md`

**Tests**

- Docs-only. Run `git diff --check`.

**Commit cadence**

- `docs: add workspace index background indexer PRD`

**Exit criteria**

- PRD reviewed.
- Next implementation branch starts from current main.

### Phase 1: System Collection Contract

**Goal**: Add durable system-owned collection metadata and repository APIs without changing UI behavior yet.

**Likely files**

- Modify: `packages/db/src/repositories/embedding-sets-repository.ts`
- Modify: `packages/db/src/models/embedding-set.ts`
- Modify: `packages/db/src/migrations/index.ts`
- Modify: `packages/db/src/drizzle/migrate.ts`
- Create: `packages/db/src/migrations/034-workspace-index-system-role.ts`
- Test: `packages/db/__tests__/embedding-sets-repository.test.ts`
- Test: `scripts/test-lanes.mjs` if a new DB test file is added.

**Red/green TDD sequence**

- RED: repository test expects `getOrCreateWorkspaceIndexSet()` or equivalent to create a collection with system role and default model metadata.
- GREEN: implement minimal repository method and migration.
- RED: test existing user collections default to no system role and remain editable/deletable.
- GREEN: implement read mapping and default values.
- RED: migration test verifies existing rows get `null` system role.
- GREEN: register migration in both migration ledgers.
- RED: `pnpm --filter @brainstrike/db run test:db:check-lanes` fails if a new DB test file is unassigned.
- GREEN: assign test lane if needed.

**Commands**

- `pnpm --filter @brainstrike/db test -- embedding-sets-repository`
- `pnpm --filter @brainstrike/db run test:db:check-lanes`
- `pnpm lint && pnpm type-check`

**Exit criteria**

- DB can represent a protected workspace index collection.
- No UI behavior depends on preferences-only managed IDs.

### Phase 2: Bootstrap and Self-Heal Service

**Goal**: Fresh profiles create or bind exactly one workspace index, synchronize preferences, and expose blocked status when credentials/root access are missing.

**Likely files**

- Create: `packages/app-shell/src/background-indexing/workspace-index-bootstrap-service.ts`
- Create: `packages/app-shell/src/background-indexing/workspace-index-blocked-error.ts`
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx`
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-service.ts`
- Modify: `packages/preferences/src/stores/background-indexing-preferences-store.ts`
- Modify: `packages/preferences/src/stores/workspace-collection-sync-status-store.ts`
- Test: `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-provider.test.tsx`
- Test: `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-service.test.ts`
- Test: `packages/preferences/src/__tests__/background-indexing-preferences-store.test.ts`
- Test: `packages/preferences/src/__tests__/workspace-collection-sync-status-store.test.ts`

**Red/green TDD sequence**

- RED: fresh DB plus no managed preference creates the default `Workspace Index` with local MiniLM 384D cosine.
- GREEN: implement bootstrap creation.
- RED: stale `managedCollectionId` pointing to a missing collection rebinds to existing system collection.
- GREEN: implement self-heal rebind.
- RED: hosted provider validation with a missing key produces `blocked:missing-provider-key` and does not call provider fallback.
- GREEN: wire provider-key validation into status.
- RED: user pause persists across bootstrap and prevents new sync work.
- GREEN: preserve pause during bootstrap.

**Commands**

- `pnpm --filter @brainstrike/app-shell exec vitest run src/background-indexing/__tests__/workspace-collection-sync-provider.test.tsx src/background-indexing/__tests__/workspace-collection-sync-service.test.ts`
- `pnpm --filter @brainstrike/preferences exec vitest run src/__tests__/background-indexing-preferences-store.test.ts src/__tests__/workspace-collection-sync-status-store.test.ts`
- `pnpm lint && pnpm type-check`

**Exit criteria**

- New app state has a default workspace index without user collection setup.
- Missing prerequisites are blocked states, not fallbacks.

### Phase 3: Workspace Index Status and Settings UX

**Goal**: Rename the user-facing surface to "Workspace Index" and make status/pause/resume clear.

**Likely files**

- Modify: `packages/preferences/src/settings/system/search-indexing-settings-section.tsx`
- Modify: `packages/preferences/src/stores/workspace-collection-sync-status-helpers.ts`
- Modify: `packages/vector-management/src/indexing-activity-coordinator.tsx`
- Test: `packages/preferences/src/settings/system/__tests__/search-indexing-settings-section.test.tsx`
- Test: `packages/app-shell/src/__tests__/indexing-status-item.test.tsx`

**Red/green TDD sequence**

- RED: settings renders `Workspace Index`, not primary "Background indexing" copy.
- GREEN: update copy and labels.
- RED: pause/resume control is available whenever the workspace index is enabled and not blocked by missing root/collection.
- GREEN: adjust helper logic.
- RED: status helper maps ready/updating/paused/yielding/blocked/recovering/error to stable copy.
- GREEN: implement status mapping.

**Commands**

- `pnpm --filter @brainstrike/preferences test -- search-indexing-settings-section`
- `pnpm --filter @brainstrike/app-shell test -- indexing-status-item`
- `pnpm lint && pnpm type-check`

**Exit criteria**

- User-facing settings describe Workspace Index as a product feature.
- Pause/resume and blocked states are explicit.

### Phase 4: Protected Collection UI Contract

**Goal**: Keep the workspace index visible but prevent normal selection/edit/delete/import/hybrid-search use.

**Likely files**

- Modify: `packages/ui/src/collection-picker/types.ts`
- Modify: `packages/ui/src/collection-picker/collection-picker.tsx`
- Modify: `packages/ui/src/collection-picker/collection-picker-item.tsx`
- Modify: `packages/vector-management/src/collection-select/collection-select.tsx`
- Modify: `packages/db-explorer/src/components/search-collection-selector.tsx`
- Modify: `packages/db-explorer/src/components/collection-browser-view.tsx`
- Modify: `packages/db-explorer/src/database-demo-panel.tsx`
- Test: `packages/ui/src/collection-picker/__tests__/collection-picker.test.tsx`
- Test: `packages/vector-management/src/__tests__/collection-select.test.tsx`
- Test: `packages/db-explorer/src/components/__tests__/search-collection-selector.test.tsx`
- Test: `packages/db-explorer/src/components/__tests__/collection-browser-view.test.tsx`
- Test: `packages/db-explorer/src/__tests__/database-demo-panel.test.tsx`

**Red/green TDD sequence**

- RED: `CollectionPicker` renders disabled system collection with badge and reason.
- GREEN: add disabled/selectability props.
- RED: keyboard Enter/Space skips disabled system collection.
- GREEN: update keyboard handling.
- RED: edit/delete buttons are absent or disabled for system collection.
- GREEN: update item action contract.
- RED: `CollectionSelect` renders system collection disabled.
- GREEN: add select item disabled path.
- RED: Database Explorer cannot run hybrid search with a workspace index active.
- GREEN: guard `handleSearch` and selection flow.
- RED: manual import remains disabled for system collection.
- GREEN: wire system role instead of preference-only `managedCollectionId`.

**Commands**

- `pnpm --filter @brainstrike/ui test -- collection-picker`
- `pnpm --filter @brainstrike/vector-management test -- collection-select`
- `pnpm --filter @brainstrike/db-explorer test -- search-collection-selector collection-browser-view database-demo-panel`
- `pnpm lint && pnpm type-check`

**Exit criteria**

- Workspace index is visible but protected across collection UI.
- Normal hybrid search cannot target it accidentally.

### Phase 5: Desktop Backfill Self-Healing and Long-Running Drain

**Goal**: Make background backfill repair blocked queue state and avoid foreground-style drain failure for long background jobs.

**Likely files**

- Modify: `apps/desktop/src/embedding-backfill.ts`
- Modify: `apps/desktop/src/ipc-embedding-backfill.ts`
- Modify: `packages/db/src/queue/job-queue.ts` only if existing repair API is insufficient.
- Test: `apps/desktop/src/__tests__/main/embedding-backfill.test.ts`
- Test: `apps/desktop/src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts`

**Red/green TDD sequence**

- RED: desktop backfill with unclaimable queued scoped job repairs and requeues before candidate counting.
- GREEN: call scoped `repairUnclaimableQueued`/`requeueFailed` or a shared recovery helper.
- RED: background source uses background-specific drain policy or decoupled durable-enqueue completion.
- GREEN: implement background drain behavior.
- RED: failed jobs remain visible and throw/report explicit failure after retry policy is exhausted.
- GREEN: preserve explicit failure status.

**Commands**

- `pnpm --dir apps/desktop test -- src/__tests__/main/embedding-backfill.test.ts`
- `pnpm --dir apps/desktop test -- src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts`
- `pnpm lint && pnpm type-check`

**Exit criteria**

- Background index cannot get stuck behind unclaimable queued jobs.
- Large workspace backfills do not fail solely because the background drain exceeds a foreground timeout.

### Phase 6: Assistant Workspace Retrieval Default

**Goal**: Make assistant workspace/codebase retrieval default to the workspace index and report structured blocked/coverage status.

**Likely files**

- Modify: `apps/desktop/src/assistant-server/assistant-tools.ts`
- Modify: `apps/desktop/src/assistant-server/retrieval-tool.ts`
- Modify: `packages/agent/src/tools/retrieval-tool.ts`
- Modify: `packages/assistant-contract/src/runtime-data.ts`
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper.tsx`
- Test: `apps/desktop/src/__tests__/assistant-server/assistant-tools.test.ts`
- Test: `apps/desktop/src/__tests__/assistant-server/retrieval-tool.test.ts`
- Test: `packages/agent/src/__tests__/retrieval-tool.spec.ts`
- Test: `packages/app-shell/src/__tests__/assistant-ui-panel-wrapper.test.tsx`

**Red/green TDD sequence**

- RED: workspace/codebase retrieval uses `workspaceIndexEmbeddingSetId` when no explicit embedding set is supplied.
- GREEN: implement canonical resolver.
- RED: explicit user-supplied embedding set still wins for non-workspace query tools where intended.
- GREEN: preserve explicit override only in the correct tool path.
- RED: blocked workspace index returns structured status instead of generic missing embedding set.
- GREEN: add status response.
- RED: partial coverage is included in assistant tool result.
- GREEN: include coverage fields.

**Commands**

- `pnpm --dir apps/desktop test -- src/__tests__/assistant-server/assistant-tools.test.ts src/__tests__/assistant-server/retrieval-tool.test.ts`
- `pnpm --filter @brainstrike/agent test -- retrieval-tool`
- `pnpm --filter @brainstrike/app-shell test -- assistant-ui-panel-wrapper`
- `pnpm lint && pnpm type-check`

**Exit criteria**

- Assistant can reliably use the workspace index without user collection selection.
- Blocked/incomplete states are explicit.

**Implementation note v0.8**

- `brainstrike.queryEmbeddingSpace` now defaults to the Workspace Index when `embeddingSetId` is omitted and a Workspace Index runtime snapshot is present.
- If the Workspace Index is blocked/unavailable, `queryEmbeddingSpace` returns structured status with queue progress and the exact blocked reason instead of throwing a generic missing-set error.
- Coverage stats are exposed through `brainstrike.listEmbeddingSpaces({ includeStats: true, workspaceIndexOnly: true })`. They are not duplicated into every query result because that would add a stats query to the hot retrieval path.

### Phase 7: Adaptive QoS Controller v1

**Goal**: Replace scattered static behavior with a small explicit QoS policy controller.

**Likely files**

- Create: `packages/utils/src/workspace-indexing-qos.ts`
- Modify: `packages/utils/package.json`
- Modify: `packages/utils/tsup.config.ts`
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx`
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-import.ts`
- Modify: `apps/desktop/src/renderer/components/embedding-worker-config.ts`
- Modify: `apps/desktop/vite.config.mts`
- Modify: `apps/desktop/src/embedding-host-manager.ts`
- Modify: `apps/desktop/src/preload.ts` if visible renderer needs power/idle snapshots.
- Test: `packages/utils/src/__tests__/workspace-indexing-qos.test.ts`
- Test: `apps/desktop/src/__tests__/renderer/components/embedding-worker-config.test.ts`
- Test: `apps/desktop/src/__tests__/main/embedding-host-manager.test.ts`
- Test: existing foreground gate tests as needed.

**Policy inputs**

- manual pause
- foreground query gate state
- recent user input
- app/window visibility
- Electron idle state and idle time
- battery power
- thermal state
- DB pressure snapshot
- queue depth
- provider/rate-limit error window

**Policy outputs**

- scan batch size
- content read concurrency
- import/chunk batch size
- backfill queue depth
- worker claim size
- interbatch delay
- progress notification cadence
- permission to hold power save blocker

**Red/green TDD sequence**

- RED: `manual-paused` returns no scan/enqueue/claim capacity.
- GREEN: implement base policy.
- RED: foreground query returns claim size 0 or gate-closed state while allowing completion drain.
- GREEN: wire foreground state.
- RED: recent user activity lowers concurrency.
- GREEN: implement activity input.
- RED: idle-on-AC raises throughput within configured caps.
- GREEN: implement idle/AC policy.
- RED: battery or serious/critical thermal enters constrained policy.
- GREEN: implement constrained policy.
- RED: missing pressure snapshots throws in desktop background path.
- GREEN: preserve no-fallback behavior.

**Commands**

- `pnpm --filter @brainstrike/app-shell exec vitest run src/background-indexing/__tests__/indexing-qos-controller.test.ts`
- `pnpm --dir apps/desktop test -- src/__tests__/main/embedding-host-manager.test.ts`
- `pnpm lint && pnpm type-check`

**Exit criteria**

- Background indexer behavior is explainable through one QoS state.
- Static constants remain only as caps/defaults, not hidden policy.

**Implementation note v0.9**

- The QoS controller lives in `@brainstrike/utils/workspace-indexing-qos`, not app-shell, so app-shell scan/import/backfill and the desktop hidden embedding host share one policy source.
- App-shell now resolves policy before scanning, importing, and enqueueing managed backfill. `allowNewWork: false` fails fast for scan/import/enqueue paths instead of silently continuing.
- The visible renderer currently supplies manual pause, recent user input, document visibility, queue depth, DB pressure, and desktop platform power snapshots when the Electron bridge is available.
- The desktop embedding worker now derives claim size from the same QoS policy using DB pressure plus the desktop power snapshot. Foreground DB pressure maps to one-at-a-time claims because `EmbeddingWorkerOptions.resolveClaimBatchSize` requires a positive integer; foreground query embeddings still use the existing foreground gate as the hard stop for new background claims.
- The existing `EmbeddingHostManager` power-save blocker remains active-work-driven with an idle grace period. It is not yet driven by the QoS `allowPowerSaveBlocker` flag.

### Phase 8: Desktop E2E and Manual Verification Hardening

**Goal**: Prove the product workflow in a real desktop renderer and document manual checks.

**Likely files**

- Create or modify: `apps/desktop/e2e/workspace-index-bootstrap.desktop.test.ts`
- Modify: `apps/desktop/e2e/background-indexing-settings.desktop.test.ts`
- Modify: `apps/desktop/e2e/background-indexing-pause.desktop.test.ts`
- Modify: `apps/desktop/e2e/embedding-worker-renderer.backfill-search.desktop.test.ts`
- Modify: `docs/prd-workspace-index-background-indexer-2026-06.md`
- Modify: `AGENTS.md` if architecture or commands changed.

**E2E scenarios**

- Fresh profile with the default local model: workspace index appears, starts, chunks, enqueues, embeds.
- Fresh profile reconfigured to a hosted model without its provider key: blocked state appears, no fallback.
- Pause/resume: pause stops new work; resume self-heals.
- Foreground assistant query during active embedding: query completes and background resumes.
- Collection browser: workspace index is visible but not selectable/editable/deletable/searchable through normal selector.
- Hybrid search spinner only reflects active query execution.

**Manual testing**

- Start desktop agent debug server:

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug
```

- Use Chrome DevTools or Browser/Computer Use to inspect:
  - hidden host status events
  - visible settings state
  - collection picker disabled affordance
  - queue stats
  - pause/resume behavior
  - assistant query while background embedding is active
  - power-save-blocker diagnostics

Do not add `--remote-debugging-port` to default desktop E2E.

**Commands**

- `pnpm --dir apps/desktop test:e2e e2e/background-indexing-settings.desktop.test.ts`
- `pnpm --dir apps/desktop test:e2e e2e/background-indexing-pause.desktop.test.ts --project=smoke`
- `pnpm --dir apps/desktop test:e2e e2e/workspace-index-bootstrap.desktop.test.ts`
- `pnpm lint && pnpm type-check && pnpm build && pnpm test`

**Exit criteria**

- Product flow is verified in desktop.
- Manual debugging notes are captured in PR notes or this PRD revision history.
- Full local gate passes.

**Implementation note v1.1**

- `workspace-index-bootstrap.desktop.test.ts` verifies a fresh desktop profile creates exactly one protected `Workspace Index` row with `system_role = 'workspace-index'`, `local::Xenova/all-MiniLM-L6-v2`, and 384 dimensions, then binds it in settings.
- `background-indexing-settings.desktop.test.ts` now verifies stale managed collection preferences rebind to the protected Workspace Index instead of surfacing stale metadata.
- `background-indexing-pause.desktop.test.ts` verifies the settings pause/resume control persists `paused=true/false` through the Electron storage bridge after the Workspace Index is bootstrapped. It uses keyboard activation to exercise the accessible control deterministically in the Electron e2e harness.
- Desktop e2e command syntax is `pnpm --dir apps/desktop test:e2e e2e/<file>.desktop.test.ts`; do not insert an extra `--` before file arguments because the script already delegates through `run-env`.

**Manual verification note v1.2**

- Command: `pnpm --filter @brainstrike/desktop dev:agent-debug`.
- Environment: macOS desktop dev build, Electron 41.2.1, Node 24.14.1, isolated Agent DevTools profile, commit `2d9f64c5b`.
- Chrome DevTools/CDP target: visible renderer at `http://localhost:38181/`.
- Observed: fresh isolated profile showed a single `Workspace Index` collection row with the OpenAI small default before v1.3. Re-verify against the local MiniLM 384D default before merge.
- Observed: `window.embeddingHost.getStatus()` returned `state: 'stopped'`, `active: false`, `lastError: null` in the no-key profile; no background embedding work started.
- Observed: `window.power.getSnapshot()` returned idle/AC/nominal platform inputs, proving the visible renderer can read the desktop QoS power bridge.
- Observed: the Workspace Index collection row rendered as `role="option"` with `aria-disabled="true"`, and clicking it did not change `brainstrike.activeEmbeddingSetId`.
- Observed: Export and Import actions were disabled for the Workspace Index row. Initial inspection found generic hybrid-search controls still enabled when no valid active collection was selected; commit `2d9f64c5b` adds a disabled SearchModeBar path for any actual Workspace Index active-collection state, with unit coverage in `@brainstrike/ui` and integration coverage in `@brainstrike/db-explorer`.
- Console observation: the no-key profile emitted `[WorkspaceCollectionSyncProvider] Workspace collection sync failed`, which is the current missing-provider-key blocked path. The manual check did not observe fallback embedding work.

## 11. TDD and Commit Discipline

Each implementation PR must follow this loop:

1. Write the smallest failing unit/integration/e2e test for the next behavior.
2. Run the targeted command and capture the expected failure.
3. Implement the minimum code to pass.
4. Run the targeted command and confirm pass.
5. Refactor only if needed.
6. Run affected package lint/type checks.
7. Commit.
8. Repeat.
9. Before PR ready state, run the broader affected gate.

Commit standards:

- Prefer one behavior per commit.
- Prefer `test:` commit before `feat:`/`fix:` when the red state is lint-clean.
- If Biome/TypeScript rejects a red stub state, keep test-first ordering in the diff and explain the combined red/green cycle in the PR notes.
- Use conventional commits:
  - `test: cover workspace index bootstrap`
  - `feat: create default workspace index`
  - `fix: recover desktop embedding backfill queue`
  - `refactor: centralize workspace index status`
  - `docs: update workspace index PRD`
- Never commit generated CI proof artifacts.
- Do not add CI labels.

## 12. Verification Gates

### Per-PR Minimum

Every PR must run:

- Targeted tests for changed packages.
- `pnpm lint`
- `pnpm type-check`

### Before Calling a Phase Complete

Run the relevant broader gate:

- DB/schema changes: `pnpm --filter @brainstrike/db test` plus `pnpm --filter @brainstrike/db run test:db:check-lanes`.
- App-shell background indexing changes: `pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/indexing-contract-boundary.test.ts src/background-indexing/__tests__/workspace-collection-sync-service.test.ts`.
- Desktop main/IPC changes: `pnpm --dir apps/desktop test`.
- UI collection changes: affected UI/vector/db-explorer tests plus Playwright where applicable.
- Assistant retrieval changes: affected desktop assistant and agent retrieval tests.

### Final Integration Gate

Before the final implementation PR is marked done:

```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

If Node version drift appears, use the known Brainstrike gate form:

```bash
PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm lint && pnpm type-check && pnpm build && pnpm test
```

## 13. Manual Testing Protocol

Manual testing is required for phases that touch desktop UI, hidden host lifecycle, foreground query coordination, or power/QoS behavior.

Use one or more of:

- Browser plugin for local app inspection.
- Chrome DevTools for console/network/state inspection when a local target is available.
- Computer Use for desktop app UI flows that are not reachable through Browser.

Manual checklist:

- Fresh profile boot.
- Existing profile with stale managed collection ID.
- Existing profile with a user-created collection named similarly to Workspace Index.
- Missing hosted-provider key after a user reconfigures the Workspace Index away from the local default.
- Key added after blocked state.
- Pause while scanning.
- Pause while embedding.
- Resume after pause.
- Assistant query during background embedding.
- Large queue backfill.
- App minimized.
- App idle on AC.
- App on battery or constrained thermal state where available.

Record:

- Environment.
- Commit SHA.
- Commands used.
- Observed status transitions.
- Any console errors.
- Screenshots only when useful for a UI regression.

## 14. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---:|---:|---|
| Bootstrap creates duplicate workspace index collections | Medium | High | DB-level uniqueness on system role or transactional find/create. |
| Missing provider key accidentally triggers fallback | Medium | High | Unit tests assert typed blocked reason and no alternate provider call. |
| Protected collection blocks legitimate advanced search | Medium | Medium | Add dedicated read-only workspace index inspector/search path. |
| Assistant still uses selected user collection | Medium | High | Retrieval resolver tests for default workspace path. |
| Queue recovery hides real failures | Medium | High | Bounded retry policy, visible failed counts, explicit terminal error. |
| QoS controller becomes too broad | Medium | Medium | Start with v1 state machine and caps; no speculative inputs. |
| E2E flakes in desktop headless | Medium | Medium | Prefer unit/integration for logic; use desktop e2e for product flow only. |
| Schema migration touches active user data | Low | High | Add migration tests and preserve existing collections as user-owned. |

## 15. Open Decisions

| ID | Decision | Current recommendation | Owner | Status |
|---|---|---|---|---|
| D1 | DB representation for system collection role | Add first-class columns, not tags/category. | Engineering | Implemented |
| D2 | Whether workspace index can be directly searched by advanced users | Provide a dedicated inspector/search path, not normal collection selector. | Product/Engineering | Proposed |
| D3 | Background backfill completion semantics | Decouple durable enqueue from full drain for background source, or make drain policy adaptive. | Engineering | Proposed |
| D4 | Assistant retrieval default path | Workspace/codebase retrieval defaults to Workspace Index when ready; coverage stats stay on `listEmbeddingSpaces`. | Engineering | Implemented |
| D5 | Default Workspace Index model | Use local `Xenova/all-MiniLM-L6-v2`, 384D, cosine by default; hosted models require explicit later reconfiguration and typed missing-key blocking. | Product/Engineering | Implemented |

## 16. PRD Maintenance Rules

Update this PRD when:

- A phase starts or completes.
- A file path or package ownership changes.
- A status name changes.
- A default model/dimension changes.
- A TDD exception is needed because lint/type checking cannot represent a red stub state.
- Manual testing finds a gap.
- A phase is split, merged, or deferred.

Each PR that changes scope should add a revision-history row and update `Open Decisions` or `Work Breakdown` as needed.

## 17. Source Documents

- `docs/background-indexer-deep-dive-2026-06-07.md`
- `docs/bst-364-background-throttling-qos-research-2026-05.md`
- `apps/docs/docs/architecture/embedding-pipeline.md`
- `apps/docs/docs/reference/adr/queue-boundaries.md`
- `docs/superpowers/specs/2026-06-05-embedding-host-query-coordination-design.md`
- `docs/superpowers/plans/2026-06-05-embedding-host-query-coordination.md`
- Electron BrowserWindow docs: https://www.electronjs.org/docs/latest/api/browser-window
- Electron powerSaveBlocker docs: https://www.electronjs.org/docs/latest/api/power-save-blocker
- Electron powerMonitor docs: https://www.electronjs.org/docs/latest/api/power-monitor
- Chrome Page Lifecycle API: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- MDN Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- MDN Background Tasks API: https://developer.mozilla.org/en-US/docs/Web/API/Background_Tasks_API
- MDN Web Workers API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
- OpenAI embeddings guide: https://developers.openai.com/api/docs/guides/embeddings
- Google Gemini embeddings guide: https://ai.google.dev/gemini-api/docs/embeddings
