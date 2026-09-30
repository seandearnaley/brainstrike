# Durable native background outcomes — evidence

Supports `docs/agents/assistant-persistence.md` §
"Durable native background outcomes". Read this before proposing to change background task reconciliation, the delivery acknowledgement transaction, or outcome repair.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Migration 133 registers `mastra_background_tasks` with the native PGlite adapter;
the table participates in database clear and factory reset. Task scope is the
root resource/thread, not a renderer tab. Updates use expected-status comparison
so competing lifecycle transitions cannot overwrite each other.

Completed, failed, timed-out and cancelled outcomes are reconciled at the PGlite message
commit boundary before inference. Cancellation clears the dispatch acknowledgement
and projects an explicit cancellation error into the parent invocation and model
input; the native task remains `cancelled`, and running siblings are unchanged.
Recovery and late-result overlays include cancelled tasks. The native task row carries `delivered_at`,
separate from native status. Every ordinary save that names a retained task
overlays its authoritative terminal outcome even after delivery, so a later
stale native snapshot cannot restore the dispatch acknowledgement. The message
write and delivery acknowledgement share one transaction; either both commit
or neither does. Child completion and repair use the memory store's task-only
operation, which locks the terminal task and reads current parent rows in that
transaction instead of writing a recalled whole-message snapshot. Thus a
callback cannot erase newer parent text or metadata. Progressive Mastra
snapshots may repeat one tool call under fresh message ids; every matching row
is updated while preserving each row's ordinary content. Duplicate matching
invocation parts inside one row, a mismatched call/task pair, a foreign owner,
or a missing retained task fails before acknowledgement.
Delegated `subagent.*` history events carrying their originating turn attach only to
that turn's exact tool call. An absent retained call does not redirect the event to
another turn by run or reused call ID; ambiguous ownership fails visibly. Ordinary
event kinds retain their existing assignment path. Native outcome repair below is
the explicit recovery path for removed invocation messages.
If retention removed every invocation, the task's durable input and outcome create
a deterministic recovery message that visibly explains the missing original and
that no work was rerun. Missing failure details and timeouts get explicit error
text, including uncertainty about external effects. Result/error, compact
provider projection, cleared pending-decision metadata and delivery
acknowledgement are saved together. The raw result remains UI/history evidence
while `providerMetadata.mastra.modelOutput` contains only the child's text
summary; the paused-run overlay uses the same projection. This mirrors Mastra's
documented [subagent result context](https://mastra.ai/docs/subagents#subagent-result-context):
the parent receives text while the full result remains available to the UI.
Installed Mastra 1.64 public APIs and source remain the compatibility authority.
Recovery snapshots
every undelivered page before acknowledging, so acknowledgements cannot shift
pagination and skip a task. `background-outcome-recovery.integration.spec.ts`
and `pglite-background-result-reconciliation.integration.spec.ts` cover lost
messages, all four terminal outcomes, progressive rows, stale callback/native
saves, rollback, repeat repair and delivery acknowledgement reload. Native resuspension joins the workflow snapshot before exposing a
new resumable decision. Native reconstructed-runtime recovery is tested separately
from the actual desktop process-restart pending-approval case; it is not evidence
of completed-undelivered recovery through every host restart boundary.

Delegated background notices can create multiple topology-bearing assistant rows
within one user turn. History run-event reads retain the originating user message
from the owning run. Delegation events bind to their exact tool call within that
turn, before chronological assignment; they cannot attach to a reused call ID in
another turn. The normal shared workspace resolver then opens the persisted child
from that native invocation. The owning-turn hydration regression and the real
Electron stopped-child close/reload/reopen case cover both producer and consumer.

Delegated event assignment may use a retained assistant row's explicit durable
`parentId` equal to the originating user message even when that user row is outside
the hydration window. This is exact topology evidence, not a call-id-only or
nearest-turn heuristic; reused call IDs under another user cannot claim the event.

Native Mastra signal messages with `content.metadata.signal.type === 'user'` are
human history turns. Render their format-2 `parts`, split assistant groups at the
human input, and retain normal branch topology. Notification/state signals must
not be reclassified as human messages.

## Native observation suffix ownership (2026-09-30, BST-1894)

The captured root failure followed two completed native children and an approved
root write. The stored parent retained each exact invocation once, while native
observation sealing had marked its metadata and last part. Private debug-pack
contents remain local; the regression uses synthetic tasks and ordinary text.

Installed Mastra core 1.71.0's public `MessageList` rotates a sealed assistant
message to a fresh suffix id when response parts extend it. The suffix contains
only new parts but inherits message metadata, including adapter-owned
`backgroundTasks`. The PGlite adapter previously treated those inherited joins
as local invocation ownership and threw the captured missing/ambiguous error.
This is an adapter adaptation to native sealing, not a vendor defect.

At the commit boundary, inherited references require the exact retained task and
call in the same conversation, a distinct canonical row with exactly one call,
and a seal at or after that call. Stored and incoming batch rows participate;
an incoming row overrides the stored row of the same id. Valid unsealed
progressive copies remain supported. Only inherited task references are removed;
ordinary suffix parts and other metadata remain intact. Suffix-only saves cannot
acknowledge delivery, and outcome projection plus delivery remains transactional.

`pglite-background-result-reconciliation.integration.spec.ts` reproduces the
exact error using the public native split. It covers suffix-only saves, first
atomic parent/suffix batches, progressive copies, absent/foreign/unsealed owners,
duplicate calls, and reload. Its existing controls retain stale-save repair,
canonical outcomes, cancellation, and rollback. The enabled native
approval case runs observation at a ten-token threshold, completes two concurrent
children, reconstructs the root for approval, and proves both canonical outcomes,
the sealed assistant owner, one root write, and final output. The scripted root
emits each call once even when observation removes raw tool results; selecting
redispatch by raw tool-result absence was a fixture artifact that native usage
ownership correctly rejected. Observer output uses the native XML sections and
derives its summary from observed synthetic input.

The paired reconciliation, approval and outcome-recovery command passed 24 tests.
A control run of the enabled native approval case against the original storage
boundary also passed: that fixture qualifies native lifecycle compatibility but
does not independently reproduce the captured inherited-reference failure. The
causal RED/GREEN remains the public `MessageList` split at the actual PGlite save
boundary. No desktop or GLM-provider acceptance is claimed here.


The initial PR review hardened owner enumeration with an explicit JSON object
CASE: unrelated null, array and scalar task metadata does not poison a valid
suffix, while a missing or malformed actual owner still fails closed. Owner
proof requires assistant roles for both owner and suffix. Real PGlite regressions
cover both rules. The observer numbers its responses so every stored summary
compares to the exact recorded request that produced it, including accumulated
observation cycles. This allows observation before child completion without
claiming a completed summary. Caller input is already isolated: `saveMessages`
clones within the transaction before reconciliation; `updateMessages` builds
merged rows and delegates to that same clone boundary before rereading storage.
