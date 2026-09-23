# Agentic compaction design — evidence

Supports `docs/agents/assistant-persistence.md` §
"AGENTIC CONVERSATION COMPACTION". Read this before proposing to change the trigger arithmetic, the metadata marker, the overlay processor, or the rewind interplay.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Milestone 2 adds a durable, visible compaction pass on top of Milestone 1's
transient recency pruning (Layer 2, above). Where Layer 1/2 rewrite individual
tool-result projections without ever touching Mastra message content,
Milestone 2 introduces a durable **compaction summary message** and a
**message-range overlay** that excludes already-summarized raw messages from
the provider prompt — while leaving every raw message physically unchanged in
`mastra_messages` and fully visible in thread history/scrollback.

- **Trigger:** before each request, the previous run's durable prompt baseline
  (`systemInstructionsTokens + taskListTokens + toolDefinitionsTokens`) is
  added to the current conversation-message estimate and checked against 90%
  of the same `deriveEffectiveInputBudget` denominator the context-usage meter
  (BST-940) uses. Milestone 1's recency
  pruning runs first (it already fires at its own trigger points); compaction
  only proceeds if usage is STILL ≥ 90% of the effective input budget after
  pruning has had a chance to reclaim. Target is ~70% of the same budget. Both
  percentages are computed against the identical
  `agentLoopSettings.inputTokenLimit` denominator the meter uses, so a
  90%-trigger accounts for the same prompt categories the streaming ring adds.
  No previous calibration row, or a failed lookup, uses baseline 0 with an
  observable debug log and therefore preserves the pre-091 first-turn
  behavior. A baseline already at/above the 70% target warns and no-ops the
  agentic path for that turn to avoid repeated pruning toward an unreachable
  target; deterministic provider-overflow recovery remains available.
  BST-1707 made the denominator claim above TRUE in code:
  `resolveCompactionInputBudget` (apps/desktop/src/assistant-server/conversation-compaction.ts)
  now RETURNS `runtimeData.agentLoop.inputTokenLimit` whenever the run carries
  one, instead of re-deriving a second budget from the catalog's hard
  `maxOutputTokens`. The two disagreed wherever the request path reserves less
  output than the model's maximum — OpenRouter caps its reservation at
  `OPENROUTER_CODING_MAX_OUTPUT_TOKENS` (32,000), so 49 of 57 OpenRouter rows
  compacted against a budget SMALLER than the run's (`meta/muse-spark-1.3`:
  52,429 vs the run's 964,147), and `moonshotai/kimi-k3`
  (contextWindow === maxOutputTokens) made the derivation THROW — swallowed by
  `runConversationCompactionBeforeStream`, so that recommended coding model
  silently got no pre-request compaction at all. Never re-derive a second
  budget here: one derivation, three consumers. The catalog derivation stays
  ONLY as the fallback for runs that carry no `agentLoop`; a PRESENT but
  unusable `inputTokenLimit` throws rather than quietly resolving to a
  different number (the desktop assistant HTTP path does not sanitize
  `agentLoop`). Paired test:
  `apps/desktop/src/__tests__/assistant-server/conversation-compaction-input-budget.test.ts`.
  BST-1804 closed the remaining gap in that fallback. It still reserved the
  catalog's HARD `maxOutputTokens`, and once the catalog carried OpenRouter's
  top-provider maxima that gave 25,000 for `x-ai/grok-4.7` (500,000 window,
  450,000 max) and 52,429 for `moonshotai/kimi-k3` (943,718 of 1,048,576), and
  THREW for `minimax/minimax-m3` (512,000 of 524,288) — caught by the
  pre-request caller, which by then (BST-1737) warned with
  `conversation_compaction_pre_request_failed` and minted the visible
  `compaction.failed` breadcrumb, but the turn still ran uncompacted. The pure
  part of `buildAgentLoopSettings` moved into
  `deriveAgentLoopInputTokenLimit` (`packages/assistant-contract/src/context-budget.ts`);
  the renderer and this fallback now both call it, the fallback feeding it the
  output the run sends (`buildModelSettingsOption` from `@brainstrike/agent`:
  explicit `modelSettings`, else OpenRouter's reasoning-aware output window).
  Default-settings budgets are now 865,075 / 466,073 / 443,000 for those three
  rows. `packages/app-shell`'s `buildAgentLoopSettings` suite pins the renderer
  to the same reproduction the desktop test pins the fallback to.
- **Persistence — no new enum, a metadata marker (matches the
  `approval-action-message.ts` precedent):** the summary is an ordinary
  `role: 'assistant'` Mastra message whose `metadata.custom` carries a
  well-known key (`brainstrikeCompactionSummary`), validated by a strict guard
  mirroring `ACTION_MARKER_GUARD_BY_KEY`. The payload records `{ rewriteId,
  fallbackKind: 'agentic' | 'deterministic', firstCompactedMessageId,
  lastCompactedMessageId, droppedSummaryLine?, createdAt }`. Migration 088 adds
  `brainstrike_assistant_compaction_ranges` (FK-less, thread-scoped, mirrors
  084/087's shape): `compaction_message_id` PK, `thread_id`,
  `compacted_message_ids jsonb`, `kind CHECK IN ('agentic','deterministic')`,
  `created_at`. The exact ordered ID set is stored because persisted message
  IDs are opaque client-supplied strings or UUIDv4 values, not sortable range
  keys. Registered in BOTH migration runners (numbered `index.ts` + drizzle
  `customMigrations` in `migrate.ts`) — the renderer-lazy bootstrap SQL this
  originally also had to mirror was retired by BST-1651, so migrations are now
  the only registration — plus `THREAD_DELETE_SIDECAR_TABLES` and the
  factory-reset registry (thread-scoped, FK-less state must be wired into both
  per `docs/agents/database.md` / `platform-contracts.md`).
- **Message-list exclusion, not deletion — extends the Layer 1/2 overlay
  pattern instead of building a parallel mechanism:** a new
  `CompactionOverlayProcessor` implements `Processor.processInputStep`, where
  Mastra still exposes the current ID-bearing `MastraDBMessage[]`. It is wired
  into the SAME per-call `inputProcessors` pipeline adjacent to
  `ToolProjectionRewriteProcessor`. Hook-kind ordering is fixed by Mastra:
  compaction's `processInputStep` runs upstream of prompt conversion and Layer
  1/2's `processLLMRequest`, so Layer 1/2 rewrites only whatever messages
  compaction left standing. For the thread's active compaction rows,
  it excises current messages whose IDs occur in `compacted_message_ids` —
  except protected-set messages from that exact set (skill activations,
  plan/submitPlan tool-call messages, pinned messages, prior compaction
  summaries, hook-injected system context adjacent to the current user turn),
  which are never excised. Protection is closed to a fixed point over shared
  tool-call ids, so a call and its result can never straddle the compaction
  boundary even when one message carries parts for multiple calls. The summary message itself is already
  in the message list as an ordinary message and supplies the condensed
  content; raw `mastra_messages` rows are never mutated or deleted.
- **Rewind interplay — the load-bearing design decision, settled by directly
  extending Layer 1's existing "rewind self-heals without undo state" rule to
  message-granularity:** `CompactionOverlayProcessor` treats a compaction row as
  active ONLY IF its `compaction_message_id` is still present (not tombstoned)
  in the current, already-tombstone-filtered `args.messages` — exactly how Layer
  1 gates a supersession row on the superseding tool-call id's presence.
  Consequences, with no additional coupling code anywhere in the
  tombstone/rewind machinery itself:
  - **Rewind to a point at or after the summary message:** the summary stays
    live (not tombstoned); the compacted range stays excised. No change in
    behavior.
  - **Rewind to a point before the summary message** (whether the target is the
    raw-message boundary, a message strictly inside the compacted range, or
    earlier still): the tombstone suffix-hide already hides the summary message
    along with everything chronologically after the rewind target, by Mastra's
    existing five rewind-aware read paths. The compaction row's
    `compaction_message_id` is therefore no longer present in the
    tombstone-filtered message list, so `CompactionOverlayProcessor` treats the
    whole compaction as inactive and stops excising — the raw messages in the
    (never-touched) compacted range flow through untouched, exactly as if
    compaction had never run. This is "free" self-healing: no resurrection
    logic, no special-cased branch in `finalizeThreadRewinds`/the anti-join,
    because the raw content was never destroyed in the first place.
  - **Redo (un-rewind) before finalize:** since the summary message is a normal
    tombstoned row like any other, redo un-hides it through the same `rewind_id`
    batch mechanism Layer 1 already relies on — no special case.
  - **Finalize (`finalizeThreadRewinds` hard-deletes on the next user
    message):** if a compaction summary is among the hard-deleted rows, its
    `brainstrike_assistant_compaction_ranges` row becomes orphaned (FK-less, so
    no cascade). `CompactionOverlayProcessor`'s active-row lookup already
    re-derives liveness from message presence every request, so an orphaned row
    is simply inert forever after — matching the "rebuildable transient
    overlay" ruling Layer 2's migration 087 `down` already established for
    prune rows. No cleanup job is required for correctness (it may be added
    later as pure housekeeping, out of scope here).
- **Reload/hydration:** the summary message hydrates through the existing
  80-row windowing path in `assistant-memory-repository.ts` like any other
  assistant row — no special-case hydration logic. Its producer also writes a
  `brainstrike_assistant_message_parents` row with `parent_id = NULL`, so it
  starts a new topology group instead of merging into the preceding assistant
  turn on reload. The renderer recognizes
  `metadata.custom.brainstrikeCompactionSummary` and renders a labeled
  divider/card (not a chat bubble), following the `approval-action-message.ts`
  render-seam precedent, so raw pre-compaction turns remain visible on
  scrollback while the model-facing prompt excludes them.
- **Agentic summary generation:** runs on the thread's current chat provider;
  its cost is metered through the normal provider-usage path
  (provider-reported usage only — no new accounting authority). The
  summarizer's OWN input is built by walking the already-processed prompt (post
  Layer-1/2 rewrite, i.e., PROJECTED tool-result text), never raw
  `mastra_messages` content, so a summarizer call can never re-inflate the very
  budget it exists to shrink. Output follows the fixed section schema Goal /
  State / Decisions / Next / Files touched.
- **Deterministic fallback:** triggers off the PR #2244 local-vs-provider
  classification (`mastra_agent_stream_provider_error` carrying an
  OpenRouter-canonical token-limit / context-length-exceeded signal, or
  equivalent providers' overflow errors) — never off a second LLM call. It
  commits the identical message+overlay shape with `fallbackKind:
  'deterministic'`, marker-based truncation of the oldest eligible turns, and
  an honest one-line index of what was dropped (counts/date-range, not a
  synthesized narrative) so the message body itself states plainly that no
  summarization model ran.
- **Guard/dedup reset:** a committed compaction batch (agentic or
  deterministic) calls
  `resetToolCallLoopGuards(readStateScope(runtimeData))` and
  `resetFileReadState`, identical to Layer 1/2's commit path, since a compaction
  batch collapses evidence a loop guard or read-dedup stub may still be
  pointing at.


