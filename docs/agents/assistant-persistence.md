# Assistant Persistence, Notifications, Context Meter

> Read before changing message persistence or reload hydration, run
> notifications, the run-event / thread-run schema, token-budget wiring, or
> delegated-child storage. Rules here are true now; the record behind each is in
> `assistant-persistence/<topic>.md`.

## ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION

**Thread workspace snapshots** live in
`brainstrike_assistant_thread_workspaces` and hydrate renderer-owned live stores
through `useThreadWorkspaceCoordinator`; those stores stay the working authority.

- While the first snapshot read is pending, never persist unhydrated singleton
  state over the saved row: capture a boot baseline, merge only fields that
  changed after it, then apply and persist immediately.
- Admit editor deltas only for tabs in the loaded snapshot, and preserve a
  changed tab set atomically with its live editor map. Why: otherwise another
  thread's pane state leaks through a boot or `A -> null -> B` transition.
- Ordinary thread switches flush the outgoing snapshot synchronously, then
  hydrate the incoming one under an intent guard — never the boot merge.

**Operating-root binding** lives in `mastra_threads.metadata` (no migration):
`operatingRootId` is the durable `roots.id`; display name and path are
display-only.

- Resolve the adapter root's path to exactly one live `roots` row and write the
  binding before the first run. An adapter root id is never execution authority.
- Require id and display name together, path optional. Reject a partial or
  invalid binding rather than sanitizing it to "unbound".
- Route every `checkout*` transition through the single-thread writer's atomic
  deletion projection; bulk metadata updates reject every `checkout*` key.
- Native tools validate the id against the live root inventory; the stored path
  is never an authority or a fallback.

Evidence: `assistant-persistence/thread-workspace-and-root-binding.md`.
Guard: `packages/app-shell/src/thread-workspace/__tests__/use-thread-workspace-coordinator.test.tsx`.

**Automatic titles** come from Mastra's `generateTitle: true`, started at the
terminal Mastra finish before the UI finish, inside one bounded 30-second
lifecycle.

- Use the active request's provider options and output-token cap; OpenRouter
  retries one text-empty result on that same model, never a fallback provider.
- Expiry aborts the model call and marks the transactional PGlite save for
  rollback; detaching either operation is not enough.
- `PgliteMemoryStore.saveThread` may replace only an empty, default or
  system-owned title and stamps `titleSource: 'om'`. A manual rename clears the
  marker and always wins, even mid-generation.
- Make background titles visible by live-subscribing to the `mastra_threads`
  id/title projection — never a timer or a poll. The per-turn `message-finish`
  refresh stays separate: recency, ordering, latest-run details, recovery.
- Thread lists enforce latest-successful-start ordering per resource from a
  generation map, without timers. A newer empty or rejected read never suppresses
  an older successful one, and a result from before `resetAssistantThreadStore`
  can never publish into the reset store.

Evidence: `assistant-persistence/thread-title-generation.md`.
Guard: `packages/assistant-data/src/__tests__/assistant-thread-store.test.ts`.

**Mastra is the durable writer.** Hosted turns persist into `mastra_messages`;
the client history adapter is read-through only. Three contracts keep a reloaded
thread identical to a live one.

1. **Persisted dialect (Mastra v2 / `MastraMessageContentV2`).** Content is
   `{ format: 2, parts: [...] }`; tool calls are `tool-invocation` parts with
   results INLINE and no `role: 'tool'` rows (the legacy shape is still read).
   - Build hydration fixtures from REAL persisted rows, never hand-written
     shapes. Why: a hand-written `tool-call` fixture once kept tests green while
     real tool history vanished on every reload.
   - Tool output uses a deliberate dual channel: Mastra persists
     `toolInvocation.result` while `toModelOutput` supplies the bounded
     projection. Native tools keep the raw domain result — never replace one
     inside `execute()` to save prompt tokens.
   - Seed an approval resume from Mastra's storage-backed suspended-tool
     snapshot before consuming resumed output, and correlate both legs by
     `toolCallId`. Missing snapshot arguments abort the decision; never persist
     an invented empty object.
   - `PgliteMemoryStore.saveMessages` re-applies Mastra's transcript projection
     at the durable boundary, returns the projected messages, and refuses to
     store or return a surviving internal carrier.
   - Hydration recognizes guarded tool results with the canonical
     `@brainstrike/assistant-contract` guard: an `ok:false` result hydrates as a
     failed call even though Mastra stores `state:'result'`. Execution and replay
     never keep independent guarded-error code lists.
2. **Snapshot grouping and live-order interleaving.** OM sealing and per-step
   saves split one live turn into several rows, so hydration merges consecutive
   assistant rows into one message and dedupes tool calls by `toolCallId` (first
   wins, later result fields merge).
   - Recall the latest `ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT` (80) message
     rows with events from the latest 80 runs, partition events by `runId`, and
     assign each run to the turn inside its own time window. Attaching only the
     newest run to the newest message loses older turns' failures, timings and
     subagent activity.
   - Re-time each tool-invocation part to its `tool.started` event; anchor other
     untimed parts to their snapshot row's save time; break ties on Mastra's
     per-part `createdAt`. A group with only run events still renders.

**Provider citation markers are normalized at that same durable boundary** by
`projectMessageContentForTranscript`, which strips the private-use codepoints
from both `parts[].text` and the flattened `content` string through
`stripProviderCitationMarkers`, shared with the render seam. Four constraints are
load-bearing: **assistant rows only** (rewriting a user row changes the reloaded
prompt and the replayed history); **settled-text mode**
(`{ unterminated: 'keep' }` — these codepoints are also Nerd Fonts glyphs);
**`text` parts only** (reasoning persists verbatim and its one renderer strips at
read); **write-time only** (older rows keep their markers — backfilling is an
unperformed data migration).

Evidence: `assistant-persistence/persisted-dialect-and-hydration.md`,
`assistant-persistence/citation-marker-normalization.md`.
Guard: `packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts`,
`packages/agent/src/pglite-mastra-memory/__tests__/pglite-memory-store.save-messages.spec.ts`.

**Abort finalization.** Mastra's `MessageHistory` processor persists a cancelled
run's transcript unawaited; `packages/agent/src/mastra/aborted-turn-persistence.ts`
owns one bounded seam on top of that, for terminal watchdog aborts and user
cancellation only.

- Keep the user input and every assistant message; REMOVE tool invocations that
  never completed; RETAIN partial text; drop assistant messages left with only
  `step-start`; append the model-visible abort marker as the last text part.
- Await `Memory.saveMessages` before disposing the per-run runtime, including
  when a recovery continuation fails during construction.
- Order is load-bearing: `TurnAttempt.settleNativeStream` awaits
  `consumeStream()` — which resolves after Mastra's snapshot cleanup — BEFORE the
  seam's save and before `runtime.dispose()`.
- Bound that join with `NATIVE_STREAM_SETTLE_DEADLINE_MS` (30 s), then record
  `mastra_native_stream_settle_timeout` at error and proceed, so a hung provider
  socket cannot hold disposal hostage.
- A step failing before a built stream's first chunk joins `consumeStream()`, never `cancel`.
- `resolveMemoryOption` carries the merged thread config's `readOnly` onto the
  request options and returns a branded `ResolvedAgentMemoryOption`; the seam
  accepts nothing else. Read-only memory streams skip the seam entirely.
- A snapshot-write failure emits `mastra_agent_aborted_turn_persist_failed` and
  preserves the turn's terminal chunks; never throw after termination. A stalled
  attempt replaced by a successful continuation is not an aborted turn.
- For delegated children, capture the public native `MessageList` at Stop and
  await the native `afterToolCall` hook before re-saving. Why: saving earlier let
  a late native write restore a tool result and erase the abort marker.

Settled: the awaited save is also the join that closes the PGlite close race.
Evidence: `assistant-persistence/abort-finalization-join.md`.
Guard: `packages/agent/src/__tests__/aborted-turn-persistence.spec.ts`,
`mastra-memory-persistence.integration.spec.ts`.

3. **Edited-prompt branch topology.** Mastra owns message CONTENT; the history
   adapter persists only `{messageId,parentId}` edges in
   `brainstrike_assistant_message_parents` (migration 055), FK-less on purpose.
   Hydration LEFT JOINs them and uses the explicit parent (including explicit
   `null`), re-roots retained messages whose parent fell outside the 80-row
   window, and traverses parent-first. Rows without an edge keep the
   chronological fallback; conflicting edges for one message id THROW.
   - **DURABLE-PARENT INVARIANT.** Every persisted edge references a
     Mastra-persisted message id or null, enforced at the adapter rather than per
     flow. The adapter keeps a per-instance transient-alias map: approval echoes
     and resume legs are never persisted and alias to their nearest durable
     ancestor, and `load()` seeds aliases for synthetic pause ids.
   - Backfill parent authority, in order: the hydrated graph parent; else the
     durable HOST LEG the pause named (`hostRunId`) and its `turn_message_id`.
     There is no third fallback, and a live echo naming no host leg THROWS.
   - **The anchor is the host leg, never the marker's `runId`.** Mastra mints
     that id, so it never equals a `brainstrike_assistant_thread_runs` id, and one
     host leg can hold several native runs.
   - A CHILD-CONTINUATION pause is deliberately not stamped: its follow-up leg's
     root message completes, so the persisted edge answers first. A REDISCOVERED
     pause carries none. Hosted web never reaches this path.
   - Re-check `persistedEdgeIds` after the turn-link lookup and defer to an
     authoritative edge; re-validate adapter session state read across an await.
     Why: an approval arriving while its root leg still streams races that leg's
     own runEnd append.

Settled: read-side hydration is untouched — re-rooting and the conflicting-edge
throw stay; fix producers, never coerce at read. Approving a rediscovered pause
anchors at the durable thread head, and a regeneration taken from a
post-approval response persists no edge.
Evidence: `assistant-persistence/durable-parent-invariant.md`.
Guard: `packages/assistant-data/src/__tests__/assistant-approval-topology.integration.test.ts`,
`packages/agent/src/__tests__/root-pause-run-identity.integration.spec.ts`,
`apps/desktop/src/__tests__/assistant-server/run-persistence-direct.test.ts`,
`apps/desktop/e2e/assistant-approval-reload-linearity.desktop.test.ts`.

**Message identity and reattachment.**

- Preserve each assistant-ui user message id through the generic-message
  conversion and `unstable_assistantMessageId` through the desktop request
  parser. A normally finished stream asserts the one-shot Mastra generator
  consumed the assistant id, so upstream drift is visible, not substituted.
- Give resume paths a separate per-call stream-id generator; the Mastra-global
  generator stays reserved for the persisted memory row.
- A new topology-bearing assistant id always starts a new hydration group, so
  consecutive regenerations stay carousel siblings.
- Desktop generation continues in the main-process session when a renderer
  response detaches; after admission the renderer writes no durable terminal
  status. The mapper-owned terminal outcome is authoritative — an output-limit or
  missing-finish state stores `failed`, and only explicit
  `POST /assistant/cancel` records `cancelled`.
- Reload reattachment is ephemeral by design, and the record is a HINT, never a
  second authority: `prepareRequest` reconciles it against the durable run row
  through `GET /assistant/run-status`. A terminal or missing run reclaims it with
  a warning; a `running` row keeps the guard; a FAILED probe keeps the guard.
  Replay-retry exhaustion also reconciles; `GET /assistant/active-run` publishes `initializing` after envelope parsing and before credential work, restores exact ordinary or child-followup input and host-validated approval prefix/paused-leaf ancestry after reload, waits through initialization, and rejects unknown ancestry. Discovery is an abortable per-attempt external resource keyed by scope/retry that reads the latest auth callback; stale attempts cannot publish snapshots or mutate storage after awaited work, and status probes share their abort signal. Capture a prepared request's scope before async work; a headerless request settles from discovery in that scope unless the host explicitly rejects before stream initialization, and a scope switch remains visibly blocked until it reconciles. A paused UI ID selects its exact action data; if it has no Mastra row, replay accepts its parent edge only with a unique native tool owner, the same turn, and unresolved host call evidence (approval request or root-owned typed tool start). Its native run must belong to the host leg's exact thread, resource and nonnull generation; the first mapped host remains the owner when a later approval leg pauses again. A null-generation legacy leg proves only its exact first-owner mapping. An ID belonging to another durable row, a reused tool call, or an unproven edge fails visibly. Evidence: `assistant-persistence/paused-action-replay-ownership.md`.
- Remap the generated streaming leaf to the durable id after `runEnd` through
  thread `export`/`import`. Missing leaves and leaves with descendants fail
  visibly.
- Disable every composer send path while the graph loads
  (`state.thread.isLoading`). Why: a send against the initial empty snapshot
  persists an explicit `null` edge and replays a continuation as a root revision.
- Hydration must not yank the viewport: keep
  `scrollToBottomOnInitialize={false}` and `scrollToBottomOnRunStart={false}`.
  Live auto-follow and virtualized anchoring belong to the viewport store —
  assistant-runtime.md § THREAD SCROLLING.

Evidence: `assistant-persistence/reattachment-and-message-identity.md`.
Guard: `packages/assistant-ui/src/__tests__/history-hydration-composer.behavior.test.tsx`,
`packages/assistant-ui/src/__tests__/assistant-ui-panel-architecture.test.ts`, `packages/assistant-ui/src/__tests__/assistant-run-session-races.test.tsx`.

**Approval/suspend action messages are never a Mastra row.** The echo is
UI/transport bookkeeping; the shared transport excludes action-marked messages
from every outbound payload and ships `messages: []` on action legs.
Consequences: the echo is absent after reload (restart-safe rediscovery owns the
post-restart UI — assistant-runtime.md PERMISSION ENGINE), and
regenerate-after-approval resends the previous real user prompt.
Guard: the "never persists an approval action echo" case in
`packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`.

**Image attachments.**

- The composer adapter accepts IMAGES ONLY and enforces the caps in
  `@brainstrike/assistant-contract` assistant-attachments — the same module the
  server validates with, so client and server cannot drift. Validation failures
  THROW; never silently drop or resize.
- `convertAssistantUiMessages` intercepts file parts BEFORE the text walk (a
  base64 body must never flatten into prompt text) and emits a canonical
  user-message ImagePart; text-only messages keep the legacy string join.
- Mastra persists the user row in the v2 FILE dialect (`mimeType`, not
  `mediaType`); hydration rebuilds `message.attachments` from it (image/* only)
  and the content re-merges into later outbound turns.
- `boundResentImageHistory` caps one request's inline images at the same combined
  cap — current turn always ships, history spends the remainder newest-first, and
  once one image no longer fits it and every older one becomes a visible text
  note (recency-monotonic). Elision is wire-only and loud; persisted rows keep
  the bytes. Measurement is strict for the current turn and degrades for history:
  an unmeasurable old attachment is elided with its own note rather than aborting
  the send.
- Availability gating is layered: the provider gate makes every HOSTED provider
  eligible and hides the affordance only for the text-only built-in local
  provider; the per-model `vision` capability then renders a visibly DISABLED
  attach button naming model and reason. Keep the adapter registered and the
  preview strip mounted under a text-only model so a staged attachment stays
  visible and removable. `'unknown'` stays optimistic.

Evidence: `assistant-persistence/image-attachments.md`.
Guard: `packages/assistant-contract/src/__tests__/assistant-attachments.test.ts`,
`packages/assistant-ui/src/__tests__/attachment-adapter.test.ts`,
`packages/ui/src/__tests__/data-stream-runtime.test.ts`.

**Built-in LOCAL provider turns persist on DESKTOP**, routed through the
assistant server's Mastra loop, so memory, run events and hydration behave like
hosted providers. Known gap: WEB local turns remain session-only.

**Observational memory** is ON by default at Mastra's documented thresholds with
the `'auto'` observer target.

- `resolveEffectiveObservationalMemorySettings` resolves `'auto'` into CONCRETE
  settings for request data, memory validation and the OM meter alike. The auto
  observer is only ever a Mastra-tested fast model FROM THE SELECTED CHAT
  PROVIDER — the party already receiving the conversation — chosen by the
  contract's pure `listAutoObservationalMemoryCandidates`.
- A local, keyless or web chat, or a candidate set the user disabled, flips
  `enabled → false` with an explicit unresolved reason surfaced as the popover's
  `awaiting-observer` state. An unresolved auto must never disable thread memory,
  and `'auto'` must never reach the provider/model validator — the desktop server
  resolves the sentinel again at request intake.
- Construction seams that receive no settings use
  `CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS` (observation OFF): an
  absent settings object must never manufacture an enabled observer.
- Wrap hosted embedders in `asSpecV3EmbeddingModel`. Why: @mastra/memory's embed
  dispatch switches on the spec literal and routes a raw `'v4'` embedder into a
  v1-only pipeline that throws.

Settled: the auto observer stays inside the selected chat provider (privacy
ruling); the built-in local Gemma is not a candidate.
Evidence: `assistant-persistence/observational-memory-auto-target.md`.
Guard: the VECTOR-retrieval and observer wire cases in
`mastra-memory-persistence.integration.spec.ts`.

When changing message persistence or hydration, update this section and the
paired tests in `packages/agent` and `packages/app-shell`.

**MCP Task status is deliberately outside assistant message persistence.** Never
serialize a task's live status, input requests, result metadata or control
identity into a message part. Migration 115 and its
principal/server/resource/authority-epoch scope remain authoritative; after a
restart an opt-in host adapter rebuilds the bounded presentation from that row
and marks it `restart_required`. This layer adds no renderer store and no
fallback to stale message history.

---

## ASSISTANT RUN NOTIFICATIONS

OS `Notification` alerts for five events — run finished, run failed (watchdog
stalls surface as `run.failed`), tool approval required, PR opened, PR checks
finished — fired only while the app is NOT the user's active focus. One code path
for Electron renderer and web: the standard web `Notification` constructor, no
Electron module, no new IPC.

- Preferences persist a master toggle (default OFF) plus per-event toggles
  (default ON) and reset directly from `clearBrowserStorage`, so the live
  in-memory toggle cannot survive a reset that does not reload the page.
- `shouldNotify` is a PURE gate: master on, event on, permission granted, window
  unfocused — all evaluated AT EVENT TIME. Request permission ONLY from the
  Settings toggle-on click, and never persist `masterEnabled: true` without it.
- Coalescing keys are `runId:kind`, and `runId:kind:toolCallId` for
  `toolApprovalRequired` so one run alerts on each distinct approval. The
  dispatcher input is a discriminated union of ids plus an optional thread title —
  never message content or tool args.
- Triggers are pure selectors over thread messages; report each new event exactly
  once and DEFER seeding the "seen" baseline until `state.thread.isLoading` is
  false, so replayed history does not fire stale notifications.
  `packages/assistant-ui` never touches `window.Notification` or the store.
- `packages/app-shell/src/use-assistant-run-notifications.ts` is the only layer
  reading live focus and owning the dispatcher. Hosted turns coalesce on the wire
  `runId`; web local-runtime events fall back to `event.id` — never a fabricated
  runId that could collide.
- Forge observations come from `forge:prUpdated` pushes, not a stream scan, and
  are gated per thread by `metadata.forgePrWatch !== false`. Buffer pushes that
  arrive before the branch lookup resolves and drain them once it reports
  `loaded`.

Known limitation: a durable `pr.*` row does not appear in an ALREADY-OPEN
thread's timeline, because the timeline renders from data parts and
`listThreadRunEvents` is read only at hydration. The PR chip and thread-row pill
stay fresh through their own live sources.

Evidence: `assistant-persistence/run-notification-layers.md`.
Guard: `packages/app-state/src/__tests__/notification-*.test.ts(x)`,
`packages/assistant-ui/src/__tests__/run-lifecycle-notifications*.test.ts(x)`,
`packages/app-shell/src/__tests__/use-assistant-run-notifications.test.ts`,
`use-forge-run-events.test.ts`.

---

## FOLLOW-UP MESSAGE QUEUE (COMPOSE DURING A RUN)

A queue button in the composer's RUNNING branch, a per-thread zustand FIFO,
removable chips, and a render-nothing bridge that dispatches ONE queued message
per run end through `aui.thread().append(...)`.

- Detect run end as the `state.thread.isRunning` true→false transition, not run
  events. Why: it works identically for the web local runtime and fires for
  finished, failed and cancelled runs alike; the chip's remove control is the
  user's veto.
- Mirror `run-lifecycle-notifications.ts`: no dispatch while
  `state.thread.isLoading`, and a `threadKey` change reseeds the baseline.
- FIFO one-per-run-end. A synchronous `append` throw requeues at the FRONT and
  logs; `append` returns void, so there is no async failure channel.
- Treat an idle, non-loading thread with a non-empty queue on a (re)mounted key
  as a missed run end and dispatch once, so the chip's promise holds across
  thread switches.
- Keep the queue session-lived and registered with factory reset; a queued
  message surviving reload would be a surprise send.
- Existing-runtime inspection panes set `FollowUpQueueOwnershipContext` false:
  they neither dispatch nor catch up the root session queue, and offer no
  Queue/Steer controls or chips.

Settled: mid-run STEERING belongs in the agent loop, not this UI seam.
Evidence: `assistant-persistence/follow-up-queue.md`.
Guard: `packages/assistant-ui/src/__tests__/follow-up-queue-store.test.ts`,
`follow-up-queue.behavior.test.tsx`.

---

## CONTEXT USAGE METER (TOKEN AWARENESS)

**ONE DERIVATION, THREE CONSUMERS.** `buildAgentLoopSettings` produces
`agentLoopSettings.inputTokenLimit` (explicit user pref, else
`deriveAgentLoopInputTokenLimit` in `packages/assistant-contract/src/context-budget.ts`:
OpenRouter reserves its request's output (required, no default), others the
catalog max; throws, never clamps). That one number is the Mastra `TokenLimiter`
budget, the meter denominator, and the instruction budget note. Never derive a second budget.

- The usage store is session-lived, keyed `selectedMemoryThreadId ?? 'active'`;
  writer and reader must use the same key.
- Both turn paths report usage: hosted through the data-stream `message-finish`
  tap, local through the llm-host result (guard its optional usage at the IPC
  boundary).
- Aggregate `inputTokens`/`outputTokens` are the durable billing totals;
  `contextInputTokens`/`contextOutputTokens` carry only the latest provider step
  and feed the meter. Never display a billed cross-step sum as context occupancy.
- Provenance must never lie: show the estimate until exact usage lands and flag
  it `est.` The estimator walks EVERY message part — text, reasoning, tool args
  and results with per-tool attribution, attachment counts — memoized per settled
  message. Never regress to a text-only walk; tool output is most of the context.
- `resolveDisplayedContextUsage` selects: idle + exact → exact; streaming → the
  live estimate floored at the last exact figure, so context never shrinks
  mid-run; before any exact usage → the estimate alone.
- Render the critical (≥90%) trimming-risk notice INLINE beside the ring, never
  inside the hover popover.
- The prompt breakdown is a TRANSIENT `brainstrike.context-breakdown` aui-data
  part, deliberately not a run event, so it is never persisted — after reload the
  popover honestly has none. Non-measurable categories are ABSENT fields, never
  zero-faked; a malformed payload is stored and SURFACED as `{ invalid: true }`,
  never coerced. Register it with a null renderer, and clear a stale breakdown
  whenever the active provider/transport pair has no breakdown channel.
- OpenRouter finishes carry `billedCostUsd` from official provider metadata.
  MISSING cost records UNKNOWN with a visible `provider_billed_cost_unreported`
  warning; MALFORMED records unknown with `provider_billed_cost_malformed` at
  ERROR. Neither is ever recorded as zero, and neither fails the finished turn.

Evidence: `assistant-persistence/context-meter-derivation.md`.

**Run-usage attribution.** Every `brainstrike_assistant_run_usage` row carries
`run_kind` (`chat | subagent | compaction-summary | om-observation |
om-reflection`; migrations 077/090, CHECK-constrained, default `chat`). TWO
writers, never overlapping: the renderer writes only parent `chat` rows, the
desktop server only child rows from the `child-run-usage` chunk.

- Subagent rows are provider-exact and reconciled one row per invocation against
  the original host leg (migration 128), so duplicate delivery and cumulative
  resume cannot double-count. Bound authorization or write failures propagate;
  never fall through to the legacy unattributed insert.
- OM rows are Mastra's LOCAL tokenx estimates: label them "est.", attribute them
  ONLY to the run's resolved observer target, drop unattributable rows with a
  warn, and skip `provider === 'local'` rows.
- Child rows reuse the PARENT `runId`, so Task Ledger per-run totals include them.
- The meter chip leads with the THREAD TOTAL (+cost when priceable); the context
  fraction moves to the ring, title and popover.
- The live tick is cleared on three paths: `handleUsage` after the post-write
  refresh, `completePreparedRequest` on a cancelled/failed terminal status, and
  RUN START in `prepareRequestData` before composition awaits.
- **The reader-side gate and the run-start reset are a required pair; neither
  covers the other's case.** `ContextUsageMeter` gates the recorded sum on
  `isRunning === true || settlingRunUsageByThread[key]`: the gate hides a
  stranded sum while idle, the reset removes it before the next run can
  accumulate onto it.
- The settle marker is not optional — `isRunning` goes false at stream finish
  while `handleUsage` holds the live sum until the post-write refresh. Claim the
  window with `beginLiveRunUsageSettle` only past the no-sink guard and release it
  STRUCTURALLY. A claim that outlives its sum is strictly worse than no claim.
- A repo-backed thread with no rows hydrates the honest ZERO baseline; a failed
  load stays null, never $0. While live tokens are included, suppress the durable
  cost and qualify the popover "(excl. live)".

Settled: OM rows flow into the daily-spend guardrail, cross-root usage and ledger
analytics priced at the observer model's registry rate — the tokens are genuinely
billed, and excluding them would under-count real spend.
Evidence: `assistant-persistence/run-usage-attribution.md`.
Guard: `packages/assistant-ui/src/__tests__/context-usage-meter.test.tsx`,
`packages/tokenization/src/__tests__/token-counting-heuristic-accuracy.test.ts`.

---

## RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP

`brainstrike_assistant_thread_runs` and `brainstrike_assistant_run_events` are
created by **migration 118**, and NOTHING creates them at runtime. This supersedes
the 2026-07-24 ruling that they must never get a numbered migration: migration 117
now creates Mastra's memory schema, so 118 declares both `ON DELETE CASCADE` FKs
exactly as the retired bootstrap did. Do not restore the bootstrap.

**Desktop main has four writers**, all in
`apps/desktop/src/assistant-server/run-persistence.ts`, all reached through
injected handles and all gated on `if (runId)`:
`recordDesktopAssistantRunEvent` (silent no-op on a missing parent),
`recordDesktopAssistantHookRunOutcome` (THROWS, deliberately),
`completeDesktopAssistantThreadRun` (silent no-op), and `reapOrphanedThreadRuns`
(startup-only sweep). None creates a relation.

- Run-critical desktop reads and event writes use the foreground
  `DatabaseWorkScheduler` lane, including the delegated host's scope reads, step
  budget, tool-action claims, swarm diagnostics and continuation admission. Only
  workspace snapshot capture keeps the owner handle. Why: on the owner handle the
  host's queries reached a DB held by an 82 s maintenance statement and two
  children failed the 30 s request timeout.
- A run-scoped snapshot SELECT and same-id event upsert may retry once for typed
  non-terminating saturation, emitting `run.database.retried` or stamping
  sanitized `metadata.databaseRetry`. Arbitrary, wedged, terminating and exhausted
  failures stay typed.
- **`duration_ms` is INTEGER and durations round at the PRODUCER.**
  `withRunEventDuration` is the single seam where a duration enters a run event; a
  non-finite value drops the field. Why: forwarding `performance.now()` floats
  made every stamped terminal tool event fail to persist (22P02).
- **runId provenance, not startup ordering, is what makes the writers safe.**
  `memory.runId` has exactly ONE producer, `createThreadRunId` inside
  `createAssistantThreadRunPromise`; only it asserts the `HostRunId` brand that
  `createThreadRun` requires. `buildAssistantRequestData` puts no `runId` on
  `data.memory`; desktop has ONE physical database. Do NOT add a defensive
  `CREATE TABLE IF NOT EXISTS` in main or an ordering handshake — machinery for
  an unreachable state masks a broken invariant. A SECOND producer makes it real.
- **Loudness is not uniform.** `observeDesktopAssistantRunEvents` rethrows on
  flush only when the source stream did not also throw, and
  `recordDesktopAssistantThreadRunStatus` only logs, so a failed run-status UPDATE
  strands the row in `running`. `reapOrphanedThreadRuns` recovers those at the next
  app start on boot-time evidence (`started_at < mainProcessStartedAt`), marking
  them `failed` with a visible error and un-sticking the rewind gate without
  weakening it.
- The same sweep fails pre-boot `pending`/`running` `mastra_background_tasks` rows
  with `ORPHANED_BACKGROUND_TASK_ERROR`; a `suspended` task is never touched,
  `delivered_at` stays NULL, and the next turn delivers the failure once. Reaping
  supersedes no retry path and never reruns a crashed task: the host pins
  background retries to 0, so never add a `retry_count < max_retries` carve-out.
  This paragraph is the canonical statement of that rule; database.md points here.

Settled: `pr.opened`/`pr.checks`/`pr.merged` are the only kinds not produced by
the agent stream and attach to the thread's most recent run (no run, no row,
logged at `info`). Do not confuse these tables with
`brainstrike_assistant_run_outcomes`, migration-backed since 062.
Evidence: `assistant-persistence/run-event-schema-ownership.md`.
Guard: `scripts/assistant-run-id-producer-guard.mjs`,
`apps/desktop/src/__tests__/assistant-server/run-event-schema-provenance.integration.test.ts`,
`thread-run-startup-reaper.integration.test.ts`, `delegated-host-run-lane.test.ts`.

### The repository PROBES; it never creates

`createPgliteAssistantThreadRepository` runs a `to_regclass` probe over every
relation it reads or writes — the run tables plus every
`THREAD_DELETE_SIDECAR_TABLES` entry — memoized per handle and awaited by every
method. A missing relation throws `AssistantMemorySchemaMissingError` naming it.

- `to_regclass` ONLY: it returns NULL for an absent relation, so one statement
  answers for the whole set.
- **No `IF NOT EXISTS`, no catch-and-create, no create-if-missing fallback.** A
  missing relation means migrations did not run.
- A FAILED probe drops its memo so the handle re-probes; only success is cached.

Settled: the bootstrap mirror is retired and stays retired — nothing could observe
its divergence, and it had already shipped one.
Evidence: `assistant-persistence/schema-probe-not-create.md`.
Guard: `packages/assistant-data/src/__tests__/assistant-memory-schema-probe.integration.test.ts`.

### 118 must CONVERGE, because every existing install already has these tables

- A bare `CREATE TABLE` errors on upgrade for every existing user, and a
  conditional create alone preserves the drift on exactly the installs that
  matter. The conditional create is only half the migration.
- The other half is the additive statements — `thread_runs.turn_message_id`
  (`ADD COLUMN IF NOT EXISTS`), the two partial approval indexes, and the
  `DROP INDEX IF EXISTS` retiring the old answer index — which must cover every
  difference between what a shipped bootstrap era left and what the create
  declares.
- That obligation is CHECKED: the upgrade-path test seeds a database as each
  shipped era left it, runs the chain, and asserts the catalog is IDENTICAL to a
  freshly-migrated one, columns WITH THEIR ORDINALS included. Its seeds are frozen
  history; if a change to 118 makes it fail, the bug is the missing forward
  statement, never the seed.

Evidence: `assistant-persistence/migration-118-convergence.md`.
Guard: `packages/db/__tests__/assistant-run-schema-upgrade-path.test.ts`,
`mastra-schema-migration-parity.test.ts`.

### Test fixtures are not a licence to reshape these tables

Seed a `mastra_threads` parent row; never re-declare the run header. The
`brainstrike_assistant_thread_runs_thread_id_fkey` is not new — it has shipped
since the table did.
Evidence: `assistant-persistence/run-table-test-fixtures.md`.

### WORKTREE LIFECYCLE KINDS

`worktree.created`, `worktree.archived` and `worktree.setup` are additive
`ASSISTANT_RUN_EVENT_KINDS` members emitted by `worktree-run-events.ts` through
the SAME `recordDesktopAssistantRunEvent` writer — do not add a second INSERT —
under the same `if (runId)` gate.

- Emit them ONLY for an operation inside a run. A worktree created before the
  thread's first request gets NO orphan row: the sheet reports inline and
  `brainstrike_worktrees` is the durable record.
- All three are `NEVER_RUNNING`, so none declares a terminal. A kind missing from
  `ASSISTANT_RUN_EVENT_KINDS` is REJECTED by `readAssistantRunEvent`, so the
  contract entry is the first thing to add.
- `worktree.created` carries `metadata.via` with a CLOSED vocabulary
  (`app | tool | adopt | shell`) from exactly three sites. Derive `app` vs `tool`
  from the ledger row's `createdBy` through the ONE `emitWorktreeCreateEvents`
  emitter, so the timeline can never disagree with `brainstrike_worktrees`.
- Correlate shell creates from the `executeCommand` TOOL RESULT, never the
  git-metadata watcher; the correlator is fire-and-forget and can never delay or
  fail the tool call. Report a shell `git worktree remove` as a VANISHED ledger
  row, never archived.

Settled: no new kind for a second create path — it would need its own
pairing-contract row and a second label vocabulary for the same fact.
Evidence: `assistant-persistence/worktree-lifecycle-kinds.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/worktree-run-events.test.ts`.

### MCP DISCOVERY SKIP KIND

`mcp.tools.unavailable` records that a configured MCP server contributed ZERO
tools to a run. It comes from the AGENT STREAM on the initial-turn seam, not a
main-process writer, and reaches persistence through the ordinary run-event chunk
path.

- Status is always `'failed'`, never `'running'` (`NEVER_RUNNING`).
- Membership in `isAlwaysVisibleRunEvent` is LOAD-BEARING: run-event rows are
  hidden unless background activity or Developer detail is on, so a contract-only
  addition would report nothing to the user it exists for. Nothing else cards this
  fact, and carrying no `toolCallId` it needs no card-suppression exemption.
- Emission scope is fresh turns ONLY; resume legs re-run discovery and re-emit
  nothing.

Evidence: `assistant-persistence/mcp-discovery-skip-kind.md`.
Guard: `packages/agent/src/__tests__/mcp-discovery-run-events.spec.ts`,
`packages/assistant-ui/src/__tests__/assistant-run-event-pairing-contract.test.ts`.

### PROVIDER CALL-WARNING KIND

`provider.request.warned` records that the provider did not carry a request out as
written — AI SDK adapters drop a rejected setting and list it on `warnings`
instead of returning 400, so a user-set `temperature` is simply ignored.

- It is NOT a prelude: `drainProviderCallWarningChunks` drains it per part, so the
  row lands as the adapter opens its stream and never after the finish chunk.
- Status is always `'failed'` (`NEVER_RUNNING`), and it is in
  `isAlwaysVisibleRunEvent` — LOAD-BEARING, because the turn completes normally
  and this row is the only evidence the setting was dropped.
- ONE row per DISTINCT bounded warning across supervisor and persona calls; a
  distinct pinned model retains its own. Bound and redact provider-controlled
  fields before the sink retains them, and again at presentation. Exceptional
  termination drains captured warnings before propagating the original failure.

Evidence: `assistant-persistence/provider-call-warning-kind.md`.
Guard: `packages/agent/src/mastra/__tests__/provider-warning-run-events.spec.ts`.
The capture-side contract is in `docs/agents/assistant-providers.md`.

### DELEGATION LEDGER KIND

`delegation.ledger` is the user-facing status of a fan-out ("3 of 4 specialists
returned · 1 running"), published on every background task lifecycle change and
before every parent wakeup, built from DURABLE task rows — never in-memory sets.

- **The ledger is scoped to a GENERATION** — the send or regeneration that opened
  it — not a parent run, because one turn spans several native parent runs and
  run-scoping left an initial leg's row never superseded. Migration 140 carries
  that identity (`generation_run_id` plus `brainstrike_assistant_native_runs`). A
  regeneration is its own generation, which is why `turn_message_id` cannot be it.
- Shape: a FRESH `id` per row, the same `metadata.ledgerId`, and the counts.
  Content-free by construction — prompts and failure reasons stay in the
  model-facing wakeup.
- `status` is `'running'` while anything runs and `'completed'` otherwise. A
  failed specialist is a count in the label, never `run.failed`.
- Rendering is LATEST-ROW-WINS and the lookup is RUN-AGNOSTIC: live parts carry no
  `runId` while hydrated parts do, and the resume leg publishing the final row is
  a different host run from the leg that published the stale one.
- The publisher joins in-flight reads before a leg closes, so the final row is
  never lost to a fast close. Classified SELF_SUPERSEDING; in
  `isAlwaysVisibleRunEvent` (LOAD-BEARING).

Settled: one row updated in place is not available — the aui data part carries no
`id`, and a repeated id would give every copy the first copy's plan.
Evidence: `assistant-persistence/delegation-ledger-kind.md`.
Guard: `packages/assistant-ui/src/__tests__/assistant-run-event-ledger.test.ts`.

### DELEGATION BUDGET EXHAUSTED KIND

`delegation.budget.exhausted` is the breadcrumb that a delegated child's durable
budget forced its reserved summary step.

- `projectSynthesisOutcome` turns the transient synthesis part into ONE run event
  on the owning CHILD conversation — the single published, unfinished child on
  that native thread. None or several is a contract break that THROWS, never a
  dropped row.
- `status` is always `'info'`: nothing runs, nothing pairs, and the child still
  completes. It is deliberately neither a `.started` pair nor `run.failed`.
- `metadata` carries ids and counts only (cap, limit, used, `synthesisForced`,
  `truncated`, reserved and reported output tokens, parent call and persona ids).
  In `isAlwaysVisibleRunEvent` (LOAD-BEARING).

Evidence: `assistant-persistence/delegation-budget-exhausted-kind.md`.
Guard: `packages/agent/src/__tests__/delegated-stream-projection.spec.ts`,
`packages/assistant-ui/src/__tests__/run-events.test.ts`.
Contract: `docs/agents/assistant-subagents.md` ("Child budgets are USER SETTINGS").

### PERMISSION GATE RESOLVED KIND AND PER-STEP FINISH REASON

`permission.gate.resolved` records the permission gate a leg's Agent was BUILT
with, emitted ONCE per fresh root leg on the stream prelude and only when a policy
snapshot gated the run (`MastraAgentRuntime.permissionGate` is a REQUIRED
`PermissionGateSummary | null`). Resume legs pass `preludeChunks: []` and persona
children re-gate, so neither emits one.

- Metadata carries the policy snapshot, session grants, `yolo`, `defaultRisk`,
  override count, and the kept-ask / denied / storage-omitted tool sets. No key
  may contain `session`: `sanitizeAssistantRunEventMetadata` drops such keys at
  publication and at storage.
- Status `'completed'`, never `'running'` (`NEVER_RUNNING`). Deliberately NOT in
  `isAlwaysVisibleRunEvent`: it explains why an approval card appeared, and the
  card is the user-facing surface.
- `run.step.finished` metadata carries the step's own `finishReason`, added at
  that mint and NOT in `makeStepMetadata`. Why: the shared helper also feeds
  `run.started`, `run.steered` and the steered `run.finished`, which must not
  report the step's `tool-calls` while its finish chunk reports `stop`. The
  no-value sentinel `'absent'` is never written.

Evidence: `assistant-persistence/permission-gate-resolved-kind.md`.
Guard: `packages/agent/src/mastra/__tests__/permission-gate-run-events.spec.ts`,
`permission-gate-prelude.spec.ts`, `step-finish-reason-run-events.spec.ts`.

### SWARM DIAGNOSTICS TABLES

`brainstrike_assistant_prompt_manifests`, `brainstrike_delegated_wakeups` and
`brainstrike_delegated_live_decisions` (migration 139) are append-only debug-pack
evidence. The runtime never reads them and they are never runtime authority.

- Writers cap text and key-redact every jsonb value with `redactSensitiveLogValue`
  before insert; the pack scrubs value shapes at export.
- A failed or run-missing write is logged with a code and resolves: a database
  failure never fails the leg, the same policy as run-event persistence.
- All three reference the ROOT host run with `ON DELETE CASCADE`. A
  `child-first-step` manifest is named by the DISPATCHING thread and joins into a
  child's subtree through the invocation.
- `brainstrike_delegated_continuations` remains the HUMAN wake-admission ledger:
  never write a model wakeup into it.

Storage, reset and deletion ownership: `docs/agents/database.md` ("Swarm
diagnostics evidence").
Evidence: `assistant-persistence/swarm-diagnostics-tables.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/swarm-diagnostics-records.integration.test.ts`,
`live-decision-log.test.ts`, `thread-debug-snapshot.integration.test.ts`.

### Threads-panel active-run projection

The panel derives running indicators from `brainstrike_assistant_thread_runs`
through ONE resource-scoped PGlite live query
(`packages/app-shell/src/use-active-assistant-thread-ids.ts`). No second activity
store, no polling, no per-row subscription; the virtualized surface only does
`Set.has(thread.id)`, which makes every existing lifecycle writer authoritative.

- Web runs the shared boot-time predicate after schema bootstrap and before
  starting the live query, using the navigation time origin rather than hook mount
  time, so remounting cannot classify a current-page long run as an orphan.
  Desktop skips the renderer sweep: its main-process stream survives a reload.
- Keep the subscription enabled across transient thread-list loading states; reset
  only when the handle changes.
- Sweep, subscription or row-shape failures clear possibly stale indicators and
  render an explicit unavailable state — never silently present every thread as
  idle.
- The spinner is a labelled graphic, not a live region, and keeps a static active
  treatment under reduced motion.

Evidence: `assistant-persistence/threads-panel-active-run-projection.md`.
Guard: `packages/app-shell/src/__tests__/threads-panel.test.tsx`, the
concurrent-run case in `apps/web/e2e/assistant-ui-panel.test.ts`.

### Threads-panel awaiting-approval projection

`packages/app-shell/src/hooks/use-threads-awaiting-approval.ts` is the panel's
second and last live query, under the same one-subscription discipline. This is
why the durable `tool.approval.requested` row exists: rediscovering a pause from
the Mastra snapshot is per-thread and cannot answer a list-wide question.

- **Resolution pairs on `metadata->>'toolCallId'`, run-agnostically.** The resume
  leg mints its own run, so the answering event carries a different `run_id`, and
  `sequence` is per-run and meaningless across legs. A pause row with a NULL
  `toolCallId` is excluded; `NULL = NULL` inside the `NOT EXISTS` would pin the
  badge forever.
- **An answer must OCCUR AFTER the pause it answers** —
  `AND answer.occurred_at > requested.occurred_at` is the whole ordering guard,
  because Mastra's gate runs inside `toolCallStep` after the `tool-call` part
  streamed, so a `tool.started` with the same `toolCallId` precedes the pause row.
  A tie fails the comparison and counts as NOT an answer: the safe direction. A
  `run_id`-shaped exclusion is wrong whenever one step holds two gated calls.
- **The query does NOT read `thread_runs.status`.** A leg that pauses finishes
  `completed` while the obligation outlives it, so filtering on `running` would
  make the projection permanently EMPTY. For the same reason it needs no web
  startup-reap gating; it is gated on `schemaReady` alone.
- `tool.started` counts as a resolution HERE and deliberately not in
  `assistant-run-event-derivation.ts`: the timeline asks whether the pause reached
  a terminal state, the panel asks whether the user still has to answer.
- Both sides of the anti-join are served by two PARTIAL indexes on
  `brainstrike_assistant_run_events`, living in migration 118 and nowhere else.
  Why: every pre-existing index leads with `thread_id` or `run_id`, so without
  these the query full-scanned the largest assistant table twice per notify.

Settled: all three rulings; do not relitigate.
Evidence: `assistant-persistence/threads-panel-approval-projection.md`.
Guard: `packages/app-shell/src/__tests__/use-threads-awaiting-approval.test.ts`
(query text) and `use-threads-awaiting-approval.integration.test.ts` (real PGlite
outcome over production-writer rows).

### RUN ERROR PROVIDER FORENSICS

`brainstrike_assistant_run_errors` (migration 076) is the durable
one-row-per-run provider failure summary, deliberately separate from the run-event
timeline: `run_events` describes lifecycle presentation, `run_errors` retains
terminal classification and bounded provider response evidence.

- The table is FK-less and stays that way; the parent link is enforced in code.
  `AssistantRunErrorRepository.record` derives `thread_id` and `resource_id` from
  the durable parent run — callers provide neither — and a missing parent returns
  no row and THROWS.
- A conflict on `run_id` returns the existing row only while the parent still
  exists, so independent terminal writers are first-terminal-wins and can never
  overwrite the original classification. An already-stored orphan is not accepted
  as a successful duplicate.
- Desktop catches that loud failure at the stream integration boundary and records
  it with run and event ids. It MUST remain observable and MUST NOT replace the
  original provider-failure stream.
- The row has NO `attempts` field: current Mastra error processors expose neither
  the complete attempt sequence nor the actual rate-limit wait. The application
  boundary owns content bounds and the response-header allowlist; the database
  independently CHECKs JSON shape and HTTP status.
- With no FK, lifecycle is explicit: thread deletion removes run errors before
  their parent runs, and all three table-enumerating reset paths clear the table
  before Mastra threads.

Evidence: `assistant-persistence/run-error-forensics.md`.
Guard: `packages/db/__tests__/migration-076-assistant-run-errors.test.ts`,
`assistant-run-error-repository.test.ts`.

---

## SYNC-THE-MIND OP-LOG SEAM

Future sync covers the "mind" — threads, memory, prompts — never vectors or HNSW.
What exists is a tombstone seam and deliberately nothing more: no engine choice,
no write-path op emission.

- **State:** `brainstrike_mind_ops` (migration 079), append-only. `entity_kind ∈
  {thread, prompt_item}` and `op = delete` are CHECK-constrained on purpose —
  widening the vocabulary is a conscious migration, never a drift channel. Thread
  tombstones capture `resource_id` from the delete's own RETURNING, because the
  workspace scope is unrecoverable once the row is gone.
- **Tombstones derive FROM the log.** No `deleted_at` columns anywhere: rows still
  physically disappear, so the search orphan GC's anti-join and the read-only
  sandbox role's visibility rules are untouched.
- **One cascade spec.** `THREAD_DELETE_SIDECAR_TABLES` is the ordered thread-delete
  cascade, and all THREE delete implementations derive from it — the single-thread
  CTE (which also owns the placements stage), the bulk CTE, and the Mastra
  `MemoryStorage.deleteThread` override.
- **Ops record actual deletions:** one `thread` op per row actually deleted;
  idempotent and rejected deletes emit nothing. The standalone Mastra store probes
  the app-owned sidecars with `to_regclass`.
- **Delegated branches** use `DELEGATED_THREAD_DELETE_CTES`, which validate the
  complete live ancestry and descendants before selecting any target; a changed
  owner or resource rejects the whole command. Parent and sibling threads outside
  a selected subtree survive, numeric usage remains historical spend, and
  overlapping bulk requests emit each tombstone once.
- **Reset:** registered in the reset registry, so the op-log is cleared with the
  mind it describes on all three clear paths.

Evidence: `assistant-persistence/mind-ops-log.md`.
Guard: `packages/db/__tests__/migration-079-mind-ops-log.test.ts`,
`apps/desktop/src/__tests__/assistant-server/delegated-thread-deletion.integration.test.ts`.

## STALE TOOL-PROJECTION REWRITE OVERLAYS

Desktop workspace inspection history is compacted at the transient
provider-request boundary without mutating Mastra-owned content.

- **State:** `brainstrike_assistant_tool_projection_rewrites` (migrations 084 +
  087), `tool_call_id` PK, `thread_id` owning cleanup,
  `superseded_by_tool_call_id` the live-evidence guard, `marker_text` the exact
  compact replay. Registered in the reset registry and the sidecar cascade.
- **Detection is desktop-local, post-success and restart-safe.** After a
  successful read, grep, write or string-replace, scan the thread's visible
  persisted invocations and exclude calls already in the overlay. Identity is
  canonical `rootId` plus workspace path. Either supported edit supersedes all
  earlier reads of that file; an identical normalized grep pattern/scope
  supersedes the earlier grep (`filePaths: null` means omitted). Dedup stubs are neither candidates nor superseders,
  and no in-memory pending queue exists.
- Measure reclaimable size in DECODED characters — the same ruler the live
  projectors self-fit against, never `JSON.stringify(...).length`. Commit the whole
  pending batch in one transaction only at 65,536 reclaimable decoded characters
  or more; below threshold write nothing. Any failure is logged and the successful
  tool result stays successful.
- Measure candidate size from the PERSISTED model output
  (`providerMetadata.mastra.modelOutput`), never by re-projecting the raw result.
  Why: re-projection re-applies the smaller DEFAULT domain budget, so
  legitimately-large historical reads threw and were mislabeled malformed. Only
  legacy rows without a persisted model output re-project.
- Warn ONCE per process per malformed record, not once per scan, and keep
  re-parsing every scan — a record failing one consumer's stricter contract must
  still act as the superseder of valid records. Past a distinct-record ceiling emit
  ONE summary warning rather than an eviction cliff.
- **Replay rewriting is surgical and transient.** The Mastra input processor
  replaces only matching `tool-result.output` values with text markers, before
  provider-history compatibility and the final token limiter. An absent lookup
  capability omits the processor; an empty lookup or inert diff preserves the
  golden path.
- **Rewind self-heals without undo state:** verify the superseder is still present
  in the CURRENT (already tombstone-filtered) prompt; if rewind hid it, replay the
  original durable content. No stored result was ever overwritten.
- Reset loop guards for the thread scope ONLY after a transaction inserted rows.

Evidence: `assistant-persistence/tool-projection-supersession.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/tool-projection-rewrite-repository.test.ts`.

## RECENCY-WINDOW TOOL-PROJECTION PRUNING

Layer 2 reuses Layer 1's transient overlay and never mutates Mastra content.

- **State:** migration 087 adds CHECK-constrained
  `kind IN ('supersession', 'prune')` tied to `superseded_by_tool_call_id`
  (supersession requires one, prune requires NULL); existing rows backfill to
  `supersession`. A prune row applies whenever its own call remains in the
  tombstone-filtered prompt; rewinding unrelated later messages does not make
  age-selected evidence fresh. Migration 087's `down` deletes prune rows before
  restoring `NOT NULL`.
- **Selection is deterministic.** `decodedPersistedModelOutputChars` handles
  `text`/`content` and `toJsonSafe`-serialized `json` shapes — artifact spill is
  precisely the large output pruning targets. Only a genuinely unknown shape
  throws, and an invocation persisted before `modelOutput` existed is skipped from
  the size walk, never a pass-aborting throw.
- `TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS` (40,000) protects whole
  invocations overlapping the newest window and
  `TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS` (20,000) gates the reclaim sum, both
  derived through `APPROX_CHARS_PER_TOKEN = 4`. Below the floor the pass writes
  nothing; repeated snapshot copies of one `toolCallId` count once.
- **Eligibility is an explicit ALLOWLIST of read-only, cheap-to-re-run native
  tools — never a denylist** — so every new tool is exempt by default. Mutating or
  interactive tools are ineligible: re-running one is either not idempotent or not
  what the marker implies, and their projections are tiny. `skill` and
  `skill_read` stay unconditionally exempt; `skill_search` is allowlisted. The list
  is deliberately narrower than and NOT derived from `tool-risk.ts`'s `'read'`
  bucket.
- **Current turn is an explicit persisted boundary:** anchor on the latest visible
  persisted user message. Assistant rows after it are current-turn and ineligible
  even if an earlier snapshot repeats the id; with no visible anchor every
  assistant row is conservatively current. Current-turn results still count in the
  size walk.
- Markers name the canonical tool id, a 12-hex digest of the normalized args key,
  and direct the model to re-run. Raw args and results stay byte-identical in
  `mastra_messages`.
- Commit at Layer 1's four decoration points with
  `ON CONFLICT (tool_call_id) DO NOTHING`, so replay scans cannot double-prune. It
  adds no job, queue, LLM call or per-invocation query. Only an actually inserted
  batch resets loop guards and emits `tool_projection_prune_batch_committed`.

Evidence: `assistant-persistence/tool-projection-pruning.md`.

## CONVERSATION REWIND TOMBSTONES

Soft rewind hides a contiguous suffix without destroying it, so one-level redo is
exact and the messages die only when the next user message finalizes.

- **State:** `brainstrike_assistant_message_tombstones` (migration 080, FK-less):
  `message_id` PK, `thread_id`, `rewind_id` NOT NULL, `revert_id` NULLABLE,
  `tombstoned_at`; indexed on `(thread_id)` for the read anti-join and
  `(rewind_id)` for batch redo. In `THREAD_DELETE_SIDECAR_TABLES` and the reset
  registry.
- **Two batch ids, because rewind has a scope choice.** `rewind_id` is the batch
  identity and redo key in BOTH modes; `revert_id` links the paired file restore
  and is NULL for `conversation-only`. One shared column would force a fabricated
  revert id or a nullable redo key — and a nullable redo key is how a batch gets
  lost.
- **`message_id` is the primary key on purpose:** a message is tombstoned at most
  once by exactly one batch, which is what makes "delete the newest batch" an exact
  inverse. A re-covering rewind keeps the ORIGINAL row.
- **Prefer the stored run↔turn link for the file-revert range.**
  `thread_runs.turn_message_id` (nullable, created by MIGRATION 118) records the
  user message whose turn each run belongs to, stamped at `createThreadRun` from
  the last REAL user message (echoes excluded), so initial sends and both resume
  paths stamp the SAME id. Because the chain guarantees the column, reference it
  unconditionally — no `information_schema` probe.
- **The fallback anchors the target message against `completed_at`:** a run is in
  range when it had not yet finished when the target was sent. A TURN IS NOT ONE
  RUN. Why: the old `started_at` rule swept the previous turn's resume runs into
  the revert and once DELETED a user's file; a run row is minted milliseconds
  before its own user message, so `started_at` cannot order them. NULL
  `completed_at` counts as in range and is unreachable from `applyRewind`.
- **A rewind is invisible without a re-hydration bump.** Bump
  `useRewindStore.generation` on a successful apply AND redo, forward it as the
  panel's `historyGeneration` into the runtime `key`, and read it in
  `useChangeset`. Discarding the live thread's in-memory state is the point.
  Deliberately NOT folded into `threadKey`: per-thread state must survive a
  rewind. The modal bumps BEFORE handing text to `useRewindComposerStore`.
- **Restores delete files, so they must prune directories.**
  `pruneEmptyAncestorDirectories` walks up from a deleted path removing now-empty
  directories, stopping at the first `rmdir` refusal and unconditionally at the
  workspace root; failures are swallowed. Known accepted limitation: an
  intentionally-empty pre-existing directory on a created file's path is pruned.
- **Capture scope covers shell side effects now**, so the old "files created by
  shell commands aren't restored" copy is UNTRUE, deleted, and its absence pinned.
  The honest remaining states are "this turn predates workspace snapshots" and
  per-turn capture-failed refusals.
- **Mastra stays the writer of message content.** Nothing alters a `mastra_*`
  table; hiding is an anti-join in Brainstrike-owned reads and the finalizing hard
  delete goes through Mastra's own `deleteMessages`. **FIVE read paths apply the
  exclusion and four do not share a WHERE clause with the first:**
  `listMessagesWhere` (covers all of OM), `findMessageRowById` (recall include
  targets), `listAdjacentThreadMessageRows` (the neighbour window — TRUNCATES at a
  tombstone, never skips over one), the renderer hydration window (inside the
  windowing subquery, so the window is the latest N VISIBLE messages), and
  `thread-search-repository`'s SEARCH ARMS only — never `sync`,
  `refreshActiveThreads` or `getCoverage`, so redo restores visibility without
  owing a re-embed and the membership fast path and orphan GC still converge.
- **Probe sidecar presence in `PgliteMemoryStore`, never assume it**, and latch the
  `to_regclass` result TRUE only; caching "absent" would leave a store built before
  migrations ran ignoring every rewind for the process lifetime.
- **Finalization runs in MAIN** over a BARE `PgliteMemoryStore`, because the store,
  the sidecar writer and the delete all live there and a renderer-side
  finalization could only reach `mastra_messages` with raw SQL. Its trigger is
  renderer-side over `changes:finalizeRewinds`: a USER-AUTHORED message starting a
  NEW run.
- The delete runs FIRST and its failure PROPAGATES, so a thread whose messages
  could not be removed keeps its tombstones and stays hidden. The caller never
  blocks the send: log, toast, retry on the next send.
- Finalization is idempotent and serialized per thread with `withThreadRewindLock`;
  redo re-reads its batch INSIDE the lock so it can LOSE, returning
  `rewind-not-found` before touching a file.

Settled: OM residue survives a tombstone and is accepted — Mastra exposes no
partial un-observe, and scrubbing observation text is guesswork. No `mind_ops` row,
by ruling: a tombstone is not a deletion.
Evidence: `assistant-persistence/rewind-tombstones.md`.
Guard: `packages/db/__tests__/migration-080-assistant-message-tombstones.test.ts`,
`packages/agent/src/pglite-mastra-memory/__tests__/pglite-memory-store-tombstones.integration.spec.ts`,
`apps/desktop/src/__tests__/assistant-server/rewind-service.integration.test.ts`,
`rewind-ipc-handlers.integration.test.ts`.

## AGENTIC CONVERSATION COMPACTION

A durable, visible compaction pass on top of recency pruning: a **compaction
summary message** plus a **message-range overlay** that excludes summarized raw
messages from the provider prompt, leaving every raw message unchanged in
`mastra_messages` and visible in scrollback.

- **Trigger:** add the previous run's durable prompt baseline to the current
  message estimate and check against 90% of the same `deriveAgentLoopInputTokenLimit`
  denominator the meter uses; target ~70%. Recency pruning runs first and
  compaction proceeds only if usage is STILL ≥ 90% after it. No calibration row or
  a failed lookup uses baseline 0 with a debug log; a baseline already at or above
  the target warns and no-ops the agentic path for that turn.
- **`resolveCompactionInputBudget` RETURNS `runtimeData.agentLoop.inputTokenLimit`
  whenever the run carries one.** Never re-derive a second budget here. A run with
  no `agentLoop` calls the SAME `deriveAgentLoopInputTokenLimit`, fed the output
  `buildModelSettingsOption` sends; a PRESENT but unusable `inputTokenLimit` THROWS
  rather than quietly resolving to a different number.
- **Persistence is a metadata marker, not a new enum:** an ordinary
  `role: 'assistant'` message whose `metadata.custom` carries
  `brainstrikeCompactionSummary`, validated by a strict guard. Migration 088 adds
  `brainstrike_assistant_compaction_ranges` (FK-less, thread-scoped) storing the
  exact ordered id set, because persisted ids are opaque, not sortable range keys.
  Registered in both runners plus `THREAD_DELETE_SIDECAR_TABLES` and factory reset.
- **Exclusion, not deletion.** `CompactionOverlayProcessor` implements
  `processInputStep` in the same per-call `inputProcessors` pipeline as
  `ToolProjectionRewriteProcessor`; Mastra fixes the ordering, so compaction runs
  upstream of prompt conversion and Layer 1/2's `processLLMRequest`. It excises ids
  in `compacted_message_ids` except protected messages (skill activations, plan
  tool-call messages, pinned messages, prior summaries, adjacent hook-injected
  system context). Protection is closed to a fixed point over shared tool-call ids,
  so a call and its result can never straddle the boundary.
- **Rewind interplay is free self-healing:** a compaction row is active ONLY IF its
  `compaction_message_id` is still present in the already-tombstone-filtered
  messages. A rewind before the summary makes the whole compaction inactive and the
  raw range flows through untouched; redo un-hides the summary through the ordinary
  batch; a finalized delete leaves an inert orphan row needing no cleanup job.
- **Reload:** the summary hydrates through the ordinary 80-row window, and its
  producer writes a `message_parents` row with `parent_id = NULL` so it starts a new
  topology group. The renderer renders it as a labeled divider/card, not a bubble.
- **Agentic generation** runs on the thread's current chat provider, metered
  through the normal provider-usage path. Build the summarizer's input by walking
  the already-processed prompt, never raw `mastra_messages` content, so a
  summarizer call cannot re-inflate the budget it exists to shrink. Output follows
  the fixed Goal / State / Decisions / Next / Files touched schema.
- **Deterministic fallback** triggers off the local-vs-provider overflow
  classification, never a second LLM call, and commits the identical
  message+overlay shape with an honest one-line index of what was dropped (counts
  and date range, never a synthesized narrative).
- A committed batch resets loop guards and `resetFileReadState`, since it collapses
  evidence a guard or dedup stub may point at.

Evidence: `assistant-persistence/compaction-design.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/conversation-compaction-input-budget.test.ts`.

### Trigger and prune-first mechanics

- The capability runs after the `UserPromptSubmit` gate and before
  `resolveInitialAgentStream` constructs the real user turn.
- Resolve the denominator from the static catalog; a runtime-discovered model may
  use only an already-resolved positive `agentLoop.inputTokenLimit`, never a
  guessed window.
- The first threshold estimate walks raw messages without materializing the deep
  projection clone; only past 90% load the rewrites, project, and recompute
  provider-visible usage. Below the threshold the trigger is a strict no-op: no
  recency scan, no write.
- If pruning brings usage below 90% the turn proceeds; otherwise compaction commits
  candidates outside `selectProtectedMessageIds` and aims for
  `max(1024, 0.70 * budget - baseline)`. Protected messages can make that target
  unreachable and are never sacrificed, and the 1024 floor stops deterministic
  pruning erasing recent state on a small model.

Known duplication: this server-side walker is a second implementation of the
renderer heuristic because the renderer's depends on assistant-ui message
utilities. Move it to a shared dialect-aware package if those shapes converge.
Evidence: `assistant-persistence/compaction-trigger-mechanics.md`.

### Agentic summary call, projection, persistence, and metering

- `projectCompactionMessages` is the plain-data counterpart of
  `ToolProjectionRewriteProcessor`: prune markers always replace the stored result,
  supersession markers only while their superseder is provider-visible. Neither
  `toolInvocation.result` nor `providerMetadata.mastra.modelOutput` may retain a
  rewritten raw result.
- The auxiliary call uses `createMastraAgentRuntime` with the current trusted
  provider/model transport and no memory, MCP, tools, personas, permissions, hooks,
  task list or compaction callbacks, then one `Agent.generate()`.
- The first occurrence of all five headers must appear in order; content may begin
  on the header line, and later duplicate header-shaped prose does not invalidate a
  complete summary. A missing or out-of-order section is a schema failure that
  routes to deterministic fallback.
- Provider-reported `totalUsage` is REQUIRED; estimates never enter this
  cost-accounting path. Emit it as a `child-run-usage` chunk with
  `source: 'compaction-summary'` under the parent `runId` (migration 090 widens the
  `run_kind` CHECK).
- On success save the format-2 assistant message, record it as a new root topology
  group, then call `recordCompactionRange` with the exact ordered ids. Only schema
  failure or a stable summarizer context-overflow code reuses the computed
  candidate set for a deterministic commit; abort, rate limit, auth, network and
  unclassified failures leave history intact and return a no-op.

Evidence: `assistant-persistence/compaction-summary-call.md`.

### SWALLOWED-COMPACTION BREADCRUMB KIND

`compaction.failed` records that `runConversationCompactionBeforeStream`
(`packages/assistant-service/src/stream-init-compaction.ts`) caught a throw, so
THIS turn reached the provider uncompacted and over budget. The catch is correct
and stays — a compaction failure must never kill the user's turn — but it must not
degrade in silence.

- Status is always `'failed'`, never `'running'` (`NEVER_RUNNING`), and
  deliberately NOT `run.failed`: the turn is healthy, and `data-stream-mapper`
  derives `thread_runs.error` from `run.failed`.
- In `isAlwaysVisibleRunEvent`, LOAD-BEARING: nothing else cards this fact, and the
  user's only other symptom is a later overflow error naming an unrelated cause.
- **ONE KIND, REASON IN THE ROW.** No `compaction.budget.failed` taxonomy: a
  hand-maintained classifier would need extending for every new throw and would
  bucket the next one into "other". The reason travels in `detail` and
  `metadata.reason`, redacted and bounded by `boundRunEventReason` — whose
  credential patterns match any `scheme://`, not just `https?://`, because
  compaction failures quote driver URLs. The row does NOT carry the resolved
  budget: the class where one would be most informative is the class where none was
  resolved.
- **ONCE PER (THREAD, REASON), not per turn**, because most of what reaches this
  catch is sticky and an unlatched row would grow one always-visible entry per turn
  forever. The latch keys on the reason, never the thread alone, so it cannot hide
  a DIFFERENT failure; the `warn` log is NOT latched.
- **The key is the SHAPE of the throw, and the set is capped.**
  `compactionFailureKey` digests the UNTRUNCATED message through
  `redactRunEventReason` with volatile tokens masked, and
  `MAX_TRACKED_COMPACTION_FAILURES` (512) caps the set with drop-oldest eviction.
  Both halves are required: the cap alone leaves the per-turn row noise, the
  shaping alone leaves unbounded growth.
- Mask exactly two volatile classes — canonical UUIDs and ISO-8601 timestamps.
  SHORT DIGIT RUNS ARE DELIBERATELY NOT VOLATILE: `ollama/llama3.2` and
  `ollama/llama3.3` are different failures. Do not widen these patterns.
- Drop-oldest, not LRU: the fast path only READS the set and first-seen order is
  already exact; eviction costs a repeat row, never a silence. The idempotency
  guard in `latchCompactionFailure` is load-bearing: at the cap, a commit that
  added nothing would evict an unrelated thread's entry.
- **NO THREAD ID, NO LATCH.** Such a turn always mints and its `markReported` is a
  no-op; one shared bucket would let a single row permanently silence a different
  conversation.
- The key is LENGTH-FRAMED (`<threadId.length>:<threadId><reason>`), not
  NUL-delimited. Why: a NUL reproduced in review text made the review publication
  fail at two heads, and `lint:no-raw-nul-bytes` cannot catch it because the source
  held the escape.
- **THE LATCH ARMS ON DELIVERY, NEVER ON MINT.** `compactionFailureChunk` reads the
  key and returns the chunk bound to a `markReported` commit, called after the
  consumer has taken it. The pairing is one value, so the row cannot be emitted
  without arming nor the latch armed without emitting. Delivery is not proof of
  persistence or of rendering.
- A CANCELLED turn mints nothing: `run.cancelled` already reports it. The
  breadcrumb rides the SAME stream prelude as the compaction summary's
  `child-run-usage` chunk, so there is no second seam to keep in sync.

Settled: every guard here is mutation-proven — removing a masking pattern, widening
to all digit runs, keying on the bounded reason, removing eviction, or removing the
idempotency guard each fails exactly one intended test.
Evidence: `assistant-persistence/compaction-failure-breadcrumb.md`.
Guard: `packages/assistant-service/src/__tests__/stream-init-compaction.test.ts`,
`packages/assistant-ui/src/__tests__/run-events.test.ts`.

### Context-overflow recovery scope

- The live Mastra `'error'` part checks only the stable `context_length_exceeded`,
  `max_tokens_exceeded` and `token_limit_exceeded` codes, and awaits the desktop
  recovery callback before `makeProviderErrorTermination`. Recovery makes NO model
  call: it drops the oldest eligible provider-visible messages to the 70% target,
  saves the deterministic summary, and commits
  `recordCompactionRange(kind: 'deterministic')`. The terminal error then tells the
  user deterministic compaction was applied.
- **Do not auto-retry the same turn.** There is no outer retry owner above
  `streamMastraAgent`; a safe one needs a bounded wrapper that cannot overlap
  Mastra's `StreamErrorRetryProcessor`, cannot loop on deterministic overflow, and
  leaves every non-overflow error terminal. Recovery creates headroom for the next
  request only.
- The renderer seam is `AssistantMessage` recognizing the strict durable marker
  before its ordinary bubble path and mounting `CompactionSummaryCard`.

Evidence: `assistant-persistence/context-overflow-recovery.md`.
Guard: `apps/desktop/e2e/assistant-compaction.desktop.test.ts` (mocked endpoint: it
proves the renderer transport, divider and durable reload, not a native recall).

## CANVAS DOCUMENT VERSIONS

Persisted Canvas HTML is application-owned local-first state in
`brainstrike_canvas_versions` (migration 082). Rows sharing `canvas_id` form one
document and the greatest integer `version` is current.

- Ids are app-side uuidv7, timestamps read as `created_at::text`, and `created_by`
  is CHECK-constrained to `assistant | user` and validated again on repository
  reads. No FKs — the numbered runner uses a bare schema.
- `THREAD_DELETE_SIDECAR_TABLES` owns cleanup for all three thread-delete
  implementations; the reset registry owns all three clear paths.
- Every update or rewrite writes a NEW version. Exact updates require `oldString`
  to occur once: zero and multiple matches return `no_match` and
  `ambiguous_match`, and a missing canvas returns `not_found`. Stored-vocabulary
  drift throws visibly as corruption.
- `brainstrike.manageCanvas` exposes `create`, `update`, `rewrite`, `list`, and
  runtime thread/resource identity is mandatory. `create` requires content: an
  empty document returns `empty_document` with a hint and writes no version 1.
- The panel's selected canvas is `focusedCanvasId` on the Changes navigation store;
  reset clears it.

Evidence: `assistant-persistence/canvas-document-versions.md`.
Guard: `packages/db/__tests__/migration-082-canvas-documents.test.ts`,
`canvas-repository.test.ts`, `manage-canvas-tool.test.ts`.

## TOOL-CALL TOKEN TELEMETRY

`brainstrike_tool_call_telemetry` (migration 083) stores one row per observed final
model projection: tool id, serialized model-facing characters, truncation flags,
and search-only zero-match/pagination booleans, drained at run end into the desktop
persistence capability.

- The writer derives `thread_id` from the renderer-created run row with
  `INSERT ... SELECT`, warns without failing the turn on a missing run or write
  failure, and never accepts raw input/output fields.
- Subagent tool calls attribute under the PARENT run through the SAME
  `RunTokenDiagnostics` instance but a distinct telemetry-only method,
  `recordSubagentToolOutput`. The two intentionally diverge: `recordModelOutput`
  also feeds the run's projection aggregate reconciled against the per-leg prompt
  SUM across steps, and a subagent tool output never enters the parent's prompt, so
  routing it there would inflate that aggregate with no matching prompt change.
  Both feed the same telemetry array, so samples ride the existing drain with no
  new chunk type.
- Measurement-fidelity caveat: the persona tool map is built pre-settlement while
  the primary map is post-settlement, so a parent call is measured against its
  settled artifact page while a child call of the same tool is measured against the
  unsettled inline projection. Both land keyed only by `tool_id`, so the shipped
  `token-spend-by-tool` lens blends them.
- The table is FK-less; `THREAD_DELETE_SIDECAR_TABLES` removes thread rows and the
  reset registry owns all three table-enumerating paths.

Known gap: there is no origin discriminator beyond `toolId`; a per-persona
breakdown needs a migration and is deliberate future work.
Evidence: `assistant-persistence/tool-call-token-telemetry.md`.

## TOKEN-ESTIMATE CALIBRATION PAIRS

`brainstrike_token_estimate_calibration` (migration 086 plus additive 089 and 091)
stores one attributable run-end pair per completed run with at least one measured
tool output: the chars/4 estimate and `final_step_prompt_tokens`.

- The internal chunk is consumed by the desktop persistence wrapper and never
  reaches the renderer. The writer derives `thread_id` through `INSERT ... SELECT`,
  warns without failing the turn, and stores only ids, token counts,
  model/provider strings and a timestamp.
- Migrations 089 and 091 add nullable positive resolved domain/transport budget
  columns and `prompt_baseline_tokens`. Historical rows stay NULL rather than
  receiving a guessed tier or value.
- The numerator is model-visible tool-output projections plus tool definitions,
  each counted once; the denominator is the latest step's prompt count, which
  already contains every prior tool output once — not the cross-step billing total.
- The ratio is reconciliation evidence, not permission to tune
  `APPROX_CHARS_PER_TOKEN`.
- The table is FK-less and part of the schema PROBE. Scheduled maintenance prunes
  rows after 60 days on both idle and active passes, and the idle pass runs
  `VACUUM (ANALYZE)`.
- The checked-in `estimator-calibration.sql` lens groups by model and both resolved
  budget columns; NULL groups expose legacy pre-089 samples honestly.

Evidence: `assistant-persistence/token-estimate-calibration.md`.
Guard: `packages/db/__tests__/search-lens-estimator-calibration.test.ts` (parses and
executes the checked-in lens, not an inlined copy).

## TASK LEDGER (RUN OUTCOMES + LEDGER READ MODEL)

Per-run cost and outcome analytics over tables the assistant already writes.

- **Experiment treatments:** `brainstrike_assistant_run_treatments` (migration 093,
  no FKs, retained on thread delete, cleared by factory reset). One row per hosted
  run, `run_id` PK, recorded DETACHED from the injector seam — the one place that
  knows whether injection happened and its exact text — so the write never blocks
  prompt assembly. Continuation legs mint their own runId and return before the
  injectors, so `recordContinuationRunTreatment` covers them; otherwise they carry
  outcome labels with no treatment row, a systematically biased gap.
  `injection_status` keeps the non-injection reasons apart and `signal_injected`
  is derived and CHECK-pinned. A malformed experiment assignment warns and stays
  un-enrolled, never coerced. `ON CONFLICT (run_id) DO NOTHING` — first treatment
  wins. Do NOT infer treatment from date windows or the current preference value;
  this record exists because both are unsound.
- **Outcome labels:** `brainstrike_assistant_run_outcomes` (migration 062, no FKs).
  At most ONE label per run, upserted on `run_id`, with provenance
  `user | edit_revert | hook` and `detail` bounded at 2000 chars (oversized THROWS,
  never silently truncated). A later user verdict replaces a derived label; a hook
  label never overwrites a user verdict (`source <> 'user'`, enforced by both
  writers). The hook write is awaited in front of the stream's `message-finish`
  yield so a finishing run cannot lose it.
- **User verdicts** mount on every assistant message and render once per run, on
  the leg carrying the terminal `run.finished` part. `run.failed` legs are excluded
  in v1 and web local-runtime events without a runId are skipped. Verdicts gate on
  the repository's optional `recordRunOutcome` (present wherever the PGlite repo
  exists, including web), not the desktop checkpoint bridge. A rejected save shows
  a visible retry, never a silent drop. Write-only in v1.
- **Ledger read model:** `getRunLedger(resourceId, {limitLatest})` aggregates each
  `thread_runs` row with summed usage tokens, exact billed cost (ABSENT — never a
  fabricated 0 — when unreported), top-level `tool.completed`/`tool.failed` counts,
  edit-checkpoint totals and reverted counts, computed `durationMs`, and the
  outcome label. `RUN_LEDGER_AGGREGATION_SQL` + `mapRunLedgerRow` are the exported
  single source of truth, and the strict mapper THROWS on malformed aggregates.
- **Ledger panel** renders inside the Cost Tracking settings category,
  renderer-direct over a PGlite live query (limit 50), gated on
  `hasDurableAssistantUsageCapability()` like the sibling panel. Honest cost: exact
  renders as-is, a registry-priced remainder is "est.", unpriced models read "cost
  unavailable", zero-usage runs read "no usage recorded" — NEVER a fabricated $0.
  Malformed aggregates and query failures surface as a visible error with retry,
  never an empty-but-fine panel.
- **Budget guardrails:** caps (`dailyCapUsd`, `perRunCapUsd`, both null = off)
  persist with STRICT set validation (finite > 0 or null, else THROW) and reset
  with factory reset. Spend is DERIVED, never stored: `DAILY_SPEND_AGGREGATION_SQL`
  sums a ROLLING `NOW() - INTERVAL '24 hours'` window — deliberately timezone-free,
  so ALL copy says "last 24h", never "today" — binding each SQL param exactly once.
  Exclude unpriced-model tokens from the total and surface them as an explicit
  "+N unpriced" marker, never a fabricated price.
- Over-cap rules are no silent block and no silent allow: while
  `overCap && !overridden`, BOTH send paths are disabled and a visible notice names
  the numbers with an explicit session "Send anyway"; an active override is stated;
  Stop/Cancel is never gated. If the spend query fails the guardrail DEACTIVATES
  and logs an error — v1 fails open, because blocking on a broken analytics query
  is a silent block with no honest number to show. `perRunCapUsd` is DISPLAY-ONLY.
- **Subagent budgets** use strict `parseRuntimeSubagentSettings` (invalid THROWS
  and lands nothing; an invalid persisted payload sanitizes to defaults) and ship
  on every request as `runtimeData.subagentSettings` — see
  `docs/agents/assistant-subagents.md`.

Evidence: `assistant-persistence/task-ledger.md`.
Guard: `packages/db/__tests__/migration-062-assistant-run-outcomes.test.ts`,
`packages/assistant-data/src/__tests__/run-ledger-row.test.ts`, the run-outcome and
run-ledger cases in `assistant-memory-repository.integration.test.ts`,
`apps/desktop/src/__tests__/assistant-server/hook-run-outcome.integration.test.ts`,
and the panel and budget-guardrail suites under
`packages/app-shell/src/cost-tracking/__tests__/`.

---

## THREAD GROUPS (FOLDERS) IN THE THREADS PANEL

User-defined groups organize the panel: rank-ordered sections, an **Ungrouped**
section always last, drag-and-drop, and a Group by / Sort by popover.

Where state lives (do not relitigate):

- Groups in `brainstrike_assistant_thread_groups`; membership and manual order in
  `brainstrike_assistant_thread_placements` (migration 054; 056 adds nullable
  validated `color` and an independent `flat_rank`). Membership deliberately does
  NOT live in `mastra_threads.metadata`: grouping, colour and order are
  Brainstrike-owned presentation state.
- Placements have no FK to `mastra_threads`, so a placement whose thread is gone is
  inert. Bulk deletion removes placements and owned rows in one guarded CTE and an
  unknown id mutates nothing; deleting a group nulls its placements' `group_id` in
  one CTE after staged confirmation, preserving each thread's flat rank.
- Thread icon/colour updates preserve conversational `updatedAt`: visual curation
  must never reshuffle a recency-sorted collection.
- `rank` columns are `fractional-indexing` keys; a positional drop rewrites the
  destination section's ranks wholesale in a SINGLE multi-row upsert and silently
  switches Sort by → Custom so the drag is honored, never ignored.
- View prefs persist via zustand `persist`
  (`brainstrike-assistant-thread-groups-v1`, state version 3) with a registered
  session resetter. `threadFilters` lives in the same store but is session-only:
  excluded from `partialize`, cleared by `reset()`. A malformed persisted blob
  still THROWS rather than being coerced.
- **`groupBy: 'folder'`** groups by `metadata.operatingRootId` (display name and
  path are never identity). It is NOT a custom group: `buildThreadListSections`
  returns a `{ kind: 'folders' }` view whose section ids are `folder:${rootId}` or
  the HYPHENATED `folder-unassigned` sentinel, which can never collide with a root
  literally named `unassigned`. `BuildThreadListSectionsInput` is a union
  discriminated on `groupBy`, so the COMPILER — not a runtime throw — requires each
  arm's inputs, and folder rows are supplied BY THE CALLER.
- `use-thread-folder-rows.ts` runs ONE batched `roots WHERE id = ANY($1)` per
  distinct id set, warning ONCE per id with no row. It is deliberately NOT a live
  query: the columns it reads are immutable, and a newly connected folder reaches
  the panel through the INPUT. Its `rootIds` are THREAD-DERIVED, so a mounted
  folder with no threads produces no section. A failed query reports `error`, NOT
  an empty resolved map — an empty map with `loading: false` files every thread
  under "No folder". Its rows carry the RAW `roots.path` while the branch map is
  keyed by NORMALIZED path; a consumer joining them must normalize first.
- Unseen badges derive from a pure `deriveUnseenThreadIds` (terminal `latestRun`
  completed after the thread's watermark, active thread excluded,
  `failedUnseen ⊂ unseen`; a terminal run with NO `completedAt` is excluded rather
  than given a substitute timestamp) plus `useMarkActiveThreadViewed`, which stamps
  on the way in AND out and again when the active thread's run reaches a new
  `completedAt`, so a foreground finish can never later read as unseen.
- Folder branch chips come from ONE `useGitInventory()` GATED on `enabled`, because
  one load is a full repo/worktree scan across every root and the chips exist only
  in folder grouping — entering it is the gesture, so this is a deferral, not a
  silent disable. THREE KEYED LOOKUPS resolve a branch: FIRST `byRootId` (durable
  `roots.id`, only ids in exactly one worktree's containment); an id-only miss
  checks `byRootIdAndPath` for the same id plus the thread's exact normalized
  worktree path; THEN, only for a legacy thread with no durable id, `byRootPath`.
  BARE worktrees are omitted from all three. Desktop only. Why the id join exists:
  `normalizeRootPathForLookup` cannot resolve symlinks — `roots.path` keeps the
  mounted path while git reports the realpath — and `containment` is computed in
  MAIN against realpath'd paths.
- Folder sections are real expandable treegrid parents whose node id IS
  `section.id`, so one id addresses the row, its disclosure limit, its collapsed
  flag and its membership; a section id the module did not mint THROWS rather than
  becoming an unreachable node. `ThreadPanelVisibleRow` group rows carry a `header`
  discriminator because **Ungrouped** and **No folder** are different facts.
- Folder sort is `folderSortBy` (Recency/Name); **Custom is not offered** — a folder
  section has nowhere to persist a drag — and `setSortBy` THROWS in folder mode.
  There is no drag shell and no move/remove row action, and
  `resolveThreadsPanelDrop` answers `none` for a folders view before any resolver
  runs. The header's one action is **New thread here**: `createThread` then ONE
  `updateThreadMetadata` carrying the whole binding. If creation succeeds but
  binding fails, the thread is preserved in **No folder** with an explicit
  partial-success toast — never deleted to make the toast look atomic.
- Run state gets ONE badge slot per row, priority
  `needs-you > running > failed-unseen > done-unseen`, as a pure function. Every
  glyph carries an `aria-label` naming its thread.
- **ONE LIVE QUERY PER SIGNAL, NEVER PER ROW.** Active-run, awaiting-approval and
  unseen each report their own failure and the panel renders it explicitly, rather
  than presenting the empty set as "every thread is idle / unblocked / in no
  folder".
- The per-thread watermark lives in `assistant-thread-store.ts` (state version 4,
  partialized; `migrate` fills ONLY that key and `unseenBaselineAt` and passes the
  rest through — the threads blob has never been validated on load and must not
  start being silently repaired). `markThreadViewed` is idempotent and monotonic;
  selection and tab actions do NOT mark implicitly.
- `unseenBaselineAt` is the FLOOR under that watermark, compared as
  `max(watermark, baseline)`. Without it a fresh install would dot EVERY thread
  whose latest run ever completed. It is stamped at store creation, by the v3→v4
  migrate and by `resetAssistantThreadStore`; only ever raised, never inferred.
- Call `pruneFolderCollapseIds` ONLY with a live root set you actually know — the
  panel calls it from RESOLVED folder rows. Why: an empty folder map is also what
  loading, a failed query and every non-folder mode look like.
- Panel chrome stays TWO rows: toolbar then search. The count and select-visible
  toggle describe the treegrid, so they render only when
  `resolveThreadPanelContentState` says the treegrid is on screen AND search is
  idle. Search results replace the tree in a hidden subtree containing the bulk
  overlay, so a live toggle there would select threads with no feedback.
- `Show only` filters live INSIDE the view-options popover, are a UNION not an
  intersection, light the trigger's dot, and when they empty the list the panel
  names THEM rather than claiming there are no threads. In folder grouping an
  unresolved or failed folder map replaces the treegrid with its own card.
- The panel uses shared `TreeTable` as its only scroll owner; disclosed rows are
  virtualized and capped at 50 with an explicit 50-row Show more. Keyboard/a11y
  fallback for every drag is the row context-menu Move/Remove.

Layers: repository → store → pure view-model `thread-list-sections.ts` → panel
state `use-thread-panel-selection.ts` → body arbitration
`thread-panel-content-state.ts` (read by BOTH body and toolbar so they cannot
disagree) → view surface `threads-panel-view-options.tsx` → pure drop reducer
`threads-panel-dnd.ts` → element wiring. Cost of that ownership: a checkbox toggle
re-renders all of `ThreadsPanel`, but `buildThreadPanelVisibleRows` is memoized on
the same deps — render breadth, not recomputation.

Evidence: `assistant-persistence/thread-groups-and-folders.md`.
Guard: `packages/db/__tests__/migration-054-assistant-thread-groups.test.ts`,
`migration-056-assistant-thread-group-presentation.test.ts`,
`packages/app-shell/src/__tests__/threads-panel.test.tsx` (its `usePGliteLiveQuery`
double routes rows BY `cacheKey`; the two projections share a row shape),
`thread-panel-visible-rows.test.ts`, `threads-panel-dnd.test.ts`,
`thread-panel-content-state.test.ts`,
`apps/desktop/e2e/threads-panel-folders.desktop.test.ts`,
`apps/web/e2e/threads-panel-folders.test.ts`.

## TOOL OUTPUT ARTIFACT PERSISTENCE

Migration 068 and `ToolOutputArtifactRepository` own complete oversized tool
outputs; migration 129 adds native execution-thread identity to deduplication
within the same root resource/thread/run.

- `content` is `BYTEA`, populated from exact UTF-8 bytes through hex text and
  `decode`. Why: this preserves U+0000 and avoids typed-array realm drift across
  browser workers and Electron IPC.
- The public id is an opaque uuidv7 token, and every read also requires the active
  `resource_id` and `thread_id`; a wrong scope is indistinguishable from a missing
  artifact. A child cursor is readable through the root-owned reader capability,
  never by supplying execution identity as read authority.
- Range reads are byte-addressed and capped by the shared 8000-byte page maximum.
  The repository returns bytes; the reader owns UTF-8 boundary adjustment and
  cursor validation.
- Thread deletion clears artifacts when either the owning root or the native
  execution thread is in the deleted subtree; sibling execution artifacts remain.
- Retention is seven days; `purgeExpired` deletes an explicitly bounded
  oldest-first batch, and expired reads return metadata without content.
- Settlement must finish the complete write before publishing an envelope and must
  never substitute a reference after a failed write. Exact replay of
  `(resource, thread, run, execution thread, tool call)` returns the existing
  reference only when format and complete bytes match; a different replay is a
  typed storage conflict, and settlement never overwrites prior evidence.
- There are deliberately no Mastra FKs. Both direct-PGlite reset paths and desktop
  `db:clearAll` delete artifacts explicitly; only a pre-068 missing relation is
  tolerated.
- Desktop injects a trusted request-scoped adapter when resource, thread and
  server-owned run ids are all present. The settlement wrapper persists complete
  non-media native/MCP results above 12,000 UTF-8 bytes, caps one artifact at
  16 MiB, and publishes a preview envelope only after coherent metadata returns.
  MCP image/audio stays inline; hosts without the adapter retain the temporary MCP
  text/JSON inline ceiling.
- Per-tool serialized-character thresholds may be stricter: desktop sets
  `brainstrike.webExtract` to 2400 characters so small extracts stay inline while
  larger content is committed as one exact JSON artifact first.

Evidence: `assistant-persistence/tool-output-artifacts.md`.
Guard: `packages/db/__tests__/migration-068-tool-output-artifacts.test.ts`,
`tool-output-artifact-repository.test.ts`,
`packages/agent/src/mastra/__tests__/tool-output-artifact-settlement.spec.ts`.

## THREADS PANEL HYBRID SEARCH

Hybrid lexical + semantic + title search over threads. Mastra has no cross-thread
content search, so this is Brainstrike-owned derived state under the same ownership
ruling as thread groups: never ALTER the Mastra tables.

Where state lives (do not relitigate):

- **Index:** `brainstrike_thread_message_index` (migration 067; one row per Mastra
  message, no FKs — orphans are inert and swept by the bounded GC). `content_text`
  is bounded plain text extracted IN SQL from the v2 content JSONB, text parts
  only; non-conversational roles keep `''` so the anti-join still sees them
  processed. `content_hash` is md5 of the RAW JSONB, so the sync upsert's
  `IS DISTINCT FROM` CAS detects progressive same-id saves and resets the embedding
  to pending. The tsvector is a STORED generated column + GIN; deliberately NO
  pg_textsearch BM25 index on a second hot-write table.
- **Semantic arm:** `searchSimilar` runs its filtered ANN SELECT inside ONE
  transaction with `SET LOCAL hnsw.ef_search` and `iterative_scan='strict_order'`.
  Why: `SET LOCAL` outside a transaction is a silent no-op, leaving the pgvector
  default and the filtered-ANN under-return class. Desktop uses the atomic IPC
  primitive; web and raw handles use the callback-style `transaction`, which holds
  the single connection's lock so concurrent scheduled work cannot interleave.
- **Embeddings:** per-message inline `vector(384)` typed to the singleton profile
  with a partial HNSW index — the prompt-library pattern, NOT the `embedding_sets`
  lifecycle and NOT the hidden-host job queue. Embedding runs in the visible
  renderer in bounded sequential resource-scoped passes. Writes are double-CAS'd on
  content hash AND profile model key, so a mid-flight same-dimension model swap
  cannot land a cross-space vector.
- **Sync:** a row-count membership fast path, bounded anti-join inserts, a
  PER-THREAD refresh with a trailing 2-minute live window (never a global
  watermark, which could starve a quiet thread forever), and bounded orphan GC.
  Runs per search pass behind a 5s TTL and an in-flight guard; every statement is
  bounded.
- **Fusion:** `ThreadSearchService` is the thread-native binding of the shared
  generic RRF core. `HybridSearchService` stays FileChunk-bound on purpose — do not
  fake chunk shapes to reuse it. Two levels: message arms fuse per message id, then
  content-ranked threads fuse with trigram-ranked title matches. Titles are matched
  live off `mastra_threads`, never copied into the index.
- **UI/state:** session-only `thread-search-store.ts` with the workspace-search
  generation contract (a monotonic token gates every async completion;
  `clearResults` keeps the typed query, `clearSearch` is the full dismiss).
  `setQuery` deliberately does NOT bump the generation — the debounced auto-search
  owns that transition; keep the two stores aligned. The controller owns a 250ms
  debounce with a 2-char minimum, sync, the backlog drain, and semantic honesty: an
  unproducible query embedding runs lexical-only WITH a visible `unavailable`
  reason (failure cached 60s), plus coverage progress and embedding-failure counts
  — never a silent downgrade.
- Render ts_headline `<mark>` tokens as elements and everything else as plain text;
  persisted content is never HTML. While searching, hide the tree rather than
  unmounting it so disclosure and selection survive dismissal.
- **Delegated scope:** lexical, semantic, title and coverage reads walk the durable
  child graph from native roots owned by the requested resource, checking
  owner/root identity and the native resource on every edge including intermediate
  ancestors. Search does not broaden ordinary memory authorization, and activation
  rechecks the selected native message, rejecting tombstoned, deleted or foreign
  hits visibly.
- Explicit child navigation uses the ordinary history mapper with an exclusive
  `(createdAt, id)` cursor, each older page capped at 80 and scoped to the same
  native thread/resource. Hydrated assistant groups retain
  `brainstrikeNativeMessageIds` so raw search ids select their rendered group.
  Navigation intent lives in the existing factory-reset-registered session store.
- **Cleanup:** panel deletion clears index rows eagerly and missed paths self-heal
  via sync GC. Factory reset clears the index and `_state` on both paths; the
  search profile row is configuration and survives.

Evidence: `assistant-persistence/threads-panel-hybrid-search.md`.
Guard: `packages/db/__tests__/migration-067-thread-search-index.test.ts`,
`search-thread-message-index.test.ts`, `delegated-thread-search.test.ts`,
`search-thread-search-service.test.ts`,
`packages/app-shell/src/__tests__/use-thread-search-controller.test.ts`,
`threads-panel-search.test.tsx`, `delegated-child-reload.integration.test.tsx`.

## ASSISTANT THREAD TABS

Open tab order is durable workspace-scoped state in `assistant-thread-store.ts`;
`reorderThreadTabs` persists the complete ordered id list atomically.

- The controller uses the WAI-ARIA automatic-activation pattern with roving tab
  focus, Home/End, Delete and `Alt+Shift+Left/Right`; pointer drag adds edge
  auto-scroll and the context menu provides the non-drag alternative. Panels stay
  mounted while inactive so runtime state is not discarded.
- `assistant-thread-presentation.ts` owns the exhaustive icon registry, the Message
  default and the canonical colour surfaces. Rows, pickers, group icon choices and
  tabs consume those shared contracts rather than local glyph maps.
- Each tree cell mounts one `ThreadRow` owning its transient edit/customize/delete
  state, keyed by thread id: a same-thread parent rerender preserves an in-progress
  rename, while a virtual cell changing identity remounts. None of that ephemeral
  state enters the persisted store.
- A successful metadata write updates the one loaded thread object, so an open tab
  reflects customization without a re-read, timer, global invalidation or panel
  remount; a failed write performs no store transition and stays visibly failed.
- `listThreads` returns the thread row plus its latest-run badge data in ONE SQL
  snapshot. Why: splitting the reads lets a metadata write interleave before a
  stale title refresh lands. The refresh captures each loaded metadata object
  before its read, so an immutable metadata transition landing mid-read preserves
  current metadata while still applying refreshed titles, badges and ordering.
  Neither path polls or retries.
- Historical run model ids stay plain persisted evidence: ids known to
  `MODEL_ID_MIGRATIONS` render as `Unavailable · <raw id>`, and unrecognized ids
  remain visible verbatim rather than being rewritten to a replacement.
- The persisted store holds tab/selection ids, not `mastra_threads` rows, so
  `loadStateByResourceId` stays `idle`/`loading` after restore until
  `ensureResourceThreads` hydrates. Composer sends stay disabled during both
  states, and root-binding resolution rejects a selected id whose row is not loaded
  — that transient absence is never an unbound thread. A terminal database
  initialization error always outranks the transient loading reason.
- The non-reloading **Clear Database** path deletes `mastra_threads`, so its
  composition must synchronously reset the thread and thread-groups stores
  immediately after the clear succeeds and before collection reloads.
  `DatabaseDemoPanel` requires and preflights that callback; capability absence
  blocks the clear visibly. Both stores invalidate in-flight hydration generations
  during reset.

Evidence: `assistant-persistence/assistant-thread-tabs.md`.
Guard: `packages/assistant-data/src/__tests__/assistant-thread-store.test.ts`,
`packages/app-shell/src/__tests__/database-demo-panel.test.tsx`,
`assistant-thread-tabs-dnd.test.ts`, `use-assistant-thread-root-binding.test.ts`;
the live customize-and-reload contract is `apps/web/e2e/assistant-ui-panel.test.ts`.

---

## Delegated conversation identity storage

`@brainstrike/db` exposes `createDelegatedConversationRepository` over a minimal
query interface for trusted host use. Register the real root, then bind each actual
native child thread beneath its immediate parent.

- Write inputs come from the host's observed native delegation context — never
  model-supplied ids or renderer requests. A native resource id is execution scope,
  not user authority.
- Every read and child creation walks the persisted graph outward from the live,
  authorized root and verifies each native thread/resource pair. A grandchild whose
  intermediate ancestor changes native scope is inaccessible even if its own row
  matches. Missing legacy graph nodes return no identity and never fabricate
  transcripts or ancestry from compact tool results.
- Nodes are immutable: duplicate creation with the same configuration is
  idempotent, conflicting ownership/ancestry/configuration is an error, and two
  calls to one persona use distinct native thread ids.
- Display name and colour are host-assigned identity snapshots. Workspace binding
  is captured at child creation; existing children retain it after the root's
  workspace changes.

Migration, reset and deletion semantics: `docs/agents/database.md`.
Evidence: `assistant-persistence/delegated-conversation-storage.md`.

### Scoped child stream hydration

Native Mastra memory remains the sole child transcript writer. The desktop run
event observer routes scoped child lifecycle events through the delegated
repository's atomic authorization/header/event mutation into the existing
thread-run and run-event tables.

- A native invocation plus current root host leg gets its own opaque child host-run
  id; the root turn id is not a child user message id, so the nullable child header
  field stays unset. Usage stays in the root-attributed writer.
- A terminal authorized event atomically settles prior running headers of the same
  invocation to the same outcome. The match requires child resource/thread plus
  native parent run, tool call, child run and persona, so it cannot close a
  different invocation in the same thread. No duplicate terminal event is minted,
  existing terminal headers are immutable, and a rejected current event cannot
  settle prior headers.
- Child lifecycle persistence is deliberately AWAITED before publication: it
  revalidates the invocation and makes the published event durable, and an
  exhausted write or identity failure propagates through the root error path. The
  root's queued writer also fails at final flush rather than tolerating lost
  events. Ordinary text and reasoning deltas perform no database round trips.
- The shared history adapter assigns events by observed native row id BEFORE the
  legacy run-window heuristic, so several resume legs can share one assistant
  group; an observed message outside the loaded window is never assigned to a
  different turn.
- **Anchor a scoped `tool.started` after its persisted tool part**, keyed by
  observed native message id and tool-call id — millisecond timestamps cannot
  establish that boundary, and timestamp weaving alone moved the event ahead of
  text, reasoning and the tool start. The anchor BLOCKS the event queue so later
  journal entries cannot overtake it. `tool.completed` and `tool.failed` also wait
  for their own tool part, including with no matching start — a lower bound, not a
  replacement timestamp.
- Tool-call deduplication is scoped to ONE assistant group: snapshot rows of that
  turn merge, while later turns and regenerated siblings keep their own same-id
  parts. A cancelled call whose unfinished tool part was removed still retains its
  journal events; hydration never invents the missing part or drops its failure
  history.
- On snapshot resume, atomic invocation binding returns the latest previously
  observed message id from the event journal, restricted to the exact native run,
  parent call and persona; projection uses it until Mastra supplies the current
  one. A missing identity fails BEFORE child projection state is registered.

Evidence: `assistant-persistence/scoped-child-stream-hydration.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/delegated-stream-parity.integration.test.ts`,
`delegated-runtime.integration.test.ts`,
`delegated-conversation-host.integration.test.ts`,
`delegated-conversation-insights.integration.test.ts`,
`delegated-deadlines.integration.test.ts`,
`packages/agent/src/__tests__/data-stream-session.spec.ts`.
These do not claim packaged UI parity or cancelled-child transcript durability.

### Tool input live/reload parity

Native Mastra storage already retains complete child tool arguments. The transport
must emit them through the normal decoder's argument-delta path before closing a
started tool; the completion frame alone does not populate that part. No duplicate
content writer or new durable store is introduced.
Guard: `delegated-stream-parity.integration.test.ts`, which establishes the
observed native message id against the actual saved row and compares
text/reasoning/tool input/result content and order before and after engine
reconstruction.

### Renderer receiver and native transcript ownership

- The optional `onDelegatedConversation` callback receives full, ephemeral child
  snapshots through the ordinary decoder and accumulator, keyed by native
  invocation across observed message changes. Full replay replaces snapshots;
  native memory remains the sole transcript writer. Missing terminals and unseeded
  or mismatched replay openings fail visibly.
- Receiver completion uses the same `deferMessageFinishUntilFlush` transform as the
  parent; both final part streams and descendant receivers settle before a complete
  snapshot publishes. Producer failures and cancellations still emit their required
  `d` finish frame — an error frame alone is a truncated stream, not a valid child
  terminal.
- Cleanup preserves the primary transport/envelope/abort failure and logs secondary
  settlement failures once; the receiver retains its FIRST observed failure if
  decoding or descendant settlement later fails.
- Consumer presence selects receiver installation at run start; an installed
  receiver reads the latest committed callback on each update, including
  replacement during an active run.

Lifecycle and remaining acceptance scope: `assistant-runtime.md`.

### Child continuation row identity

- Child output processors preserve the final native response boundary before Mastra
  re-adds response rows during finish. Why: otherwise an earlier approved tool row
  merges into the newly rotated continuation id. PGlite remains the native content
  store; no text-equality deduplication is introduced.
- Native `toolInvocation.state: output-denied` hydrates to the shared
  `DeclinedToolCallResult` through `createDeclinedToolCallResult`, preserving
  arguments and the approval reason. It is terminal without an error flag, matching
  live `tool-output-denied`; a missing `result` in the native row does not mean the
  declined call is still pending. Existing pending/result/error rows are unchanged.

Native API and verification scope: `assistant-subagents.md`.

### Hydrated delegated pause identity

Synthetic rediscovered approvals and questions preserve their exact delegated leaf
path in the normal data part, and their transient message ids use the native leaf
run/call rather than the reused root delegation alias. Repeated discovery of the
same leaf is stable; a subsequent leaf pause produces a different id and cannot
retain an earlier card's answered state. Both still chain onto the durable history
head through the existing transient-parent topology adapter, and ordinary root
pause ids are unchanged.

### Decision discovery failures remain visible

- A failed, timed-out or malformed suspended-decision response is an explicit
  recovery state, never a successful empty list. Valid entries in a partly
  malformed response remain visible alongside the error, and an absent optional
  `suspends` array retains the additive protocol contract.
- Hydration keeps durable history and appends a transient
  `suspended-run-discovery-error` notice. It is neither a native tool action nor a
  failed model response, so regeneration and copy controls must not appear on it.
  Its transient parent alias chains the next real message to durable history; it
  adds no persistence store and no native message row. A successful later hydration
  removes it.
- The request deadline starts after endpoint and auth resolution and covers the
  fetch and the response body. A malformed notice payload renders an explicit
  invalid recovery status beside the saved conversation; it must not throw during
  render and replace the thread with an error boundary.
- The current recovery action is to reopen the thread. A future persistent child
  runtime host must provide explicit history refresh rather than equating closing
  an inspection view with resetting its runtime.

### Durable delegated decision recovery display

- Rediscovered pause data retains the host's optional durable `decisionState`
  through the existing transient notice hydration path, creating no content rows
  and no durable parent edges. Reload refreshes status; it never resumes a
  workflow. The shared cards preserve tool/plan/question content and disable
  resubmission of claimed, consumed or interrupted decisions. Unknown present
  states fail wire validation, and missing snapshots still produce the visible
  discovery error.
- Delegated live views receive an immutable pre-leg history baseline from the
  admitted desktop host. The host and the ordinary renderer repository call the
  SAME `@brainstrike/db` `readAssistantHistoryMessages` /
  `readAssistantHistoryRunEvents` readers, so rewind filtering, topology and
  hydration bounds cannot diverge. The stream baseline never writes or replaces
  native message rows.

Host authority and paired proofs: `assistant-subagents.md`, "Durable delegated
decision recovery display" and "Child history boundary for a live stream leg".

### Workspace tabs and cancellation publication

The shared workspace coordinator publishes app open/close/selection immediately;
viewport and editor changes retain the existing debounce, so a reload must not
discard a new delegated tab while an unrelated scroll timer is pending. Existing
native workspace persistence owns this state; no child-specific persistence is
added. Thread-run cancellation is monotonic in both renderer and server terminal
writers, so a late completion cannot reopen a cancelled turn's child decisions.

### Explicit cancellation publication

- Desktop cancellation first marks all authoritative same-owner/root/turn legs
  `cancelling`, which is nonterminal and blocks new delegated decision admission.
  It aborts registered legs and awaits owner teardown before acknowledging,
  including the gap after a terminal write but before unregister. Only then does
  waiting work become `cancelled`.
- A live leg owns its normal turn-end capture; cancellation closes only a snapshot
  bracket whose first run belongs to those authoritative legs, including after
  process restart.
- The renderer does not preempt the server-owned cancellation with an optimistic
  terminal write. Both completion writers preserve cancelling/cancelled authority
  against every stream terminal report, including `cancelled`. Only the cancel
  endpoint finalizes cancelling rows; stream writers never cascade terminal
  cancellation into sibling legs.
- Startup reaping retains a crashed cancellation as cancelled with the existing
  orphan diagnostic; it never restores admission or fabricates the lost turn-end
  capture. Reattachment and worktree archive both treat cancelling as active.
- A renderer Stop latches cancellation on its prepared request before issuing HTTP,
  so a racing abort or error cannot publish `failed` over the server-owned request.
  The local completion callback runs only after acknowledgement. A failed POST does
  not fabricate a terminal result; a later send reconciles the latched request
  against actual durable status and stays blocked while running or cancelling.

### Cross-root child navigation

A sidebar child action activates its owning root before opening the workspace app.
`ThreadWorkspaceNavigation` holds only a session navigation intent; the existing
workspace coordinator owns hydration and persistence and drains that intent after
incoming hydration completes, so the outgoing root never captures another root's
child tab. A newer root switch discards the intent, and a read failure shows an
explicit error a further click may retry. No run is started and no alternate
snapshot store is introduced.

### Durable native background outcomes

Migration 133 registers `mastra_background_tasks` with the native PGlite adapter;
the table participates in database clear and factory reset. Task scope is the root
resource/thread, not a renderer tab, and updates use expected-status comparison so
competing transitions cannot overwrite each other.

- Reconcile completed, failed, timed-out and cancelled outcomes at the PGlite
  message commit boundary before inference. Cancellation clears the dispatch
  acknowledgement and projects an explicit cancellation error into the parent
  invocation and model input; the native task stays `cancelled` and running
  siblings are unchanged.
- The row carries `delivered_at`, separate from native status. Every ordinary save
  naming a retained task overlays its authoritative terminal outcome even after
  delivery, so a stale native snapshot cannot restore the dispatch acknowledgement.
- **The message write and the delivery acknowledgement share one transaction:
  either both commit or neither does.** Child completion and repair use the memory
  store's task-only operation, which locks the terminal task and reads current
  parent rows in that transaction instead of writing a recalled whole-message
  snapshot, so a callback cannot erase newer parent text or metadata.
- Progressive snapshots may repeat one tool call under fresh message ids; update
  every matching row while preserving each row's ordinary content. Duplicate
  matching invocation parts inside one row, a mismatched call/task pair, a foreign
  owner, or a missing retained task fails BEFORE acknowledgement.
- Delegated `subagent.*` history events carrying their originating turn attach only
  to that turn's exact tool call. An absent retained call never redirects the event
  by run or reused call id; ambiguous ownership fails visibly. Assignment may use a
  retained assistant row's explicit durable `parentId` equal to the originating
  user message even when that user row is outside the hydration window — exact
  topology evidence, not a nearest-turn heuristic.
- If retention removed every invocation, the task's durable input and outcome
  create a deterministic recovery message that visibly explains the missing
  original and that NO work was rerun. Missing failure details and timeouts get
  explicit error text, including uncertainty about external effects.
- Result/error, compact provider projection, cleared pending-decision metadata and
  delivery acknowledgement are saved together. The raw result stays UI/history
  evidence while `providerMetadata.mastra.modelOutput` carries only the child's
  text summary; the paused-run overlay uses the same projection.
- Recovery snapshots every undelivered page before acknowledging, so
  acknowledgements cannot shift pagination and skip a task. Native resuspension
  joins the workflow snapshot before exposing a new resumable decision.
- Native Mastra signal messages with `content.metadata.signal.type === 'user'` are
  human history turns: render their format-2 parts, split assistant groups at the
  human input, and retain normal branch topology. Notification and state signals
  must not be reclassified as human messages.

Installed Mastra 1.64 public APIs and source remain the compatibility authority.
Evidence: `assistant-persistence/durable-native-background-outcomes.md`.
Guard: `packages/agent/src/__tests__/background-outcome-recovery.integration.spec.ts`,
`pglite-background-result-reconciliation.integration.spec.ts`,
`pglite-background-store.integration.spec.ts`.
Native reconstructed-runtime recovery is tested separately from the desktop
process-restart pending-approval case and is not evidence of completed-undelivered
recovery through every host restart boundary.

### Active child human input

The active native child owns input consumption.

- Persist the canonical Mastra user signal BEFORE `sendSignal`, scope the client
  request id to the child's native resource and thread, and serialize requests per
  child owner. Store a pending receipt before native acceptance and a delivered
  receipt after it.
- An identical delivered request is acknowledged without another enqueue; changed
  content under the same id is REJECTED. A pending receipt after an interrupted
  acknowledgement is ambiguous and must NEVER be automatically replayed into a
  writable child. Definitive native non-delivery removes the signal from native
  memory, so a later continuation cannot recall rejected input.
- Child frames use vendor `2` out-of-band data so parent text and tool-argument
  controllers stay open; decode legacy `aui-data` child frames for stored replay.
  Accepted `data-user-message` signals route by the previously observed exact
  invocation identity, and a child human-input marker splits only that child's
  shared runtime.
- Native memory remains the durable transcript writer: the child composer never
  launches a second runtime, queues a root turn, or reconstructs a background task
  on disconnect.
- Endpoint status vocabulary: definitive non-delivery (409) for a missing or
  retired host owner and for rejected serialized admission once any saved signal
  has been removed; initial foreign-owner/scope checks stay 404; uncertain
  acceptance stays 503. Failed signal cleanup preserves both rejection and cleanup
  errors and remains an explicit 503 — it cannot claim rejected text is absent from
  future recall.
- Reload preserves the receipt in user-message custom metadata: pending input shows
  an unconfirmed-delivery notice, delivered input shows its accepted state, and
  neither dispatches work from hydration. Human input retains the native creation
  timestamp through live projection and reload.
- The same request id survives an unconfirmed acknowledgement even if the user
  edits the draft; replacing it requires the explicit Discard draft action. Stop
  waiting aborts only the acknowledgement transport — it does not stop the child or
  retract an accepted instruction. Ignore a late response from an abandoned wait
  and permit only an explicit same-id retry until discard. Blank transport failures
  become an explicit unconfirmed-delivery receipt.
- A selected conversation-key switch remounts provider state, isolating its
  retained receipt and any late acknowledgement from the new conversation.

Idle input uses the separate managed continuation contract in
`assistant-subagents.md`; the original delegation invocation remains immutable.
Evidence: `assistant-persistence/active-child-human-input.md`.
Guard: `packages/agent/src/__tests__/background-worker-stream.integration.spec.ts`,
`delegated-live-wire.spec.ts`,
`packages/app-shell/src/__tests__/delegated-conversation-receiver.test.ts`,
`assistant-conversation-panel.test.tsx`,
`apps/desktop/e2e/delegated-child-control.desktop.test.ts`.

### Search navigation correction boundaries

- Targeted history pages recheck that the selected native message remains visible
  in the same thread/resource before each 80-row read. Deleted or tombstoned hits
  end navigation visibly; they do not replace an otherwise usable child transcript
  with a history failure.
- Legacy null message resources use the native thread's resource consistently at
  search admission, cursor lookup and hydration; foreign explicit resources stay
  rejected.
- Extended search history adds only older non-overlapping groups. The host keeps
  its head and overlapping group content while their native source ids are unioned
  for exact match focus; ordinary live children do not run this merge. Title labels
  resolve in one owned-graph query per result set, and no arbitrary depth cap hides
  valid old hits.
- A delegated search extension is scoped to the host run that owned its history
  read, and a newly admitted host baseline replaces it, so deleted or rewound
  messages from an earlier read cannot reappear. Compaction alone keeps raw
  messages in durable scrollback; its provider overlay does not delete them.

### Admitted child persona configuration on resume

- Read admitted child persona configuration from the existing delegated
  conversation record when a decision resumes. Reload discovery still uses inert
  identity-only Agents; execution reconstructs each admitted depth's profile before
  reading or resuming native snapshots.
- Missing or malformed configuration is FATAL, not permission to use a changed live
  profile. The effective invocation step budget and admitted tool ids are retained,
  and current host permissions remain a ceiling. The native snapshot owns original
  task/system context and workflow progress.
- No new persistent store is introduced, so the existing delegated graph
  factory-reset registration stays authoritative.
- Compatibility: old children with missing or unsupported configuration, or an
  unexpanded wildcard catalog, cannot reconstruct their admitted permissions.
  Retain their pending native snapshot, never replay it, and answer HTTP 409
  instructing the user to start a new delegation. A mismatched persona identity
  gets a distinct integrity error. Only fixed classified messages cross the HTTP
  boundary — never stored instructions or provider/credential error text.

See `assistant-subagents.md`'s admitted configuration boundary.

### Child scope usage read projection

`readDelegatedConversationInsights` joins the authorized delegated graph with
usage's native invocation key or continuation receipt, including each stored row
once. It returns direct and inclusive subtree captured usage WITHOUT changing any
writer, root rollup, retention rule or schema.

- The selected child's latest run header provides its actual recorded
  model/provider; stored profile constraints parse through the same browser-safe
  contract native resume uses.
- Reject foreign or deleted owners and broken native ancestry. Missing usage stays
  null, and a model without pricing stays unpriced through the ordinary cumulative
  usage resolver.
- Selecting another child must not retain the previous child's totals.

### Rejected delegated usage evidence

`assistant_delegated_usage_write_failed` records the attempted delegation identity
(native parent run/call, child thread/resource), persona, model and provider
alongside the host run and error. No prompt or tool payload is logged. The write
remains fail-closed and the failed usage chunk is NOT forwarded. This evidence
distinguishes attribution mismatches without weakening the repository's identity
checks; it does not itself fix a rejected write.
Guard: `apps/desktop/src/__tests__/assistant-server/run-persistence-direct.test.ts`.
