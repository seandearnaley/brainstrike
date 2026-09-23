# Background delivery, retries, wakeups and the ledger — evidence

Supports `docs/agents/assistant-subagents.md` § "Background worker execution and pending controls".

One delivery per background call, host-owned retries, the no-wake-on-suspension ruling, the wakeup ledger and rejected-admission accounting.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 1897–2170 at commit 7c3eb8f38.

---

Desktop run-scoped memory supplies `backgroundTaskScope` through assistant-service
to the native agent runtime. Persona delegation defaults to nonblocking native
background execution when that capability exists; the native `_background`
argument retains foreground selection. Recursive descendants retain their native
foreground execution inside the background child and use the same durable limits.
A parent can emit useful text while a child works or waits for a decision. Live
child content and exact approval controls use the existing rich conversation view.
`projectBackgroundStream` (`background-stream.ts`) folds the native task events
into the host stream: a `background-task-output` carries either a child envelope
(`tool-output`, `data-user-message`, the delegated usage part) or a RAW `data-*`
chunk — Mastra's `ToolStream.custom()` writes data parts without the envelope in
the foreground too — and both are forwarded unchanged; only a non-data,
non-envelope chunk is a contract break. SETTLED 2026-09-13: a background
Explorer child's `data-om-buffering-start` hit the old allowlist, failed the root
run and cancelled all four children. Paired test: `background-stream.spec.ts`.
A forwarded `data-*` part keeps the CHILD's `runId`; consumers must attribute it
by that id, never by its position in the host stream (the projection no longer
tells child-origin data parts from the parent's). The delegated usage part is
itself `data-*` and was always allowlisted, so its accounting is unchanged.
SETTLED 2026-09-15, ONE DELIVERY PER BACKGROUND CALL (do not relitigate):
while the turn that dispatched a background call is still open, Mastra's
background executor delivered every child output and pause TWICE. Its
`outputWriter` published the chunk as the task's output (`task.output` →
`background-task-output`) and then wrote it through the dispatching step's own
writer (a raw `tool-output` envelope on that turn); its `suspend` calls the
step's `suspend` (a parent-level `tool-call-approval` / `tool-call-suspended`
for the delegation call, on that turn) before parking the task (`@mastra/core`
1.64, the background branch of the tool-call step in `agent-DsRUDsS_.js`;
unchanged in 1.67.0, whose own `streamUntilIdle` merges both channels too).
Live GLM run 19 (2026-09-15, a slow root first turn with parallel reads)
projected both: every child view carried each frame twice, and the root thread
showed eight cards for four decisions — four synthesized when the tasks parked,
four native copies published when the leg ended at the root's canvas pause
(`withRootPauseNotices` dedupes only within one publish). The TASK is the
delivery: its copy exists for the call's whole life, the turn's only until that
turn closes, and every leg with a background manager is idle-loop wrapped
(`driveBackgroundWork`, the resume stream), so the task channel is always read.
OUTPUTS are single at the source: a child's raw `data-*` part
(observational-memory markers, the delegated usage part, the synthesis
breadcrumb) reaches the executor through the subagent tool's `writer.custom()`
with no call identity, so no host filter can tell its turn copy from the root's
own data parts, and that turn copy also ran the ROOT's data-part pipeline,
which stored a non-transient child part in the root's own message.
`patches/@mastra__core@1.64.0.patch` therefore makes the executor's
`outputWriter` publish to the task only, and `projectBackgroundStream` throws on
a background call's `tool-output` on its dispatching turn (the patch no longer
applies). The task output is now the only copy, so the background manager's
`progressThrottleMs` must stay unset: a throttled chunk would be lost. PAUSES:
`projectBackgroundStream` drops a turn's `tool-call-approval` /
`tool-call-suspended` for a call known as background (`background-task-started`
/ `-running`), logging `background_turn_copy_dropped` once per call. It throws
if a turn copy was forwarded BEFORE the turn acknowledged that call's dispatch
(Mastra enqueues the acknowledgement first; a violation would silently project
the task's copy again). A resume leg's host executor (`registerResumedExecutor`)
writes only to its own stream and publishes no task output, so resumed children
are untouched. Paired: `mastra-background-contract.integration.spec.ts`
("delivers a background child's raw data part once while the dispatching parent
turn is still open"; RED unpatched: the part arrived as task AND turn, and one
copy was stored in the parent thread), `background-stream.spec.ts` ("one
delivery per background call": removing the output contract break, exempting
pauses from the drop, or dropping the order guard each fails only its own rows)
and `background-worker-policy.integration.spec.ts` ("reaches each view ONCE
while the dispatching root turn is still open", fixture `slowRootTurn`; RED
before the drop: four root cards for two decisions and every child frame twice).
A root that answers instantly closes its turn before any child output exists,
which is why the fixture never delivered this shape.
The model may also request `_background.maxRetries` (Mastra's own system prompt
advertises it, its resolver honours the model's value ahead of the host default,
and no host knob removes the advertisement). SETTLED 2026-09-14 (BST-1749): the
HOST owns the retry policy — none, ever — so `PgliteBackgroundTasksStore.createTask()`
pins a scoped task's model-requested retries to 0 and logs
`background_task_retries_pinned`; the delegation dispatches. This is host
authority over an execution knob, not a fallback: rejecting the value failed all
four specialists of the "spin up 4 subagents" prompt on every turn the model
followed Mastra's guidance, and the model then reissued them as FOREGROUND
delegations (thread-af25a110, 2026-09-14). `updateTask` still rejects a non-zero
retry count — no host path may re-arm retries on an existing task. The root's
delegation instruction also states that subagents run as background workers and
that `_background` is host-owned (`buildDelegationInstruction`,
`backgroundDelegation`). Pinned by `pglite-background-store.integration.spec.ts`
(create pins, update rejects) and `background-worker-stream.integration.spec.ts`
("dispatches a delegation whose _background carries the retries knob").
A background child's SUSPENSION closes the parent stream for that iteration with
no finish part. SETTLED 2026-09-14: the leg that observes it ends as a PAUSE.
The initial leg's root output reports `suspended`; the resume leg
(`createBackgroundResumeStream`) exposes the same synchronous `status` and
reports `suspended` when the resumed task parks on a NEW decision, so
`readNativeStreamStatus` ends the leg with a `tool-calls` finish and the withheld
child notice publishes. Reading that close as a missing finish produced
"Assistant stream ended without a normal stop signal" on every second approval
of a background child (thread-8d471973). Paired:
`background-worker-policy.integration.spec.ts` ("pauses again on its resumed
leg").
SETTLED 2026-09-14 (do not relitigate): the parent model is NEVER woken by a
child's suspension. Mastra's own `untilIdle` loop counts
`background-task-suspended` as a terminal and runs a parent continuation whose
ephemeral directive reads "Do not attempt to resume them; let the user know they
are waiting for explicit resume input" — the root parroted that line for every
suspended specialist and refused to compile its report (thread-1dab3290), and no
system-prompt wording beats a later user-role directive. The host therefore does
not pass `untilIdle`; every parent inference (initial, approval, resume, native
wake and the child-resume continuation) passes `_skipBgTaskWait` and is wrapped
by `withBackgroundIdleLoop` (`background-idle-loop.ts`), which mirrors Mastra's
loop except that only a returned, failed or cancelled task queues a wakeup
(`describeBackgroundWakeup` in `background-ledger.ts` is the host's directive
— see WAKEUP LEDGER below). A suspension is a
host-surfaced approval prompt, exactly as Claude Code surfaces a subagent's
permission prompt in the main session; the model is not the messenger. Silence
from running work past `backgroundIdleMs` (default: the longest a task may run)
closes the stream unfinished and the projection reports it. Paired:
`background-worker-policy.integration.spec.ts` ("wakes no parent turn"; mutating
the wakeup guard to include suspensions fails it) and the idle-expiry case in
`background-worker-stream.integration.spec.ts`.
SETTLED 2026-09-15, WAKEUP LEDGER (do not relitigate): a parent wakeup is
the whole LEDGER of this turn's background invocations, not one line per
event. The GLM root (thread-debug pack 2026-09-15T03-31-15Z) received
"Background invocation X has returned" four times over four continuations,
mis-counted, and ended "waiting on the remaining subagents" after all four
had finished. The ledger is read from the DURABLE task rows
(`manager.listTasks` in the thread scope, filtered to the GENERATION's native
runs — `background-ledger.ts`, `createBackgroundLedgerSource`; AMENDED
2026-09-15 by owner ruling, BST-1749/PR #3198 review item 5, from "the parent
run ids the leg observed on its lifecycle events", which gave every leg of one
turn its own ledger identity and made a resume leg count only the run it
resumed. The scope is now the runs the host mapped to this generation
(migration 140, `readBackgroundGeneration`) UNION the runs the leg observed
itself, which covers a run whose first task has only just been dispatched),
never from the loop's `running`/`settled`
sets alone, and lists every invocation as returned (persona, the first 120
chars of its prompt, "use its saved outcome"), failed (with the recorded
reason; a timeout reads "timed out"), cancelled, or still running. When
nothing is still running it says so in one sentence — "All N background
invocations have finished. Nothing is still running. Continue with the task
using the saved outcomes." — and only then. A SUSPENDED task is "still
running" to the ledger: the pause is the host's card, the model is never
its messenger (the 2026-09-14 ruling above stands). The idle loop
(`runContinuation`), the resume stream's parent wakeup and the parked-root
deferral all read the same source. The same ledger reaches the USER as the
`delegation.ledger` run event (assistant-persistence.md, DELEGATION LEDGER
KIND): one live row in the root thread — "3 of 4 specialists returned · 1
running" — published on every task lifecycle change, joined before the leg
closes so the final row is never lost (`settle` waits on
`publisher.inFlight`; the parked-parent close is where that join is
load-bearing, since no continuation keeps the leg open), persisted like
every run event. Because the wakeup QUOTES each child's prompt, a scripted
harness must tell the root's wakeup apart by its header ("Background
invocations of this turn") before it uses prompt text to pick a child.
ACTIVE PARENT STEPS (BST-1771, 2026-09-17): the idle loop queues terminal
wakeups while a parent turn is streaming. A UI ledger reaching zero running
therefore did not mean that an active parent model saw that update. Root stream
options now refresh the same generation-scoped ledger and compact saved terminal
outcomes before each input step, including inside a continuation. One owned
native `context` message is replaced before the input token limiter; it remains
user-role tool data, is not drained into durable user/response history, and does
not start another inference. Child-runtime legs do not install this processor.
Suspended tasks remain running and refused delegations remain excluded. The
generation port was already mandatory for background wakeups; missing bindings
now fail before inference. Durable read failures propagate rather than letting
the root publish from a known-stale completion ledger (no silent degradation).
A provider-boundary observer records only terminal notices retained verbatim
after input processing. The idle loop drops their queued wakeups only after the
active native turn succeeds, avoiding a second report-producing inference.
Failed, aborted, unknown-status or parked turns retain pending delivery; an
altered/trimmed notice is conservatively unacknowledged. Transcript
reconciliation is unchanged.
Paired: `active-parent-background-results.integration.spec.ts`
holds the original parent or a later native continuation open, completes the
last child, and checks the next model request and absence of a persisted context
message; `active-background-results-processor.spec.ts` pins replacement, scope,
terminal states, suspension, authority and read failure. The idle-loop test
`keeps a presented outcome queued when the parent request fails` pins the
acknowledgement/response-failure boundary.
An approval for work parked before migration 140 can lack the durable native
run mapping required to name this generation. Approval preparation validates
that mapping before recording any policy-granted sibling answers or starting a
native resume. The typed refusal releases a delegated user's claim, leaves all
parked work unchanged, and tells the user to Stop or cancel the pending work,
then start a new request through both live-decision and cold approval transports.
A root-own pause validates before recording late-result wakeups or invoking its
native resume. A new user request safely mints its own generation; the host
never guesses an old generation or automatically replays unknown effects.
Paired: `background-ledger.spec.ts` (mutations: the closing sentence while
something runs; omitting it when nothing runs), `background-idle-loop.spec.ts`
("carrying the durable ledger", "publishes a delegation.ledger row …",
"a parked parent leg publishes the final ledger row before it closes" —
mutation: dropping the join from `settle`), and the harness row "the wakeup
carries the whole ledger: a root that trusts it reports the final outcome
exactly once nothing is still running" (`fanout.rootReadsLedger`; the
scripted root answers from the LAST user message, never its own count).
SETTLED 2026-09-15, REJECTED ADMISSION IS NO INVOCATION (do not relitigate): a
delegation refused at start (BST-1751: unknown persona, a per-leg backstop, or
the host's durable budget) is never returned background work. Mastra 1.64 runs
`onDelegationStart` INSIDE the background task it has already created
(`createBackgroundTask` → `enqueue` → `storage.createTask`, then the task's
executor calls the tool), so a refusal still writes a task row that completes
normally with `[Delegation Rejected] …` as its result. The idle loop used to
queue that terminal as a parent wakeup and the ledger counted the row
`returned`: `delegated-worker-write.desktop.test.ts`, its scripted parent broken
to delegate on every turn, reached "1160 total: 1160 returned" and 2337 parent
model calls in ~90 s. Nothing in the host bounded it — a refused task completes
at once, so idle expiry never applies. Now the leg's `DelegationOutcomeCapture`
(the authority the mapper already reads for `outcome = 'rejected'`) reaches
`withBackgroundIdleLoop` and `createBackgroundLedgerSource` as
`rejectedDelegations`; `driveBackgroundWork` and `createBackgroundResumeStream`
pass their leg's capture, and the key is required on both the ledger source and
the loop so neither can forget it. The refused terminal wakes nothing, and the
row is no ledger entry (no child ran; admission reserved nothing). The model
still reads the refusal as that call's saved result and the user still sees the
`Rejected` card, so a refusal that lands while nothing else runs closes the leg
without a parent turn. The loop's bound is explicit: once more distinct
background tasks wake the parent in one leg than one original root turn may
admit invocations (`DELEGATION_LIMITS.maxInvocations`, the host's tree limit
for that turn, resumes and descendants included), the leg FAILS with
"Background work woke the parent for N invocations; one turn admits at most
<maxInvocations>, so the leg stops instead of waking the parent again" and logs
`background_parent_wakeup_limit_exceeded` (the tripping invocation and every
woken task id) — never a silent close. The bound counts background tasks, which
equal delegations only because persona delegations are the sole
background-eligible tools: `buildBackgroundAgentOptions` (`agent-runtime.ts`)
lists persona ids alone and no tool sets its own `backgroundConfig`. A new
background-capable tool must revisit this bound. A task wakes a leg at most
once, so the bound trips only when more work woke the parent than the turn's
admission allows. The capture is leg-scoped and in memory (Mastra writes no
durable rejection marker on the row), so the LEDGER also asks the host's
invocation graph — the durable record. A refusal persists no invocation (start
admission reserves nothing and `persist` never runs), so a `completed` row whose
dispatch address `resolveParkedInvocation` answers `undefined` for ("that
address delegated nothing") was refused, whichever leg dispatched it. That
closes the case the capture cannot see: a resume leg reads the rows of the run
it resumes, and a refusal dispatched in the same parent step as a parked sibling
used to read `returned` there — two admitted siblings and one refusal gave "3
total: 2 returned, 0 failed, 0 cancelled, 1 still running" once one sibling
resumed, so the resumed parent was told a specialist returned when none ran.
`createBackgroundLedgerSource` takes `resolveInvocation` as a required key
beside `rejectedDelegations`; `driveBackgroundWork` and `createResumeLedger` pass
the binding's member. Only a `completed` row asks: a child still starting has
not persisted its invocation yet, and a refusal always completes. That ordering
is guaranteed, not assumed — the child's `inputProcessor` AWAITS `persist`
before the child streams a part, and Mastra writes a task's `completed` status
together with its executor result — so a completed row's answer is settled and
the leg remembers it, with overlapping reads (the loop publishes a row per
lifecycle event) sharing one pending answer. A host that CANNOT answer fails
the read: no row is published (`background_ledger_read_failed`) and the wakeup
fails loudly, because answering "not refused" would count a refusal as returned
— the defect the graph exists to answer. That failure is not remembered, so the
next read asks again. The same persona-only
eligibility makes every row a delegation the graph can answer for; a new
background-capable tool must revisit this too. Without a host the key is
undefined and the capture answers alone: no other leg can read those rows,
because every delegated decision needs `resolveToolAction`. Reading `undefined`
as "refused" makes DURABILITY part of the binding contract, stated on
`resolveParkedInvocation`: an invocation, once persisted, must stay resolvable
from its dispatch address for the life of the parent thread. No code prunes
`brainstrike_delegated_invocations` today; a host that added pruning would not
answer late — the ledger would quietly stop counting a child that ran, the
mirror of the defect above and a silent one. Never sniff the
`[Delegation Rejected]` result text — a child can echo it. Paired:
`background-rejected-delegation.integration.spec.ts` (nine task rows, eight
wakeups, 18 root prompts, "8 of 8 specialists returned"; RED: 20 rows and 20
wakeups until the script stopped; and "a resume leg leaves a sibling refused in
the same parent run out of its ledger": "2 total: 1 returned, 0 failed, 0
cancelled, 1 still running" and "1 of 2 specialists returned · 1 running"),
`background-idle-loop.spec.ts` ("a delegation rejected at start wakes no parent
turn and is no ledger entry", "fails the leg loudly once more invocations wake
the parent than one turn may admit"), `background-ledger.spec.ts` ("leaves out a
delegation rejected at start", "leaves out a completed delegation the host holds
no invocation for, whichever leg dispatched it" — mutations: ignoring the host's
answer; asking about a row that has not completed — plus "asks the host once per
completed row", "asks once even when two reads overlap", "fails the read when the
host cannot answer, and asks again on the next read" and "reads the leg capture
before the host"), and the desktop host's "resolves a parked invocation from its
dispatch address without a leaf identity" (an address that delegated nothing
answers `undefined`). A scripted harness root that must delegate on every turn
uses `fanout.rootRedelegates`.

2026-09-22: `_background.timeoutMs` is pinned the same way. Mastra ranks the
model's value above host config, so `createTask()` overrides it with the host's
`resolveChildTaskTimeoutMs` (the user's runtime limit, default Off) and logs
`background_task_timeout_pinned`; `updateTask` rejects a different value. See
`mastra-boundary/subagent-host-lifetime.md` for why the five-minute ceiling went.

## 2026-09-22 — the idle loop is not a liveness authority

Supports the loop sentence in "The parent model is NEVER woken by a child's
suspension" (`assistant-subagents.md`); the suspension ruling above is
unchanged. AMENDS the 2026-09-14 record's "Silence from running work past
`backgroundIdleMs` … closes the stream unfinished".

**What the timer did.** `withBackgroundIdleLoop` armed its own silence timer
(`maxIdleMs`, defaulting to 300 s borrowed from the Mastra task-deadline
constant — an unrelated number; BST-1799 had renamed it `DEFAULT_BACKGROUND_IDLE_MS`) only while the parent was purely
waiting on running children, and re-armed it on every piped chunk and manager
event. On expiry it logged `background_idle_expired` and CLOSED the combined
stream without cancelling anything. `projectBackgroundStream` then threw the
plain `Error('Background stream ended with unfinished child work.')`, which is
not a watchdog error, so `runTurnAttempts` rethrew it without a `run.stalled`
row, and the turn's teardown — the attempt's stream-context disposal runs
`stopBackgroundTree`, then `runtime.dispose()` shuts Mastra down — cancelled
the child that had merely been quiet.

**Why it was removed, not re-tuned.** The stream watchdog wraps the very same
combined stream and re-arms on a superset of the same events, so the timer
could only ever fire when its window was the SHORTER one. Once each background
task has its own watchdog lane (`assistant-runtime/stream-watchdog-phases.md`),
a child's first-output, reasoning and tool-executing windows (600 s / 600 s /
~635 s by default) are all longer than 300 s: the timer would have killed
exactly the silences the lanes legitimise, with a different, untyped outcome.
One authority remains; its expiry is a `StreamStalledError` with its
`run.stalled` breadcrumb. With no timer, `backgroundIdleMs` / `maxIdleMs` went
too; the projection's "unfinished child work" throw stays as a contract-break
backstop, reachable only if the loop closes on its own bookkeeping with a task
still running (the repeated-suspension class).

Paired: `background-idle-loop.spec.ts` ("running work that stays silent keeps
the leg open; only its terminal settles it" — RED on the timer: the leg closed
during four fake hours of silence) and `background-worker-stream.integration.spec.ts`
("keeps a leg open while a quiet background child works, then finishes
normally", with a 200 ms inter-output window and 1 s of child silence; without
the task lanes it stalls in `streaming` and the child ends `cancelled`).

## 2026-09-22 — each child's own watchdog judges its liveness (BST-1802)

AMENDS the entry above: the loop still judges no silence, but the watchdog's
per-task lanes it deferred to are gone. Each background child has its own
watchdog, which ends a stalled child as a failed task; that task's terminal
wakes the parent like any failure, and the ledger quotes the stall
("failed — Subagent stalled: no output for …"). The parent's stream watchdog
judges only the parent (`assistant-runtime/stream-watchdog-phases.md`).
