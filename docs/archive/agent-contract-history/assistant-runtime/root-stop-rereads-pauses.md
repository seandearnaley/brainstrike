# A root Stop re-reads undecided pauses — evidence

Supports `docs/agents/assistant-runtime.md` § "Background failure and stopped-pause ownership".
Read before changing the stop-generation remount gate, the host cancel scope, or the composer draft carry. BST-1749 review, 2026-09-15; PR #3214.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4811-4886), extracted verbatim.

A ROOT STOP RE-READS UNDECIDED PAUSES (BST-1749 review finding, 2026-09-15).
The root composer's Stop posts `/assistant/cancel`, which cancels the turn's
paused work before it answers. A pause notice already published into that turn
(a background child's root card while the dispatching turn is still open) stays
in the cancelled message, and its durable decision state reaches the renderer
only through rediscovery on history load: the card read "Pending" with live
buttons and the composer strip kept counting it until the thread was reloaded.
The data-stream adapter hands `onCancel` the messages it cancelled; after a
SUCCESSFUL cancel the run session (`use-assistant-server-run-session.ts`) calls
the panel's `onPausesCancelled` when those messages held a pause notice with no
durable `decisionState` (`undecided-pause-notices.ts`). The panel bumps its
stop generation in the data-stream runtime key beside `historyGeneration`, so
hydration re-runs discovery: the pause returns with `decisionState:
'cancelled'` (a non-actionable "Turn cancelled" row) or, once its snapshot is
deleted, not at all. Liveness is never derived from message status: a failed
leg keeps its pauses actionable. The remount is GATED NARROWLY, because it
throws the live runtime away where the child Stop reloads history in place:
`undecided-pause-notices.ts` looks only at the STOPPED TURN (from
`resolveTurnAnchorMessageId`, so a pause parked by an earlier turn that this
cancel never touched is ignored) and only counts a pause NOTHING has answered —
a durable `decisionState`, the host's streamed `tool-approval-answered`, or the
user's own appended decision all settle it. That renderer scope and the HOST
CANCEL SCOPE MUST MOVE TOGETHER: the gate may stop at the turn only because
`cancelDesktopAssistantRun` does too (`cancel-run.ts`: the owned-runs CTE takes
the run plus every run sharing its `turn_message_id`, `cancelWaitingTurnTasks`
filters `invocation.turn_message_id`, and the continuations are derived from
those run ids), so widening the host cancel past the turn without widening
this gate would leave an earlier turn's cancelled card reading "Pending" with
live buttons until the thread is reloaded. In-session answers carry no durable
state, so counting them remounted the thread on the ordinary "approve a tool,
keep going, Stop" path (PR #3214 review). The host writes that durable state
BEFORE it answers: `cancelDesktopAssistantRun` marks the turn's runs
`cancelling` before awaiting owners, and `delegated-waiting-cancel.integration.test.ts`
reads `readDelegatedDecisionStates` as `cancelled` only after the endpoint
returned 200. The live composer DRAFT SURVIVES the remount (owner ruling
2026-09-15): the panel calls `onStopReread` immediately AFTER the bump in the
same React batch, so the command reaches the replacement rather than the
composer being discarded, and app-shell re-enqueues that thread's recorded
draft as a `replace` composer command (`use-stop-reread-draft-carry.ts` →
`assistant-composer-command-store.ts`), which the remounted
`ComposerDraftCommandBridge` applies once and the wrapper acknowledges. Only
the TEXT draft travels; attachments and other per-mount composer state are
still discarded. The same thread-scoped text now survives renderer reload in
`assistant-composer-drafts.v1` sessionStorage. Zustand hydrates only the draft
map and creates one replacement command per nonempty draft; queued commands
and attachments are never persisted. Sending/clearing records an empty draft,
so it is not restored. Factory reset clears sessionStorage and invokes the
existing composer-store reset. `assistant-composer-command-store.test.ts`
proves thread isolation, no command replay, cleared drafts, and reset. Thread-scoped by construction — the command carries its
`threadId`, each wrapper passes only its own thread's command, the id is
captured at Stop time, and a stale callback whose panel has since switched
threads neither bumps nor notifies (reopening that thread hydrates from the
ledger anyway). NOT the global rewind slot (`rewind-composer-store.ts`): it is
one unkeyed slot that every open thread's bridge drains, so a draft handed to
it could surface in another thread's composer (Conversation Rewind's own
exposure there is untouched). The panel keeps no draft state: a host wiring no
`onStopReread` keeps the old behaviour. A failed cancel is logged and changes
nothing (the pause was not cancelled); a failed rediscovery during the re-read
renders the existing discovery error notice. Paired:
`undecided-pause-notices.test.ts` (the gate: stopped turn only, every answer
shape), `root-stop-rediscovers-approvals.behavior.test.tsx` (real panel,
adapter, run session, index, strip and notice; the cancelled pause leaving the
strip, an answered approval keeping the mounted thread, and the draft typed
before the Stop coming back in the composer that replaces it) and
`assistant-ui-panel-wrapper-stop-reread.test.tsx` ("carries the live composer
draft into the thread that re-reads after a Stop", over the real command
store, beside `use-stop-reread-draft-carry.test.ts`). The two
halves are pinned separately — the panel against a fake host, the store against
a mocked panel — because the app-shell harness mocks `@brainstrike/assistant-ui`
wholesale and assistant-ui cannot import app-shell; mutations cover the seam
(dropping the enqueue, enqueueing under another thread id, or dropping the
panel's host call each go red). `data-stream-runtime.test.ts` ("invokes
onCancel for normal aborts…") pins the cancelled messages.
Storage read/write failures are logged and shown as a destructive toast; failed
writes do not throw through the composer effect or claim reload recovery succeeded.
Session storage is session-scoped, not a guarantee that text stays only in memory.
