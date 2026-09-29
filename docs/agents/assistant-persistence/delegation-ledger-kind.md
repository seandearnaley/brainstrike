# Delegation ledger kind — evidence

Supports `docs/agents/assistant-persistence.md` §
"DELEGATION LEDGER KIND". Read this before proposing to change the generation scope, the latest-row-wins render plan, or the run-agnostic lookup.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`delegation.ledger` is the user-facing status of a fan-out: "3 of 4
specialists returned · 1 running". The host idle loop
(`background-idle-loop.ts`) and the resume stream (`background-resume.ts`)
publish one row on EVERY background task lifecycle change and before every
parent wakeup, built by `makeBackgroundLedgerChunk` (`background-ledger.ts`)
from the DURABLE task rows (`manager.listTasks` filtered to the GENERATION's
native runs — the runs the host mapped to it, plus the runs this leg observed
itself), never from in-memory sets alone.

AMENDED 2026-09-15 BY OWNER RULING (BST-1749, PR #3198 review item 5): the
ledger is scoped to a GENERATION — the initial send or regeneration that
opened it — not to "the parent run that dispatched the work". One turn spans
SEVERAL native parent runs, because every idle-loop continuation mints a
fresh Mastra run id, so the original wording gave each leg its own
`ledgerId`: the initial leg's row was never superseded (a reloaded thread
kept "2 of 3 · 1 running" for good) and a resume leg counted only the run it
resumed. Migration 140 carries the identity — `generation_run_id` on the run
header, with `brainstrike_assistant_native_runs` mapping each native ROOT run
to the leg that started it — and the desktop host serves both through
`readBackgroundGeneration`. A regeneration of the same prompt is its OWN
generation, which is why the turn anchor (`turn_message_id`, shared by every
generation of a prompt) cannot be this identity.

Shape: a FRESH `id` per row and the same `metadata.ledgerId` (the host run
that opened the generation) plus the counts (`returned`, `failed`,
`cancelled`, `running`, `total`); `label` is the sentence, `detail` lists
"<persona> <state>" per invocation. Content-free by construction: the
delegation prompt and a failure's reason are workspace text and stay in the
model-facing wakeup (the sanitizer would also drop a `prompt` key). `status`
is `'running'` while anything runs and `'completed'` otherwise; a failed
specialist is a count in the label, never `run.failed` (the turn is healthy
and `data-stream-mapper` derives `thread_runs.error` from that kind).

It reaches persistence through the ordinary run-event chunk path
(`processMastraStreamPart` passes a host-published `run-event` through, the
desktop writer upserts by id). Rendering is LATEST-ROW-WINS: the render plan
hides every earlier row of the same `ledgerId` (`isSupersededLedgerRow` and
the indexed `ledgerId` scope in `assistant-run-event-derivation.ts`), in the
same message or a later one, so a live thread shows one row that updates in
place and a reloaded thread shows the final state. The lookup is
RUN-AGNOSTIC (`isRunAgnosticScopeKind`): live parts carry no `runId` but
hydrated parts do, and the resume leg that publishes the final row is a
different host run from the initial leg that published the stale one — a
run-scoped index would keep "2 of 4 · 2 running" visible after reload
(paired: "supersedes across host runs on reload" in
`assistant-run-event-ledger.test.ts`). Why not one row updated in place: the
aui data part carries no `id` (`handleRunEvent`), and the batched derivation
keys statuses by event id, so a repeated id would give every copy the first
copy's plan. The publisher joins in-flight reads before a leg closes
(`createLedgerPublisher.idle`) so the "4 of 4" row is never lost to a fast
close. Classified SELF_SUPERSEDING in
`assistant-run-event-pairing-contract.test.ts` (no terminal list); in
`isAlwaysVisibleRunEvent` (LOAD-BEARING — hidden at default detail it would
report the status to nobody). A settled message whose newest ledger row is
still `running` (a parked root that closed with a child parked) reads
`interrupted` until the next leg's row supersedes it; the pending card on
the thread says why.

