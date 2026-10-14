# Threads-panel awaiting-approval projection — evidence

Supports `docs/agents/assistant-persistence.md` §
"Threads-panel awaiting-approval projection". Read this before proposing to change the anti-join, its ordering guard, the resume-leg re-yield, or the two partial indexes.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

The panel's second — and last — live query,
`packages/app-shell/src/hooks/use-threads-awaiting-approval.ts`, answers "which
threads are parked on a tool approval the user has not answered", under the same
BST-1244 discipline: one resource-scoped subscription for the whole list, no
second activity store, no polling, no per-thread round trip. This is the reason
the durable `tool.approval.requested` row exists at all; rediscovering a pause
from the Mastra suspended-workflow snapshot is per-thread and cannot answer a
list-wide question.

Three rulings the SQL depends on (do not relitigate):

- **Resolution is paired on `metadata->>'toolCallId'`, run-agnostically.** The
  approval-resume leg mints its OWN runId and `thread_runs` row, so the
  `tool.started` / `tool.completed` / `tool.failed` / `tool.resume.unsupported`
  that answers a pause carries a DIFFERENT `run_id` than the pause. `sequence`
  is per-run and meaningless across the two legs, so ordering is never expressed
  as a comparison. A pause row with a NULL `toolCallId` is excluded — nothing
  could ever answer it, and `NULL = NULL` inside the `NOT EXISTS` would pin the
  badge forever.
- **An answer must OCCUR AFTER the pause it answers, and that comparison is the
  whole ordering guard.** Mastra's approval gate runs INSIDE `toolCallStep`,
  i.e. after the model's `tool-call` part has already streamed; that part maps
  to `status: 'start'` (`packages/agent/src/mastra/tool-event-mapper.ts`) and so
  to a `tool.started` run event carrying the SAME `toolCallId`, emitted BEFORE
  the pause row. The observed live order is
  `['tool.started', 'tool.approval.requested']`, pinned against the real
  `@mastra/core` approval loop in
  `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`.
  Pairing `tool.started` on `toolCallId` alone therefore let every pause answer
  ITSELF, and the "needs you" glyph never lit for anyone. The guard is
  `AND answer.occurred_at > requested.occurred_at`. `sequence` could not serve
  (it is per-run, so it is meaningless across the two legs), but `occurred_at`
  is wall-clock from one process and IS comparable across them. A tie fails the
  comparison and so counts as NOT an answer — the safe direction, because it
  keeps an obligation lit rather than silently dropping one. The three terminal
  kinds could not be emitted by the pausing leg anyway, so the guard only ever
  binds on `tool.started`.

  IT USED TO BE `run_id`-SHAPED (`AND NOT (answer.kind = 'tool.started' AND
  answer.run_id = requested.run_id)`), on the reasoning that the runs already
  carry the ordering: a call's pre-pause start shares its pause's run, and only
  a post-approve start is on a different one. **That premise is false whenever
  one step holds TWO gated calls**, and it was corrected in BST-1440's review.
  `foreach(toolCallStep)` is sequential, so Mastra pauses on A alone while B's
  `tool-call` part has ALREADY streamed: leg 1 emits `tool.started` for BOTH,
  and B does not reach its own gate — or its own pause row — until leg 2. B's
  pre-pause start is therefore on a DIFFERENT run than B's pause, the same-run
  exclusion never fired for it, and B's own pre-pause start answered B's pause:
  the glyph went dark while the user was still genuinely being asked about B.
  The producer shape is pinned by "PAUSES ONE CALL AT A TIME" in the approval
  spec above; the projection outcome by "keeps the thread lit when a SECOND
  gated call pauses on the resume leg" in
  `packages/app-shell/src/__tests__/use-threads-awaiting-approval.integration.test.ts`.
  The defect PREDATES BST-1440 — under the older producer it merely surfaced
  later, once `tool.completed` cleared the first pause, which that lane also
  pins.

  THE RE-YIELD IS REAL, and only became so in BST-1440. Mastra never replays a
  resumed step's `tool-call` part (`approveToolCall` delegates to
  `resumeStream`, which re-executes `toolCallStep` with `messages: []`; the one
  `tool-call` replay inside that step is gated on a background-task manager
  Brainstrike does not register — @mastra/core 1.59). `makeResumedStartChunks`
  (`packages/agent/src/mastra/agent-streaming.ts`) therefore SYNTHESISES the
  start chunk for every pending call of the resumed step, and routes it through
  `makeToolLifecycleRunEventChunk` — the same single seam the mainline
  `tool-call` part reaches through `mapGenericToolEvent`, so the `tool.started`
  run event cannot ship on one path and not the other. Before that it shipped
  only on the mainline, this exclusion clause was dead weight, and the glyph
  cleared when the approved tool FINISHED rather than when the user answered —
  masking the truthful Running state for the whole execution. The resume-leg
  emission is pinned against the live approval loop in
  `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`;
  the projection outcome is pinned in
  `packages/app-shell/src/__tests__/use-threads-awaiting-approval.integration.test.ts`.
- **The query does NOT read `thread_runs.status`.** A leg that pauses for
  approval finishes with `finishReason: 'tool-calls'`, which every terminal
  writer records as `status = 'completed'`, while the user's obligation and the
  suspended Mastra snapshot both outlive that row. Filtering on
  `status = 'running'` would make this projection permanently EMPTY. For the
  same reason it needs no web startup-reap gating (unlike the active-run
  projection above): the reap only corrects stale `running` rows, and this query
  reads none. It is gated on `schemaReady` alone — which since BST-1651 means
  the thread repository's schema probe has passed, not that a renderer
  bootstrap has created `brainstrike_assistant_run_events`. Migration 118
  creates that table.

Note that `tool.started` counts as a resolution HERE and deliberately does not
in `assistant-run-event-derivation.ts`: the timeline asks whether the pause row
has reached a terminal state (a still-executing tool has not), while the panel
asks whether the user still has to answer (a tool that started was approved).

Both sides of that anti-join are served by two PARTIAL indexes on
`brainstrike_assistant_run_events` — `…_approval_pause_idx`
`(resource_id, thread_id) WHERE kind = 'tool.approval.requested'` and
`…_approval_answer_at_idx`
`(resource_id, thread_id, (metadata->>'toolCallId'), occurred_at)` over the four
answer kinds (`occurred_at` trails so the postdating comparison above stays on
the index). Every pre-existing index on that table leads with `thread_id` or
`run_id`, so without these the query full-scanned the largest assistant table
twice on every `run_events` notify. They live in **migration 118** and nowhere
else, alongside the `DROP INDEX IF EXISTS` that retires the pre-BST-1440
`run_id`-shaped answer index — `CREATE INDEX IF NOT EXISTS` keys off the NAME,
so an install carrying the old one is upgraded by that DROP and the renamed
CREATE, which is the same upgrade path as 118's `turn_message_id` ADD COLUMN.

Paired coverage: `packages/app-shell/src/__tests__/use-threads-awaiting-approval.test.ts`
(query text) and `…/use-threads-awaiting-approval.integration.test.ts` (real
PGlite: the SELECT's OUTCOME over rows seeded through the production repository
writers, including the cross-run resolution, the per-thread/per-resource
scoping, and the paused-run-row-is-`completed` case that a status-correlated
query would fail — a substring assertion cannot catch that class of error).

