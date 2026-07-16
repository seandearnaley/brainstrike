# Assistant Persistence, Notifications, Context Meter

> Extracted from AGENTS.md (2026-07-12). Read before changing message persistence/hydration, run notifications, or token-budget wiring. Keep updated with the code.

## ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION

Hosted-provider turns are persisted by Mastra (the durable writer) into
`mastra_messages`; the client history adapter is read-through only. Two
contracts keep reloaded threads identical to live ones:

1. **Persisted dialect (Mastra v2 / `MastraMessageContentV2`):** content is
   `{ format: 2, parts: [...] }`. Tool calls are
   `{ type: 'tool-invocation', toolInvocation: { toolCallId, toolName, args,
   state, result } }` parts with results INLINE — there are NO `role: 'tool'`
   rows in this dialect (the legacy `tool-call` part + separate tool rows is
   still supported for old data). Reasoning may arrive with a `reasoning`
   field instead of `text` (and is often empty for encrypted provider
   reasoning). `step-start` and `data-om-*` bookkeeping parts are not
   renderable. Live-loop proof (real agent + real PGlite memory, no mocks):
   packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts. Hydration
   fixtures must mirror REAL persisted rows, never hand-written shapes — a
   hand-written `tool-call` fixture previously kept tests green while real
   tool history silently vanished on every reload.
2. **Snapshot grouping + live-order interleaving:** observational-memory
   sealing and per-step saves split ONE live assistant turn into several
   `mastra_messages` rows (progressive snapshots under fresh ids, so one
   toolCallId can appear in several rows). Hydration
   (packages/app-shell/src/assistant-memory-repository.ts) therefore:
   - merges consecutive assistant rows into ONE assistant-ui message (id =
     last row, createdAt = first row; legacy `role: 'tool'` rows don't split
     a group),
   - dedupes tool calls by toolCallId (first occurrence wins; later
     result/error fields merge in),
   - recalls the latest 80 message rows together with events from the latest
     80 runs, partitions events by `runId`, assigns each run to the assistant
     turn inside that run's time window, and weaves them between content parts
     in time order. Never attach only the newest run to the newest message:
     older turns would lose tool failure state, timings, and subagent activity
     after reload. Tool-invocation parts carry no persisted timestamp, so each
     is re-timed to its `tool.started` run event (matched via
     `metadata.toolCallId`); other untimed parts anchor to their snapshot row's
     save time. Equal-timestamp rows use Mastra's per-part `createdAt` values
     before the row role/id fallback. A group with only run events still
     renders.
   - recognizes guarded tool results with the canonical
     `@brainstrike/assistant-contract` type guard. A known guarded result
     (`ok:false`) hydrates as a failed tool call even though Mastra persists
     the invocation itself with `state:'result'`; the execution and replay
     paths must never maintain independent guarded-error code lists.
3. **Edited-prompt branch topology:** Mastra remains the only writer of message
   CONTENT, but its rows do not retain assistant-ui's parent graph. The client
   history adapter therefore persists only `{messageId,parentId}` edges in
   `brainstrike_assistant_message_parents` (migration 055) from its canonical
   `append({message,parentId})` callback. An edge may land before Mastra saves
   the matching content row, so `message_id`/`parent_id` intentionally have no
   message FK. It also has no thread FK because the numbered migration runner
   executes against a bare schema; app-shell thread deletion and factory reset
   explicitly own cleanup. Hydration LEFT JOINs these edges and
   uses an explicit parent (including explicit `null`) instead of chronological
   chaining, which reconstructs edited prompts/regenerations as carousel
   siblings after reload. Rows without an edge are legacy data and retain the
   chronological fallback. The bounded 80-row hydration window is always a
   closed graph: retained messages whose parent fell outside the window are
   explicitly re-rooted. Hydration then performs a stable parent-first graph
   traversal so assistant-ui never imports a dangling or not-yet-imported
   parent. Mastra message creation time is immutable on same-id saves: a
   regeneration reuses its parent user id, and moving that legacy row later
   would invert pre-topology history.
   Conflicting edges for the same message id throw — branch corruption is never
   silently rewritten. Factory reset clears the companion table explicitly.
   The UI transport preserves each assistant-ui user message id through the
   generic-message conversion, and the desktop request parser preserves
   assistant-ui's `unstable_assistantMessageId`; the stream session and Mastra
   id generator both use those validated ids for the persisted user/visible
   assistant pair. A normally finished stream asserts that the one-shot Mastra
   generator consumed the assistant id through its memory message context,
   making upstream contract drift visible instead of quietly substituting a
   UUID. Initial turns and both approval/suspend resume paths pass a separate
   per-call stream-id generator with the same initial id; the Mastra-global
   generator remains reserved for the persisted memory row, so a transient
   resume stream id cannot consume the durable identity first. If
   observational-memory sealing creates additional snapshot rows,
   hydration keeps the topology-bearing row's id for the combined assistant-ui
   message. A new topology-bearing assistant id always starts a new hydration
   group, including after an open legacy group, so consecutive regenerated
   responses remain carousel siblings rather than being mistaken for snapshots
   of one response.
   This end-to-end identity alignment is what lets a later edited prompt point
   to its durable assistant parent without correlation heuristics.

Image attachments (composer → model → persistence → reload):
- The composer's attachment adapter (packages/ui assistant-ui-panel/
  attachment-adapter.ts) accepts IMAGES ONLY and enforces the shared caps in
  `@brainstrike/assistant-contract` assistant-attachments (allowlisted media
  types; 5MB/image; 4/message; 10MB combined) — the SAME module the server
  validates with, so client and server can never drift. Validation failures
  THROW (surfaced via the `composer.attachmentAddError` alert), never a
  silent drop/resize. The 16MB default request body limit is sized against
  the combined cap (base64 ≈ 13.4MB + prompt headroom).
- assistant-stream merges attachment content into the outgoing user message
  as `{type:'file', data:<base64 data URL>, mediaType}` parts; the agent's
  `convertAssistantUiMessages` intercepts file parts BEFORE the text walk
  (the base64 body must never flatten into prompt text), validates them, and
  `convertMessagesToMastra` emits an AI-SDK content ARRAY with a canonical
  user-message ImagePart (text-only messages keep the legacy string join).
- Mastra persists the user row with the v2 FILE dialect
  `{type:'file', data, mimeType}` (NOTE: `mimeType`, not `mediaType`) plus a
  flattened `content` text string and an `experimental_attachments` mirror —
  pinned from a REAL captured row in
  packages/agent mastra-memory-persistence.integration.spec.ts.
- Hydration (assistant-memory-repository `toUserHistoryAttachments`) rebuilds
  `message.attachments` from the persisted file dialect (image/* only);
  image-only user messages survive reload. Hydrated attachments render
  through the same user-bubble strip as live sends, and their content
  re-merges into later outbound turns so the model keeps seeing the image.
- Availability gating lives in the app-shell wrapper: data-stream transport
  only, never the text-only built-in local provider. Per-model vision
  capability gating is a documented FOLLOW-UP (the model catalog has no
  vision field yet); a non-vision hosted model rejects the image with a
  visible provider error.
Paired tests: assistant-attachments.test.ts (contract),
assistant-messages.spec.ts + mastra-image-input.spec.ts (agent, incl. the
live-loop prompt proof), mastra-memory-persistence.integration.spec.ts
(persisted dialect pin), assistant-memory-repository.integration.test.ts
(hydration), attachment-adapter.test.ts (composer adapter).

Built-in LOCAL provider turns persist on DESKTOP: local chat routes through
the assistant server's Mastra loop (see LOCAL LLM ARCHITECTURE), so memory,
run events, and reload hydration behave exactly like hosted providers.
Known gap: WEB local turns still use the in-renderer LocalRuntimeChat (no
history adapter) and remain session-only.

When changing message persistence or hydration, update this section and the
paired tests in packages/agent and packages/app-shell.

---

## ASSISTANT RUN NOTIFICATIONS

OS-level `Notification` API alerts for three run-lifecycle events — run
finished, run failed (including watchdog stalls surfacing as `run.failed`),
and tool approval required — fired only while the app is NOT the user's
active focus. One code path for Electron renderer AND web: the standard web
`Notification` constructor, no Electron `Notification` module, no new IPC.

Layers:
1. **Preferences** (`packages/preferences/src/stores/notification-preferences-store.ts`) —
   persisted master toggle (`masterEnabled`, default OFF) + per-event toggles
   (`events.{runFinished,runFailed,toolApprovalRequired}`, default ON).
   PERSISTED via the same `createBrowserJsonStorage` pattern as sibling
   stores. Registered in the factory-reset pipeline: like
   `permission-policy-store`, `resetNotificationPreferencesStoreToDefaults`
   is called directly from `factory-reset-helpers.ts`'s `clearBrowserStorage`
   (not `registerFactoryResetSessionStore` — that seam is for stores OUTSIDE
   the `preferences` package) so the live in-memory toggle never survives a
   reset that does not reload the page (web path).
2. **Decision + dispatch** (`packages/preferences/src/notifications/`) —
   `should-notify.ts` is a PURE gate (`shouldNotify`): master on, event on,
   `Notification.permission === 'granted'`, and the window is unfocused
   (`document.visibilityState === 'hidden' || !document.hasFocus()`,
   evaluated AT EVENT TIME). `notification-permission.ts` wraps
   `Notification.permission`/`requestPermission()` — permission is requested
   ONLY from the Settings toggle-on click (never on load), and the store
   never persists `masterEnabled: true` when the browser denies or has not
   granted permission. `run-notification-dispatcher.ts`
   (`createRunNotificationDispatcher`) evaluates the gate and constructs a
   `Notification` with privacy-safe copy. Coalescing key is `runId:kind` for
   run finished/failed and `runId:kind:toolCallId` for `toolApprovalRequired`,
   so a run that suspends for more than one distinct approval still alerts on
   each. The input is a discriminated union carrying only `runId`/`kind`/an
   optional `threadTitle` (plus a REQUIRED `toolCallId` on the approval
   variant), never message content or tool args — and wires `onclick` to
   `window.focus()`.
3. **Settings UI** (`packages/preferences/src/settings/system/notification-settings-section.tsx`,
   registered via `createNotificationSettingsCategory()` from its own
   `notification-settings-category.tsx` — a non-component module, kept out of
   `settings-page-content.tsx` so Fast Refresh preserves `SettingsPageContent`
   state; imported in both `apps/web/src/app/settings/page-content.tsx` and
   `apps/desktop/src/renderer/components/settings/page-content.tsx`) —
   master + per-event toggles, surfaces a "blocked by your browser/OS"
   message when permission is denied/unsupported.
4. **Trigger source** (`packages/ui/src/assistant-ui-panel/run-lifecycle-notifications.ts`) —
   pure selectors (`selectTerminalRunEvents`, `selectOpenToolApprovalRequests`)
   scan thread messages for `run.finished`/`run.failed`
   (`ASSISTANT_RUN_EVENT_DATA_NAME`) and tool-approval-required
   (`TOOL_APPROVAL_DATA_NAME`) data parts. `useRunLifecycleNotifications`
   reports each NEW one exactly once (deduped via refs) through THREE new
   optional `AssistantUiPanelProps` callbacks — and DEFERS seeding its "seen"
   baseline until `state.thread.isLoading` is false, so async history
   hydration (opening/reloading an existing thread first renders an empty
   snapshot) seeds the replayed history without firing stale notifications
   (`onRunFinished`/`onRunFailed`/`onToolApprovalRequired`) that thread the
   SAME 5 layers as `onUsage` (`AssistantUiPanel` → `LocalRuntimeChat`/
   `DataStreamRuntimeChat` → `ChatThreadUI`, which mounts
   `RunLifecycleNotificationBridge`). This package NEVER touches
   `window.Notification` or the preferences store — it only reports raw
   events, mirroring the `onUsage` seam.
5. **Composition** (`packages/app-shell/src/use-assistant-run-notifications.ts`,
   wired into `assistant-ui-panel-wrapper.tsx`) — the ONLY layer that reads
   live `document.hasFocus()`/`visibilityState` and owns a
   `createRunNotificationDispatcher` instance (stable for the panel's
   lifetime, so per-run coalescing is meaningful). Hosted turns coalesce on
   the wire `runId`; web local-runtime events carry no `runId`
   (`createLocalRunEvent` assigns only a per-event `id`), so the hook falls
   back to `event.id` — a stable, unique key, never a fabricated runId that
   could collide across runs. Desktop's hidden
   embedding/llm hosts (`embedding-host-app.tsx`, `llm-host-app.tsx`) never
   import `AssistantUiPanel` at all, so they structurally can never notify —
   this hook only ever runs inside the visible assistant surface.

When changing this flow, update this section and the paired tests
(`packages/preferences/src/__tests__/notification-*.test.ts(x)`,
`packages/ui/src/assistant-ui-panel/__tests__/run-lifecycle-notifications.test.ts`,
`packages/ui/src/assistant-ui-panel/__tests__/run-lifecycle-notifications-hydration.test.tsx`,
`packages/app-shell/src/__tests__/use-assistant-run-notifications.test.ts`).

---

## FOLLOW-UP MESSAGE QUEUE (COMPOSE DURING A RUN)

Report R3 v1 — the QUEUE half of mastra-code's steer/followUp pair. The
composer input already stays enabled during a run (only Send unmounts); this
adds a `QueueFollowUpButton` in the RUNNING branch (composer-input.tsx
`queueControl` seam), a per-thread zustand FIFO
(`packages/ui/src/assistant-ui-panel/follow-up-queue-store.ts`), removable
"queued" chips above the composer, and a render-nothing
`FollowUpQueueBridge` that dispatches ONE queued message per run end via
`aui.thread().append(...)` (the same programmatic-send seam the
approval/suspend notices use).

Settled semantics (v1 — revisit only with the steering stage):
- **Run-end detection is the `state.thread.isRunning` true→false transition**,
  NOT the run-event data parts — it works identically for the web local
  runtime (whose events carry no `runId`) and fires for finished, failed, AND
  user-cancelled runs alike; the chip's remove control is the user's veto.
- Hydration/thread-switch guards mirror `run-lifecycle-notifications.ts`: no
  dispatch while `state.thread.isLoading`; a `threadKey` change reseeds the
  transition baseline (a switch is never a run end).
- FIFO one-per-run-end: the next queued item waits for the dispatched run to
  end (natural steering loop). A synchronous `append` throw requeues at the
  FRONT and logs (`append` returns void in the installed assistant-ui — there
  is no async failure channel; a run that starts and then fails is a normal
  `run.failed`, not a dispatch failure).
- **Missed-run-end catch-up:** the bridge lives inside the threadKey-keyed
  runtime subtree, so a thread switch unmounts it and a run ending off-screen
  produces no observable transition. Once per (re)mounted key, an idle
  non-loading thread with a non-empty queue is treated as that missed run end
  and dispatched — the chip's promise ("sends when the current run ends")
  holds across thread switches.
- Session-lived, deliberately NOT persisted (a queued message surviving a
  reload would be a surprise send); registered with factory reset in
  app-shell's `register-factory-reset-session-stores.ts`.
- Mid-run STEERING (injecting into the live loop at a step boundary) is the
  explicit v2 follow-up and lives in the agent loop, not this UI seam.

When changing this flow, update this section and the paired tests
(`packages/ui/src/assistant-ui-panel/__tests__/follow-up-queue-store.test.ts`,
`packages/ui/src/assistant-ui-panel/__tests__/follow-up-queue.behavior.test.tsx`
— the behavior suite runs a REAL assistant-ui local runtime, no mocked state).

---


## CONTEXT USAGE METER (TOKEN AWARENESS)

One derivation feeds three consumers per request — keep them consistent:
`buildAgentLoopSettings(prefs, selectedModelBudgetDef)` in packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts
produces `agentLoopSettings.inputTokenLimit` (explicit user pref wins, else
`deriveEffectiveInputBudget(contextWindow, maxOutputTokens)` from
packages/assistant-contract/src/context-budget.ts — throws, never clamps). That ONE number is:
1. the Mastra `TokenLimiter` budget (`runtimeData.agentLoop.inputTokenLimit` → `buildToolLoopOptions`),
2. the meter denominator (`effectiveInputBudget` prop on `AssistantUiPanel`),
3. the instruction budget note (`buildContextBudgetNote`, appended per-request at Agent construction).

Runtime invariants:
- Usage store (packages/ui/src/assistant-ui-panel/context-usage-store.ts) is session-lived, NOT
  persisted; key = `selectedMemoryThreadId ?? 'active'` — the writer (`handleUsage` in the app-shell
  wrapper) and the reader (`ContextUsageMeter`, via the panel's `threadKey` prop) MUST use the same key.
- Both turn paths report usage: hosted via the data-stream `message-finish` tap
  (`onUsage` in data-stream-runtime.ts), local via the llm-host result (`onUsage` in
  local-runtime-adapter.ts; `LocalLlmGenerationResult.usage` is optional at the IPC boundary — guard it).
- The meter shows estimated (heuristic over thread messages) until exact usage lands; provenance
  must never lie — wire-format usage is `{inputTokens, outputTokens, billedCostUsd?}` (e2e mocks
  must use the token field names).
- OpenRouter finish messages must additionally carry `billedCostUsd`, sourced
  from Mastra's official OpenRouter provider metadata. Persist it in
  `brainstrike_assistant_run_usage.billed_cost_usd`; cumulative and cross-root
  views use the provider amount for reported rows and registry pricing only for
  legacy/unreported rows. Mixed groups add both portions and retain estimated
  provenance; entirely provider-reported groups use `provider-reported`.
  Approval/suspension pauses emit a zero-token finish without cost because
  Mastra emits the pause before exposing that model step's `step-finish`. On
  resume, Mastra emits the deferred pre-pause step finish and all subsequent
  steps; the normal terminal usage tap persists their exact aggregate once.
  Missing or malformed cost metadata on a new OpenRouter completion fails
  visibly rather than being mislabeled as an exact or zero-cost run.

---


## THREAD GROUPS (FOLDERS) IN THE THREADS PANEL

User-defined groups organize the Threads panel: rank-ordered group sections, an
**Ungrouped** section always last, drag-and-drop (Pragmatic drag and drop), and
a Group by / Sort by view-options popover. Plan/rationale:
`docs/thread-groups-plan-2026-07-12.md`.

Where state lives (do not relitigate):
- Groups: `brainstrike_assistant_thread_groups`; thread membership + manual
  order: `brainstrike_assistant_thread_placements` (migration 054; migration
  056 adds nullable validated folder `color` and independent `flat_rank`, seeded
  from the legacy `rank` so existing custom order survives the split; both are
  registered in both migration runners). Membership deliberately does NOT
  live in `mastra_threads.metadata`: grouping, folder color, and manual order
  are Brainstrike-owned presentation state while Mastra owns that schema.
- Thread icon/color metadata updates preserve conversational `updatedAt`; visual
  curation must never reshuffle a recency-sorted collection.
- Placements have no FK to `mastra_threads`: a placement whose thread is gone is
  inert (the panel joins by id). Bulk thread deletion removes placements and all
  owned thread rows in one guarded CTE; an unknown id mutates nothing. Deleting
  a group nulls its placements' `group_id` and removes the group in one CTE after
  staged UI confirmation, returning its threads to Ungrouped without partial
  state or discarding their independent flat-list ranks; the loaded store mirrors
  that transition by retaining each placement with `groupId: null`.
- `rank` columns are `fractional-indexing` keys (`generateKeyBetween`); a
  positional drop rewrites the destination section's ranks wholesale
  (`applyThreadOrder` → `setThreadPlacements`, a SINGLE multi-row upsert so the
  batch is atomic without the optional `DbHandle.transaction`; `reorderGroups` →
  `setGroupRanks` likewise) and silently switches Sort by → Custom so the drag
  is honored, never ignored. In Custom sort, unranked (new) threads render first
  by recency.
- View prefs (`groupBy`, independent `flatSortBy` / `groupedSortBy`, collapsed)
  persist via zustand `persist` (`brainstrike-assistant-thread-groups-v1`, state
  version 2); the store registers a session resetter in
  `register-factory-reset-session-stores.ts`.
- The Threads panel uses shared `TreeTable` as its only scroll owner. Folder
  rows are real expandable treegrid parents with Left/Right keyboard behavior.
  Disclosed section rows are virtualized and capped at 50 initially, with an
  explicit 50-row Show more action; folder selection still targets the complete
  section, while Select visible targets only disclosed threads.

Layers: repository `assistant-thread-groups-repository.ts` → store
`assistant-thread-groups-store.ts` → pure view-model `thread-list-sections.ts`
(grouping/sorting; `buildThreadMembership` is the single source of effective
membership) → drop resolution `threads-panel-dnd.ts` (pure intent reducer) →
element wiring `threads-panel-dnd-elements.tsx`. Semantic color presentation is
owned once in `assistant-thread-presentation.ts` and shared by rows, folders,
and tabs. Keyboard/a11y fallback for
every drag operation: row context-menu "Move to <group>" / "Remove from Group".

Paired tests: `migration-054-assistant-thread-groups.test.ts` and
`migration-056-assistant-thread-group-presentation.test.ts` (packages/db),
`assistant-thread-groups-repository.test.ts`, `assistant-thread-groups-store.test.ts`,
`thread-list-sections.test.ts`, `threads-panel-dnd.test.ts`, and the
`ThreadsPanel groups` suite in `threads-panel.test.tsx`.

## ASSISTANT THREAD TABS

Open tab order is durable workspace-scoped state in `assistant-thread-store.ts`;
`reorderThreadTabs` persists the complete ordered id list atomically. The tab
controller uses the WAI-ARIA automatic-activation pattern with roving tab focus,
Home/End, Delete, and `Alt+Shift+Left/Right` reorder controls. Pointer drag uses
Pragmatic drag and drop plus edge auto-scroll; context-menu Move Left / Move
Right provides the non-drag alternative. Panels remain mounted while inactive
so runtime state is not discarded, and a colored thread supplies the canonical
accent from `assistant-thread-presentation.ts` rather than a tab-local palette.

Paired tests: `assistant-thread-store.test.ts`,
`assistant-thread-tabs-dnd.test.ts`, `assistant-thread-tabs-dnd-elements.test.tsx`,
and `assistant-thread-tabs-workspace.test.tsx`.

---
