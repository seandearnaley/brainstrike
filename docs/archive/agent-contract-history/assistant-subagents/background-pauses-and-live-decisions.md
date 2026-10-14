# Root cards, live decisions, session grants and resumed executors — evidence

Supports `docs/agents/assistant-subagents.md` § "Background worker execution and pending controls".

The multi-approval matrix, live decision delivery, SESSION GRANT STOPS ASKING, repeated suspensions, parked parents, late results and resumed executor registration.

CORRECTION (2026-09-21): the `e2e-subagents.mjs` live-app verifier named at the end of the session-grant ruling does not exist anywhere in the repository today (tracked or untracked), so its `cardsAfterGrant` verdict is not a runnable check. The unit, integration and desktop pins listed alongside it all exist.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 2171–2562 at commit 7c3eb8f38.

---

SETTLED 2026-09-14 (do not relitigate): EVERY parked leaf decision has a card in
the ROOT thread. A foreground child's pause suspends the parent run on the
delegation call, so Mastra's parent-level pause becomes that card once
`decorate()` addresses it to the leaf. A BACKGROUND child's pause parks a task
and suspends nothing in the parent run (the parent-level copy Mastra writes on a
still-open dispatching turn is dropped, ONE DELIVERY PER BACKGROUND CALL above),
so the root stream carries only the child envelope and the root thread showed NO
card while four specialists sat parked (thread-b629776b):
`withRootPauseNotices` (`root-pause-notices.ts`) runs at
every publish of the withheld notices and synthesizes, for each child-scoped
notice whose leaf identity has no root-level notice, a root card addressed to
the ROOT edge (`path[0]`, the transport target every resume already uses) with
the leaf tool, args and risk metadata, preceded by the durable
`tool.approval.requested` row for the delegation call; a foreground pause
already carries the root notice and gets no duplicate. Paired:
`root-pause-notices.spec.ts` and the root-notice assertions in
`background-worker-policy.integration.spec.ts` (RED before the seam: zero root
notices for a background child; "reaches each view ONCE" pins exactly one root
card per decision while the dispatching turn is still open). The card names the child (persona label + the
delegation prompt), and a
session grant answers every parked BACKGROUND sibling in the same approval leg
(`claimGrantedBackgroundResumes` → `createBackgroundResumeStream` with N
resumes and ONE parent wakeup; `tool-approval-answered` locks the sibling
cards; siblings are recorded as policy answers, never as a second ledger claim).
Full contract in `assistant-runtime.md` (PERMISSION ENGINE, "PARKED
SIBLINGS"). MULTI-APPROVAL MATRIX (2026-09-14), every row proven through the
REAL desktop host, ledger and background store in
`apps/desktop/.../delegated-sibling-grant.integration.test.ts` unless noted:
- N children parked → N root cards, no tool ran before a decision.
- "Allow reads this session" on one card → every sibling parked on a read tool
  answered by policy in the same leg (`consumed`, no second claim), one parent
  wakeup, `Parent: ALL-FLAGS`.
- One-shot Approve → only that card; the next one-shot completes the turn.
- Decline one, grant on the other → the declined tool never runs; the grant
  finds nothing else parked.
- "Always allow <tool>" → siblings parked on THAT tool answered; a sibling
  parked on a different ask tool stays parked until its own decision.
- Reload → rediscovered root cards carry the same identity; a grant from a
  rediscovered card answers the sibling.
- WORKER writes (`mode: 'worker'`, `edit: ask`): both children park on the
  edit with `riskCategory: 'edit'` root cards; "Allow edits this session" on
  one answers the sibling; declining one never runs its write; a READ grant on
  the other answers no write (categories never cross).
- Mixed kinds (agent `background-worker-policy.integration.spec.ts`): a read
  grant never answers a sibling parked on a QUESTION.
- Harness landmine: a scripted model must tell root from child by the LAST
  user message ("find flag N" vs the task / a wakeup). Tool presence fails
  (workers hold a delegation tool and fanned out again, nesting threads) and
  a whole-prompt marker fails (the child receives the root's delegated
  context).
- LIVE decision rows (desktop `delegated-sibling-grant.integration.test.ts`):
  a decision delivered while a sibling still works resumes the parked child
  INSIDE the running leg (one leg, `reason: 'user'` answer chunk, ledger row
  consumed, turn completes); a live "Allow reads this session" answers the
  parked sibling AND a child that parks afterwards under the remembered grant
  (`reason: 'session-grant'`); a decision after the leg settled is
  `'no-live-run'` and changes nothing. Agent-level
  (`background-worker-policy.integration.spec.ts`): a live one-shot approve
  resumes the child in the same leg and its NEXT gated read parks that same
  task again with a fresh root card (the loop forgets a resumed task's earlier
  terminal — a mutation that keeps it dedupes the second pause away).
- Decisions during a run (assistant-ui, `decision-dispatch.ts`): while the
  thread runs, the decision is delivered INTO the run through the host's live
  transport (`LiveDecisionProvider`, desktop `POST /assistant/decide`); when
  no leg is live for it (404: settled, or not a parked background child) or
  the host has no transport (web) it queues, dispatched one per run end; a
  queued decision the host meanwhile answered is dropped at dispatch with a
  log line (`dequeueDispatchable`), never sent stale. The card locks for the
  round trip; a host refusal (409) unlocks it with a warning.
- Presentation (assistant-ui, settled 2026-09-15): N parked children of one
  category → ONE full root card and N−1 rows behind it; a grant collapses
  every answered card into a row ("Allowed by session grant") and promotes
  the next pending card of another category; a grandchild's card indents
  under its ancestor with the ancestor's rail. Contract and tests in
  `assistant-runtime.md` (PERMISSION ENGINE, SWARM-AWARE PRESENTATION).
- Child views (assistant-ui + app-shell, settled 2026-09-15): a child tab
  renders its own copy of a leaf approval, but the host answers it on the
  ROOT leg only, so the child reads its owning root's answers by identity
  and shows the same answered row ("Allowed by session grant" / "Approved");
  a genuinely pending child card stays actionable. Contract and tests in
  `assistant-runtime.md` (PERMISSION ENGINE, CHILD VIEWS READ THE ROOT'S
  ANSWERS).
SETTLED 2026-09-14 (canonical, after reading Claude Code v2.1.186+, Codex and
Cursor behaviour): a BACKGROUND child's pause publishes LIVE — its scoped
notice and the synthesized root card leave the leg the moment its TASK is
durably parked: the child's pause chunk streams before the task's storage row
is suspended, so the notice is parked (`withholdPauseNotices` → `parked`) and
released by the native `background-task-suspended` part
(`releaseParkedNotices`; `projectBackgroundStream` now forwards that part). A
decision delivered in the window before the row is suspended would find
nothing to resume ("stale or ambiguous") — the card must not exist before
its decision can be applied. Only a FOREGROUND pause (the parent run itself
suspended) is withheld to the completion join. thread-4f14436f held three
cards for 77 s until the slowest sibling returned. Paired:
`withhold-pause-notices.spec.ts` ("for background children") and the desktop
row "a parked child's root card publishes while a sibling is still working".
The child store also coalesces streaming notifications to one per 16 ms window
(`delegated-conversation-store.ts`): per-frame notification re-converted every
mounted child view per frame and stalled the renderer once a few tabs were
open.
SETTLED 2026-09-14, LIVE DECISIONS (do not relitigate): a decision reaches the
RUNNING leg, as Claude Code answers a subagent's permission prompt inside the
live session. Seam: `live-decision-channel.ts` (one channel per runtime,
`runtime.liveDecisions`; the background phase driving the stream — the idle
loop or the resume stream's terminal wait — owns it and hands out
RESERVATIONS that keep the phase from settling until the reserved tasks are
resumed or released — COUNTED per reservation, because two deliveries can name
the same suspended row (one as a user's own answer, one as a granted sibling of
another's) and each must be able to give its own hold back: when only the first
holder could, a failed decision releasing after another had resumed that row
dropped a RUNNING task from the wait and the leg ended with its terminal
missing from the map the pause branch reads); `live-decisions.ts` `armLiveDecisions` (every leg arms
it: validates against the live native snapshot exactly as a click would,
validates the parked siblings the request's FRESH snapshot allows via
`allowedBySnapshot` the same way, records the answer and theirs with the host
as consumed in ONE all-or-none write (`recordToolActionAnswers`: a refused
answer records nothing, so the user's pause stays answerable; a sibling whose
leaf a durable decision already answered is SKIPPED by discovery rather than
refusing the leg; BST-1749 and PR #3209 reviews) — never the root's single
active claim, the leg may hold that already — publishes the
`tool-approval-answered` chunks on the leg's own stream, resumes in-process
through `manager.resume`, and REMEMBERS a lasting grant so every ask tool's
live flag lets each later call the grant allows run without parking (SESSION
GRANT STOPS ASKING, below)); desktop `delegated-execution-controls.ts`
(`registerDesktopDelegatedDecision` keyed by the steerable host run id,
`deliverDesktopDelegatedDecision` → `'no-live-run'` on
`LiveDecisionUnavailableError`) and `decide-endpoint.ts` (400 shape / 404 no
live run / 409 host refusal with reason / 500 resume failure; the renderer's
policy request is resolved into the TRUSTED snapshot exactly as a stream
request's). Two in-process facts a fresh resume leg never met: the delegation
config's per-leg caps count a RESUMED address once (`admitted` set — the
resume of a parked child was refused as a third concurrent subagent), and the
delegated projection REOPENS a child that finished on a pause when its
continuation re-enters (`parked`; a completed child's late parts stay
dropped). The parent still wakes only on returned/failed/cancelled work; the
idle loop keeps closing when nothing runs, so a decision on an all-parked turn
takes the ordinary new-leg path (404 → queue/append).
SETTLED 2026-09-15, SESSION GRANT STOPS ASKING (do not relitigate): after a
live "Allow <category> this session" the next gated call of EVERY child in
the leg simply runs — no suspension, no card, no resume. The remembered
grant used to answer each later pause after the fact (park → card →
auto-answer → resume): 70 cards and 70 resumes for reads the user had
allowed (GLM run, thread-debug pack 2026-09-15T03-31-15Z). Mechanism: the
permission gate no longer clones an ask tool with a STATIC
`requireApproval: true` (Mastra copies that boolean once per stream call,
`agent-DsRUDsS_.js:34955` → `utils-C9npriyv.js:682-709`, so nothing could
lift it mid-stream). `applyLiveApprovalGate` (`approval-gate.ts`) clones each
kept ask tool with the PUBLIC FUNCTION form of the per-tool flag
(`dist/tools/types.d.ts:551`); `CoreToolBuilder.build()` turns it into
`requireApproval: true` + `needsApprovalFn` (`utils-C9npriyv.js:684-686`) and
Mastra evaluates `needsApprovalFn` on EVERY tool call
(`agent-DsRUDsS_.js:26437-26444`, overriding both the run-wide gate and the
boolean). The function forwards to the runtime's single decision point,
`createApprovalGate` — the agent's OWN ask set (the root's in
`resolveGatedToolMap`, each child's re-gated set in `buildPersonaSubAgents`,
grandchildren re-gate the raw child map) AND `runtime.liveDecisions.remembered`,
read per call — so a mid-stream child is lifted on its very next call. NO
run-wide `requireToolApproval` predicate is ever synthesized: any truthy
run-wide gate forces Mastra to run every step with concurrency 1
(`agent-DsRUDsS_.js:24054`, `toolCallConcurrency` ignored), which would have
serialized foreground fan-out and the root's parallel reads under the default
posture (proven by the fanout harness: HEAD parks four foreground children in
leg 0, a run-wide predicate parks one). The converted boolean is `true`,
exactly the old static clone, so per-step concurrency classification is
unchanged. `live-decisions.ts` remembers the grant once the host has recorded
the user's decision and BEFORE the in-process resume (`remember` strictly
precedes every `manager.resume` the decision issues), so the resumed child's
next call already sees it; `suspended` still answers a pause the flag did not
lift. Persisted "Always allow" policies work through the same flag (the
rebuilt leg's snapshot resolves the tool to allow → not in the ask set → no
clone). Paired: `approval-gate.spec.ts` (mutation: ignoring `remembered`
fails "lifts the gate for every tool a remembered session grant allows"; a
clone captured at clone time fails "the clone reads the gate on EVERY call"),
`build-persona-subagents-approval-gate.spec.ts` ("child approval gate": the
converted child tool carries `requireApproval: true` + `needsApprovalFn`,
lifted by `channel.remember`, and `defaultOptions.requireToolApproval` is
undefined), `root-live-approval-gate.integration.spec.ts` (the ROOT's executed
map: every `runtime.askTools` id carries the function form — eager ids as
converted `requireApproval: true` + `needsApprovalFn`, deferred ids as loaded
through `toolSearchProcessor` — and an ask-gated Anthropic web search stays the
Tavily clone; mutations: dropping the root `applyLiveApprovalGate` call,
settlement not copying descriptors, or the web-search swap ignoring `askTools`
fail it), `background-worker-policy.integration.spec.ts` ("after a live
session grant the sibling's NEXT gated read runs without a pause": exactly one
root card for the leg, `effect` called for every read — mutation:
`needsApprovalFn` → `() => true` fails it; "a live session grant is remembered
BEFORE the parked child is resumed": call order `['remember',
'resume:remembered']` — mutation: remembering after the resume records
`['resume:forgotten', 'remember']`), and the desktop rows "a live 'Allow
reads this session' answers the parked sibling, and a child that reads
afterwards never parks" and "a live session grant during an approval leg: one
claimed decision, zero further policy rows" (mutation: a gate that never lifts
adds `delegate-1` to both rows' cards). Verifier: `e2e-subagents.mjs` verdict
`cardsAfterGrant` must be 0.
SETTLED 2026-09-14, PAUSE TERMINAL (proven by the live-app verifier, do not
relitigate): a background child's pause FINISH (`message-finish`,
`tool-calls`) is the child view's TERMINAL frame — the renderer's
`delegated-conversation-receiver` closes the child on it and throws
"Delegated conversation emitted frames after its terminal" on any later
frame, which tears the whole root stream down; the host then records the run
finished and every child dies with `delegation-root-not-running`
(thread-834924c1: pause at :16, live resume at :23, resumed frames at :26,
client abort at :26.4). A parked child is not finished, so the pause finish
is never published with the card: `releaseParkedNotices` HOLDS it in the
leg's held notices (published at the leg's end for a child still parked) and
`dropHeldPauseFinish` discards it when the native `background-task-resumed`
part arrives (`projectBackgroundStream` now forwards suspended AND resumed
parts). Paired: desktop row "a live-resumed child's frames never follow a
terminal" (mutation: publishing the finish with the card fails it) and
`withhold-pause-notices.spec.ts`.
SETTLED 2026-09-15, REPEATED SUSPENSIONS (live-app verifier run 5): one
suspension of a background task reaches the host loop more than once (the
manager's lifecycle event, the parent turn's own copy, a replay around the
resume), while a task resumed in-process legitimately suspends AGAIN later.
Treating the repeat as a new pause emptied the idle loop's running set while
the child still worked; the loop closed, `projectBackgroundStream` failed the
leg ("Background stream ended with unfinished child work"), the run row read
`failed` and the renderer never received that child's terminal ("Parent
stream ended before a delegated conversation terminal", root message
"Failed"). `createSuspensionLedger` keys every suspension by Mastra's
`suspendedAt` stamp: a repeat of the stamp already handled for that task is
the same pause and is dropped; a new stamp is a new pause. Applied in the
idle loop and the resume stream's terminal wait. Paired:
`background-idle-loop.spec.ts` (mutation: no dedupe closes the loop early).
SETTLED 2026-09-15, PARKED PARENT (live-app verifier run 6, do not
relitigate): a parent turn that ends on the PARENT's own pause (native status
`suspended`) parks the run on the user and NO wakeup ever runs a continuation
on it. The root paused on its canvas write with one child's wakeup still
queued; the host loop ran that wakeup as a fresh `agent.stream` on top of the
parked run, the root proposed the write AGAIN, and the thread carried two
canvas cards — the first orphaned for good (its run superseded), and the
verifier's two clicks 130 ms apart cancelled one leg (assistant-ui `append`
cancels an in-flight run before `isRunning` flips). `withBackgroundIdleLoop`
reads each piped turn's status: parked + children running keeps the leg open
until they return (their frames stay in this leg, their results are saved by
Mastra's native `onResult`); parked + nothing running closes the leg as the
pause it is, dropping queued wakeups with an info log
(`background_parked_parent_wakeups_deferred`). Paired:
`background-idle-loop.spec.ts` (mutation: continuing on a parked turn runs
`agent.stream`) and the policy harness row "the root's own pause ends the
leg once its children return" (`fanout.rootGate`; before the fix it recorded
`['root-write', 'root-write']`).
SETTLED 2026-09-15, LATE RESULTS AFTER A ROOT PAUSE (live-app verifier run
7, do not relitigate): the root pre-created its canvas 25 s in, before any
specialist returned; after every specialist had returned it approved that
write and reported from its OWN inspection while telling the user it was
"still waiting on the four analyses". Mastra's `approveToolCall`/
`resumeStream` restore the message list snapshotted at the pause, in which
every child still running at that moment is a dispatch acknowledgement; the
restored list also replaces any `context` the resume is given, so no message
reaches the resumed model. Three host rules close it. (1) The late results
are exactly the finished tasks THIS run dispatched (`task.runId`) whose
`completedAt` is not before the run's `AgentRun.suspendedAt`
(`listLateBackgroundResults`). (2) A ROOT-level approval/typed resume
overlays them onto the acknowledgement tool results at the provider
boundary on every request of the resumed run
(`late-background-results-processor.ts`, first in the leg's per-call
processors so the stale-history filter and the limiter judge the real
results). This overlay uses the same text-only projection stored beside the raw
durable child result. The PGlite message commit boundary also overlays terminal
task rows on every native save, and task-only completion/repair reads current
parent snapshots inside its transaction, so neither resumed nor callback saves
can restore stale acknowledgements or erase newer parent content. The leg still
restores late outcomes once it settles (`restoreLateBackgroundResults`, in the leg's
`settleNativeStream`). (3) A child card answered on a NEW leg while the root
is parked resumes the child only: the resume stream's `parentWakeups` finds
a suspended run in scope and ends the leg as a pause
(`background_parent_parked_wakeup_deferred`) — a fresh parent inference
would propose the root's pending call again. Paired:
`background-late-results.integration.spec.ts` (both rows: the resumed root
reports `PARENT_FINAL_OUTCOME` from the overlay and memory holds the result
afterwards; the child-card leg runs no parent prompt) and
`late-background-results-processor.spec.ts`. Residual: a run that pauses
AGAIN after consuming late results is resumed from a newer stamp, so those
results are not overlaid a second time (they are in memory for every fresh
inference); the model has already read them by then.
SETTLED 2026-09-15, CHILD PROVIDER COMPAT (live-app verifier run 6): a
live-resumed Explorer's response was persisted twice under two message ids
1 ms apart (Mastra's sealed-boundary re-key) and its next request 400ed
"Duplicate item found with id rs_…" — a failed specialist, "· 1 failed" on the
root — because `OpenAIDuplicateItemCompat` reached only the root's per-call
processors (`buildToolLoopOptions`) and a worker's loop options, never a
read-only child. `buildChildProcessors` now carries it for non-worker
personas, resolved against the child's OWN provider like its error
processors. Paired: `build-persona-subagents.spec.ts` ("exactly once; other
providers get none").
RESUMED EXECUTORS (BST-1749 review of #3197): a resume leg OWNS its live
decision seam (`channel.own`) before it registers anything, and registers every
executor it resumes (`prepareResumedExecutor`, through
`createResumedExecutors.register`, awaited) BEFORE it asks Mastra to resume any
task. Ownership cannot wait on registration: `getToolsForExecution`
is async while the leg's first run event streams at once, so a leg that
registered first answered a live session grant with `'no-live-run'` (desktop
`delegated-sibling-grant.integration.test.ts`, "a live session grant during an
approval leg"; unit pin: "owns the live decision seam before it registers").
Mastra looks the executor up only when its workflow runs the task, so a resume
issued first raced that lookup ("No executor registered"). A registration
failure fails the leg before any task is resumed,
and every context the leg registered but Mastra never accepted — a registration
or resume that failed part-way through the leg's tasks, or an abort before its
resumes — is deregistered when the leg ends (Mastra 1.64 throws from `resume`
only before it publishes `task.resume`, so a refusal dispatched nothing). A
refusal drops ONLY a context the leg still owns. Because the leg owns the seam
across its whole registration window, a live decision can resume a task this
leg has not reached yet (nothing rejects that —
`findGrantedBackgroundApprovals` selects on `status: 'suspended'` alone).
Registration is therefore SINGLE-FLIGHT per task: every caller shares the one
live registration, so the
context Mastra runs is never replaced, the task is never resumed twice while it
runs, and it is never deregistered — not by a refusal already in flight, and
not when the leg releases its executors. Its terminal retires both the
registration and the acceptance (acceptance is per resume), so a child that
parks again is registered and resumed afresh with its own join. Retirement is
by GENERATION, not by forgetting the registration: one whose tools are still
resolving cannot be retired by dropping the map entry, because the next caller
then registers afresh and the retired registration still commits when it lands
— registering a second context over the one Mastra is about to look up and
replacing the executor whose join that caller already pushed. Every terminal
raises the task's generation, and a registration that lands on a generation no
longer the task's commits nothing. Removing that
context would strand the running task on the "No executor registered" failure
this contract exists to prevent. A terminal settles the task's ONE live
registration; a later one is settled by its own terminal. A register or resume
still in flight when
the leg releases its executors is skipped by that release and drops ONLY a
context the leg still owns: a resume Mastra accepted keeps it, a refusal drops
its own only when no concurrent resume is still in flight, and a registration
that lands after the release is refused as not live without ever touching the
shared manager (resolving the tools is async, so the registration itself is a
thunk the leg calls once the tools have resolved AND it still may — the drain
is re-checked both before the cache lookup and after that await, and the
registration's own generation is re-checked after that await too; the `accepted`
check runs after the registration and only decides whether the task joins the
drain set). The full state table —
registered, in flight, accepted, drained against every event, with the pin for
each cell — is the module doc of `createResumedExecutors` in
`background-resume.ts`; keep it in step with that code.

2026-09-26 reconstructed-root approval failure: three Explorer children parked
on read asks while the root paused on its own glob approval. That approval
started a fresh root runtime; its live session grant resumed all three children
through `background-idle-loop` without restoring their native task executors.
All three durable task rows failed with `No executor registered for tool
"agent-explore"`. The same executor owner now serves dedicated resume and idle
phases. A live decision prepares every selected task before its durable approval
answer, so a failed preparation leaves the cards answerable, then registers
before native resume. In the original runtime Mastra still owns a suspended
task's context; replacing it misroutes output to the root. A reconstructed
runtime has no such context and restores the task through the shared executor.
The real Mastra guard `reconstructed-root-live-approval.integration.spec.ts`
parks three Explorer children behind a root approval, reconstructs the root,
answers one read plus two granted siblings while the root provider is held,
and verifies six reads and three completed native tasks. The live resumed-owner
guard in `background-stream.spec.ts` also pins child write pauses reaching the
approval UI before the held parent model finishes.
The leg's pause branch joins each resumed execution (`Promise.all(settled)`),
and a join exists only for a task Mastra accepted. A join settles when its
executor settles, or when Mastra publishes a terminal that ends the task.
Completed, failed and timed-out are published only AFTER the execution settled
(`classify-outcome` runs once `run-attempt` awaited it, with no race, so a
timeout whose tool never honours the abort publishes no terminal at all); only
a CANCEL is published while the execution is still in flight, and Mastra then
joins that execution under its 5s grace, as this leg's `manager.shutdown()`
does. Because the leg can therefore close while a tool still runs, output that
tool writes afterwards is dropped with `background_resume_output_after_close`,
never thrown back into its execution. A SUSPENSION never settles a join: only
a running
executor parks, so the executor that parked is still joined after its host
join. Before, a refused resume, a cancel before the executor ran and a cancel
while it ran each hung the leg forever. Paired: `background-resume.spec.ts`
("executor registration"; its harness is
`__tests__/fixtures/background-resume-harness.ts`).
KNOWN LIMITS: the root's OWN foreground pause (e.g. a canvas write) while
children still run is not live-deliverable — it queues behind the leg (404);
a queued decision whose pause was cancelled by a root Stop dispatches and
fails visibly (`run.failed`), it is not silently discarded; foreground (web)
siblings that have not paused when the parent suspends surface only on
reload; from the moment the resume stream's terminal wait ends (its last
terminal is in, or a Stop ended it) until the parent wakeup starts, a decision
is `'no-live-run'` and queues. That holds even while the leg still joins its
final ledger row, because `createTerminalWait` closes before it resolves and
`reserve` refuses a closed wait. Before, a decision reserved during that ledger
read joined the ended wait and failed the leg ("Background resume ended before
every terminal task state."). Paired:
`background-resume-terminal-wait.spec.ts`.

OPEN (foreground children only, i.e. web): a sibling that has not
yet paused when the parent run suspends on the first child's approval is not
surfaced live — Mastra closes the parent stream at that suspension; its pause
appears on reload through rediscovery. Seen in the desktop scenario before the
background scope was wired; not exercised by the desktop product path. The foreground pin in `specialist-fanout.integration.spec.ts`
("does not answer pauses already parked") describes foreground children only.
Discovery supplies the same root scope and resolves the authorized native leaf;
missing scope/address is not permission to resume an arbitrary wrapper.

`delegated-worker-write.desktop.test.ts` covers approve-once, decline-without-write,
recursive leaf approval, renderer reload and a distinct native host restart.
`background-worker-stream.integration.spec.ts` covers questions followed by a new
plan pause, failed outcomes, lost parent-result delivery and root Stop with a
queued effect. Native background follow-up/human composer and selective subtree
controls remain separate acceptance within BST-1723.

Scripted transport fixtures identify root/child calls from their tool surfaces,
not the last user message: root context can end with a ledger refresh. Tests of
new native continuations use `recordWakeup`, not the ledger header, which is also
present inside active runs. Hold children until the initial acknowledgement when
the acceptance specifically requires an idle-loop continuation. The desktop
deadline fixture has one child model call: the old last-user classifier wrongly
counted the root's terminal-ledger response as a second child call. Persisted
usage, terminal status and reload assertions remain independent of that classifier.
