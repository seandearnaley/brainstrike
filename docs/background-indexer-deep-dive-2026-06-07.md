# Background Indexer Deep Dive

Date: 2026-06-07

Scope: desktop background indexing, managed workspace collection behavior, chunking and embedding flow, assistant query coordination, UI status, and QoS direction.

This is analysis only. No implementation changes were made.

## Executive Summary

The current desktop architecture is directionally correct: local embedding work runs in a hidden renderer host, not Electron main; a foreground query gate prevents new background embedding batches while assistant query embeddings run; and background work already uses a background-priority DB handle. That is a solid base.

The product behavior is not integral yet. A fresh app instance starts with background indexing disabled and no managed collection. The user must create/select a collection and wire it in settings. That matches the jank the user described.

The background path does embed, but it intentionally does not embed during import. It chunks first, assigns chunks to the managed collection, then enqueues a durable `embed_chunk` backfill. If a user sees "chunking finishes, embeddings never appear," the likely causes are missing managed collection bootstrap, missing hosted API key, host/runtime failure, queue blockage, or drain-timeout behavior rather than the absence of an embedding worker.

The shortest path would be setting `enabled: true` and choosing a default `managedCollectionId` in localStorage. That is not enough and is likely wrong. This should be treated as a small architecture change: a DB-owned system workspace index collection with deterministic role metadata, a bootstrap/self-heal service, collection-selector behavior that can render the system collection as visible but not selectable for normal hybrid search, and an explicit QoS controller.

Default model recommendation for the current codebase: create the first workspace index with `openai::text-embedding-3-small`, `modelId: text-embedding-3-small`, `dimensions: 1536`, `distance: cosine`. This is the current default hosted OpenAI embedding model in Brainstrike's provider registry and OpenAI documents 1536 dimensions as its default. If the OpenAI key is absent, the workspace index should enter a blocked status with a specific error. It must not silently fall back to local, Google, or any other provider.

## Current Pipeline

### 1. Hidden Desktop Host

The desktop hidden host is created as a hidden `BrowserWindow` with `show: false`, `skipTaskbar: true`, `focusable: false`, hardened web preferences, and `backgroundThrottling: false` in `apps/desktop/src/renderer-host-lifecycle.ts:323-345`. New window creation is denied at `apps/desktop/src/renderer-host-lifecycle.ts:347-348`.

The embedding host manager starts the hidden renderer when needed and exposes a foreground query bridge. `apps/desktop/src/embedding-host-manager.ts:246-294` ensures the host is running before query embeddings and caps pending query requests. It scopes `powerSaveBlocker.start('prevent-app-suspension')` to active embedding work and stops it after idle grace in `apps/desktop/src/embedding-host-manager.ts:383-418`.

This matches official Electron guidance: disabling `backgroundThrottling` keeps animations/timers from being background-throttled for that page, and `prevent-app-suspension` is the right power-save blocker class for long-running work that should keep the app active while still allowing the screen to sleep.

### 2. Foreground Query Coordination

The foreground gate is implemented in `packages/embeddings/src/worker/foreground-embedding-gate.ts`. Its contract is correct: close the gate for a foreground query, wait for the active background inference batch to finish, generate the query embedding, then reopen after a short delay. The worker only waits at the claim permit, not completion, which avoids deadlock while draining.

The hidden host wires this gate in `apps/desktop/src/renderer/components/embedding-host-runtime.tsx:342-405` for query embedding requests and in `apps/desktop/src/renderer/components/embedding-worker-config.ts:119-132` for worker claim permits. Constants match the project doc: `FOREGROUND_GATE_REOPEN_MS = 250` and `QUERY_DRAIN_TIMEOUT_MS = 5000`.

One improvement: `composeClaimPermit` waits on the gate without an abort signal because the worker permit type does not accept one. This can delay worker shutdown during a foreground query window. It is not the main bug, but a robust QoS controller should make permit waits cancellable.

### 3. Background Sync Orchestration

Background indexing is preferences-driven today. `packages/preferences/src/stores/background-indexing-preferences-store.ts:71-78` defaults to:

- `enabled: false`
- `managedCollectionId: null`
- `indexingPolicyPreset: balanced`
- `mode: root-folder-cache`
- `paused: false`

This proves the first-run experience is not integral.

`packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx` creates a background-priority DB handle, validates hosted provider access, ensures the embedding runtime starts, registers pause handling, and instantiates `WorkspaceCollectionSyncService`.

`WorkspaceCollectionSyncService` in `packages/app-shell/src/background-indexing/workspace-collection-sync-service.ts` resolves the managed collection and root handle, scans the tree, imports/chunks changes, and then enqueues backfill. It also has recovery and cancellation paths for in-flight background backfills.

### 4. Chunk First, Then Backfill

The root-folder-cache import path in `packages/app-shell/src/background-indexing/workspace-collection-sync-import.ts` intentionally sets:

- `chunking.enabled: true`
- `embedding.enabled: false`
- `resolveTargetEmbeddingSetId: () => collection.id`

This means the import phase chunks and assigns chunks to the managed embedding set, but does not call an embedding provider inline. After import, the service calls `enqueueManagedBackfill`, which enqueues durable `embed_chunk` jobs.

This is a good separation of concerns. It keeps importing/chunking from holding a provider/runtime dependency in the inner import loop. The UI should make the phase split clear: "chunking" complete is not "workspace index embedded" complete.

### 5. Backfill and Worker Embedding

The desktop backfill path is in `apps/desktop/src/ipc-embedding-backfill.ts` and `apps/desktop/src/embedding-backfill.ts`.

`apps/desktop/src/embedding-backfill.ts:511-541` enqueues `embed_chunk` jobs with `chunkId`, `fileRecordId`, `embeddingSetId`, `modelKey`, and `expectedDimension`. It uses dedupe keys of `chunkId:embeddingSetId:contentHash`.

The renderer worker in `packages/embeddings/src/worker/embedding-worker.ts` claims jobs, generates embeddings, validates dimensions, and persists them through `updateChunkEmbeddingBatch` before completing the job. `packages/embeddings/src/worker/embedding-worker.ts:854-920` is the persistence path.

Answer to "does it even do the embedding?": yes, once `embed_chunk` jobs reach the queue and the hidden host worker is running. The implementation chunks first and embeds through durable backfill.

## Product and UX Findings

### P0: No Default Workspace Index Bootstrap

Current first-run state requires manual setup. There is no service that creates a default managed collection, enables the background index, and binds preferences.

Recommendation:

- Add a DB-backed workspace index bootstrap service.
- It should run after DB and model registry initialization.
- If no managed collection exists, create one with a deterministic system role and set it as managed.
- If preferences point to a missing collection, self-heal by finding the system collection or recreating it.
- If the default provider key is missing, set status to blocked with a specific message. Do not fall back.

### P1: Managed Collection Is Still an Ordinary Selectable Collection

The database explorer knows when the active collection is the managed collection and disables manual import (`packages/db-explorer/src/database-demo-panel.tsx:666-695`). It also shows a small managed warning at `packages/db-explorer/src/database-demo-panel.tsx:636-640`.

But the collection itself is still selectable, editable, deletable, and searchable:

- `packages/ui/src/collection-picker/collection-picker.tsx:57-63` always selects the clicked collection.
- `packages/ui/src/collection-picker/collection-picker.tsx:99-105` keyboard selection also always selects the focused collection.
- `packages/ui/src/collection-picker/collection-picker-item.tsx:45-63` always selects/edits/deletes with no disabled or system-owned path.
- `packages/vector-management/src/collection-select/collection-select.tsx:687-705` renders every collection as a selectable `SelectItem`.
- `packages/db-explorer/src/components/collection-browser-view.tsx:681-690` runs hybrid/semantic search against the active collection ID with no managed-collection guard.

Recommendation:

- Add a first-class collection role, such as `systemRole = 'workspace-index'`, not just a preference pointer.
- Update collection picker/select APIs to support disabled rows with a reason.
- Keep the workspace index visible with a "Workspace Index" badge and coverage counts.
- Disable normal selection for Database Explorer hybrid search and manual import.
- Disable edit/delete for system-owned collections.
- Provide a separate read-only "Workspace Index" inspector/search route if advanced users need to query it directly. Do not overload the normal collection selector.

### P1: Assistant Retrieval Has Two Paths With Different Defaults

The desktop assistant now has `listEmbeddingSpaces` and `queryEmbeddingSpace`. `apps/desktop/src/assistant-server/assistant-tools.ts:1226-1283` marks the configured workspace index as `recommendedForWorkspaceSearch`, and the tool description tells the model to prefer that space.

The older retrieval tool still resolves only `runtime.embeddingSetId` or an explicit input ID. In the desktop implementation, `apps/desktop/src/assistant-server/retrieval-tool.ts:356-360` returns `runtime.embeddingSetId` before `inputEmbeddingSetId`; the package implementation in `packages/agent/src/tools/retrieval-tool.ts:257-262` does input first, then runtime. Neither automatically uses `workspaceIndexEmbeddingSetId`.

Recommendation:

- Decide one canonical assistant workspace-search path.
- For codebase/workspace questions, the assistant should use the system workspace index by default when it is enabled and not blocked.
- The tool should surface a precise blocked status when the workspace index exists but is paused, missing embeddings, missing provider credentials, or still below a minimum coverage threshold.
- Avoid requiring the model to remember a two-step "list spaces then query explicit ID" dance for the primary app feature.

### P1: Desktop Backfill Lacks the Queue Recovery Used Elsewhere

Manual/vector-management backfill calls `recoverBackfillQueueState` before counting candidates. That repair path runs `repairUnclaimableQueued` and `requeueFailed` for the active embedding set in `packages/vector-management/src/vector-status/vector-queue-service.ts:638-655`.

Desktop backfill in `apps/desktop/src/embedding-backfill.ts` counts candidates by excluding chunks with queued/running dedupe jobs. `packages/db/src/queue/job-queue.ts:487-555` only claims jobs with `attempts < max_attempts`. `packages/db/src/queue/job-queue.ts:1240-1275` exists specifically to repair queued jobs with exhausted attempts.

The desktop backfill code does not call that recovery before `countBackfillCandidates`.

Failure mode:

- A chunk has a queued/running dedupe job.
- The job is unclaimable, for example queued with `attempts >= max_attempts`.
- Candidate counting excludes the chunk because a queued/running dedupe row exists.
- The worker never claims that job because attempts are exhausted.
- The background index can look permanently stuck with missing embeddings.

Recommendation:

- Make desktop backfill use the same scoped recovery path before counting candidates.
- Add a test that creates an unclaimable queued `embed_chunk` job and proves background backfill repairs/requeues it instead of reporting zero candidates.

### P1: Background Backfill Waits Are Too Synchronous for a Forever-ish Indexer

`apps/desktop/src/embedding-backfill.ts:72-77` uses a 300 second default drain timeout. The background IPC path extends queue capacity wait to 10 minutes for background indexing, but it does not extend the drain timeout (`apps/desktop/src/ipc-embedding-backfill.ts:306-310`).

For a large workspace, this can fail after all jobs are enqueued if the hidden worker needs more than five minutes to drain them. That is at odds with the product goal of a background service that "does its business" over time.

Recommendation:

- Decouple "durably enqueued" from "fully drained" for background indexing, or make the drain deadline policy adaptive and background-specific.
- The sync call should not need to sit inside one long blocking promise for the full index lifecycle.
- The UI should show durable queue progress and last successful drain rather than treating a long drain as a foreground operation.

### P2: QoS Exists, But It Is Not Yet an Adaptive Policy

Existing QoS components:

- Background DB priority handle and scheduler pressure snapshots.
- Worker claim batch collapse under pressure in `embedding-worker-config.ts`.
- Foreground query gate and drain.
- Hidden host `backgroundThrottling: false`.
- Power save blocker scoped to active hidden-host work.
- User pause via background work arbiter.

Missing QoS components:

- A single policy state machine that considers user activity, app visibility, system idle, battery, thermal pressure, queue health, and provider rate pressure.
- Adaptive scan/import/chunk/enqueue parameters. Many current knobs are static: content batch size 24, content concurrency 4, backfill batch 32, queue depth 64, interbatch delay 75 ms.
- Clear observability showing why the indexer is paused, slow, active, or blocked.

Recommendation:

Build an `IndexingQoSController` with explicit inputs and outputs:

Inputs:

- Foreground query gate state.
- Recent user input/visible renderer interaction.
- `document.visibilityState` and app/window lifecycle.
- Electron `powerMonitor.getSystemIdleState`, `getSystemIdleTime`, `isOnBatteryPower`, `getCurrentThermalState`, and related events.
- DB scheduler pressure snapshots and queue depth.
- Provider errors/rate-limit signals.
- Manual pause.

Outputs:

- Scan batch size.
- File read/content processing concurrency.
- Chunk import batch size.
- Backfill enqueue queue depth and batch size.
- Worker claim size.
- Interbatch delay.
- Progress notification cadence.
- Whether `prevent-app-suspension` may be held.

Suggested policy states:

- `manual-paused`: user explicitly paused; no scan/enqueue/claim except cleanup needed to reach a consistent paused state.
- `foreground-query`: no new background embedding claims; drain current inference batch, run query, reopen after debounce.
- `interactive`: visible app with recent user input; tiny claim size, longer interbatch delay, low scan/import concurrency.
- `settled`: visible app but idle; moderate concurrency.
- `background-on-ac`: app not actively used and AC power available; higher throughput while still yielding to DB pressure.
- `constrained`: battery, serious/critical thermal, locked screen, or high DB pressure; pause or minimal trickle.
- `blocked`: missing provider key/model config/root handle/permission. No fallback.

This is more canonical than timer-only throttling. Official browser docs make clear that hidden pages and timers are subject to throttling/freezing, `requestIdleCallback` is not available in Web Workers, and long-running worker work needs explicit lifecycle and cancellation.

### P2: Model Config Error Handling Hides Root Cause

`packages/embeddings/src/worker/embedding-model-config.ts` catches DB query failures and returns `null`. The downstream code then reports a model-not-found style error. For this project's no-silent-degradation rule, that is too lossy.

Recommendation:

- Return "not found" only when the query succeeds and finds no row.
- Throw a typed/configured error for DB query failure, including provider/model identifiers and the root cause.

### P2: Repeated Full Content Reads Can Be Expensive

The background sync path reads contents to detect changes and then the import path reads contents again. This is behaviorally clean, but it can be costly for large roots.

Recommendation:

- Add a metadata prefilter before content hashing when file-system metadata is available and reliable.
- Store and compare size/mtime/source fingerprint where possible, then content-hash only likely-changed files.
- Do not guess freshness from metadata alone unless the invalidation contract is explicit and tested.

### P2: Google Model Catalog May Be Behind Current Provider Docs

Brainstrike's current registry includes `gemini-embedding-001`. Google's current embedding docs now present `gemini-embedding-2` as the latest Gemini embedding model, while keeping `gemini-embedding-001` available for text-only use cases.

Recommendation:

- Do not switch the default workspace index to an unregistered model in this work.
- Open a separate model-catalog audit if Brainstrike wants the "main remote model" to mean latest cross-provider model rather than current app-supported default.
- Any catalog change must follow the multi-layer model catalog migration contract in `AGENTS.md`.

## Recommended Target Architecture

### System Collection Bootstrap

Create a durable "Workspace Index" system collection owned by the app, not by a settings dropdown.

Required properties:

- First-class system role in the DB, not only localStorage.
- Deterministic uniqueness: exactly one workspace index collection per profile/workspace scope.
- Default model: `openai::text-embedding-3-small`, 1536 dimensions, cosine distance.
- Default status: enabled unless provider credentials are missing.
- Missing provider key: blocked status with a direct settings action.
- Missing collection after delete/reset: recreate or rebind based on policy.
- User model change: explicit reindex flow; preserve old collection until the replacement is ready or clearly mark migration state.

Do not hide this entirely. Keep it visible for trust and diagnostics, but remove it from ordinary manual collection workflows.

### Collection Selection Contract

Add system-aware collection metadata to list queries and UI types:

- `systemRole`
- `isSystemOwned`
- `selectability`
- `disabledReason`
- `canEdit`
- `canDelete`
- `canManualImport`
- `canHybridSearch`

Then wire these through:

- `EmbeddingSetsRepository.listEmbeddingSpaces`
- `useCollections`
- `CollectionPicker`
- `CollectionSelect`
- `SearchCollectionSelector`
- `CollectionBrowserView`
- delete/rename dialogs
- assistant embedding-space listing

### Workspace Index UI

Rename the product surface from "Background indexing" to "Workspace Index" in user-facing copy. Keep "background indexing" for implementation docs and diagnostics.

UI states should be explicit:

- Ready: indexed and queryable.
- Updating: scanning/importing/chunking/enqueuing/embedding.
- Paused by user.
- Yielding to foreground work.
- Waiting for provider key.
- Waiting for workspace folder permission.
- Recovering queue.
- Error with last error and retry action.

The hybrid search panel should not show background-update activity as query loading. The query spinner should mean one thing: the current query is running.

### Assistant Retrieval Contract

Assistant workspace retrieval should not depend on a user-selected normal collection. The configured workspace index should be the default retrieval source for workspace/codebase questions.

Requirements:

- If workspace index is ready, retrieval should hit it without user collection selection.
- If it is not ready, the assistant should receive a structured status and explain what is missing.
- Foreground query embeddings must continue through the hidden host/gate path so background indexing cannot occupy the GPU at the same time.
- Coverage thresholds should be explicit. For example, the assistant can search partially indexed data but must know `embeddedChunks`, `totalChunks`, and last update time.

### Self-Healing Queue and Host Behavior

The background indexer should repair known durable queue states before concluding there is no work:

- Requeue failed scoped jobs within a bounded retry policy.
- Repair unclaimable queued jobs scoped to the workspace index.
- Detect stuck running jobs by lease expiration.
- Keep failed job counts visible.
- Do not erase failures silently.

Host behavior:

- Hidden host starts on demand and for enabled background indexing.
- Host reports active/idle/error.
- `prevent-app-suspension` is held only while embedding inference is actively draining useful work.
- Query requests have backpressure and explicit timeout.
- Worker permit waits are abortable.

## Validation Plan

Unit and integration tests:

- First-run bootstrap creates the workspace index and sets managed preferences.
- Missing provider key creates a blocked state and does not fall back.
- Stale/missing managed collection self-heals.
- Collection picker renders workspace index visible but disabled for normal selection.
- Edit/delete/import actions are unavailable for system-owned collection.
- Hybrid search cannot run against the system workspace index through the normal collection browser.
- Assistant workspace retrieval defaults to the workspace index or reports a structured blocked state.
- Desktop backfill repairs unclaimable queued jobs before candidate counting.
- Background backfill does not fail purely because drain exceeds the current 300 second foreground-style timeout.
- `getModelConfigFromDb` distinguishes DB query failure from model-not-found.
- Worker claim permit can abort during shutdown.

Desktop E2E:

- Fresh profile, root folder selected, provider key present: workspace index appears automatically, scans, chunks, enqueues, embeds, and reports coverage.
- Fresh profile, provider key absent: workspace index appears blocked, no fallback provider is used, and adding a key resumes.
- Background embedding active, assistant query starts: current batch drains, query embedding completes, background resumes.
- User pauses: scan/enqueue/backfill stop or cancel into a consistent paused state; resume self-heals.
- Hybrid search panel query spinner only appears for active query execution.
- Workspace index is visible in collection list but cannot be selected for normal hybrid search/edit/delete/import.

Operational validation:

- Run the full local gate after implementation: `pnpm lint && pnpm type-check && pnpm build && pnpm test`.
- Add targeted desktop tests for queue repair and bootstrap before relying on CI.
- Use desktop diagnostics to capture host status, active backfills, queue stats, power blocker status, and QoS state.

## Source Notes

Official docs checked during this analysis:

- Electron `BrowserWindow` `backgroundThrottling`: https://www.electronjs.org/docs/latest/api/browser-window
- Electron `powerSaveBlocker`: https://www.electronjs.org/docs/latest/api/power-save-blocker
- Electron `powerMonitor`: https://www.electronjs.org/docs/latest/api/power-monitor
- Chrome Page Lifecycle API: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- MDN Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- MDN Prioritized Task Scheduling API: https://developer.mozilla.org/en-US/docs/Web/API/Prioritized_Task_Scheduling_API
- MDN Background Tasks API: https://developer.mozilla.org/en-US/docs/Web/API/Background_Tasks_API
- MDN Web Workers API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
- OpenAI embeddings guide: https://developers.openai.com/api/docs/guides/embeddings
- OpenAI `text-embedding-3-small` model page: https://developers.openai.com/api/docs/models/text-embedding-3-small
- Google Gemini embeddings: https://ai.google.dev/gemini-api/docs/embeddings

Relevant local docs:

- `docs/bst-364-background-throttling-qos-research-2026-05.md`
- `apps/docs/docs/architecture/embedding-pipeline.md`
- `apps/docs/docs/reference/adr/queue-boundaries.md`
- `docs/superpowers/specs/2026-06-05-embedding-host-query-coordination-design.md`
- `docs/superpowers/plans/2026-06-05-embedding-host-query-coordination.md`

