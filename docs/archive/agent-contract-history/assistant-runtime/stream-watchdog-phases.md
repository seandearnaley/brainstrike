# Stream inactivity watchdog phases — evidence

Supports `docs/agents/assistant-runtime.md` § "ASSISTANT RESILIENCE (CRITICAL)".
Read before changing `withInactivityTimeout`, the phase classifier, the `tool-executing` allow-list, resume-leg seeding, the tool-call-input window, or the empty-model-response guard. BST-1408, BST-1409, BST-839, BST-1777.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 192-408), extracted verbatim.

3. **Stream inactivity watchdog (LIVE)** —
   `packages/agent/src/stream/with-inactivity-timeout.ts` (`withInactivityTimeout`,
   `StreamStalledError`). `streamAttemptChunks` wraps the raw Mastra iterator.
   The window is PHASE-AWARE across FOUR phases (BST-1408, extended for
   reasoning, extended again for tool execution by BST-1777):
   `BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS` governs the wait for the
   provider to produce its first OUTPUT **in each step**,
   `BRAINSTRIKE_STREAM_REASONING_GAP_MS` every gap while it is emitting
   REASONING, `BRAINSTRIKE_STREAM_INACTIVITY_MS` every gap once it is
   demonstrably ANSWERING, and the derived `toolExecutingMs` while at least one
   tool call is EXECUTING — see the config list below for why they must not be
   re-merged, why the phase boundary is provider output rather than "the first
   part", and why a reasoning delta is not an answer. Since
   BST-1409 a stall ends the ATTEMPT, not the turn; see ATTEMPTS VS TURNS below.
   Only an unrecoverable stall emits a visible assistant message, a terminal
   `run.failed` event, and an error finish so the renderer does not remain
   in-flight forever.

   **The `tool-executing` phase (BST-1777).** A running tool's own silence is
   not the PROVIDER's — the provider already answered with a `tool-call` — so
   measuring it against the tight `streaming` window is what forced the guard
   itself to stay a flat 60s under every tool's own declared budget. The phase
   is tracked by REFERENCE COUNT (`toolCallId`) so parallel calls hold it open
   until the last one settles, and it OVERRIDES whichever provider phase is
   current: the classifier `createMastraToolExecutionPartKindReader` returns (`agent-streaming.ts`) classifies
   `tool-call` as `started`, and `tool-result` / `tool-error` /
   `tool-output-denied` / `tool-call-approval` / `tool-call-suspended` as
   `settled`. Approval and suspension SETTLE deliberately — the call is
   waiting on a HUMAN, not executing, and a human approval wait must never
   inherit the wide tool-executing backstop. `tool-output-denied` is the
   declined outcome and also settles. Scaffolding (`start`, `step-start`)
   CLEARS the in-flight set: a fresh step's tools are over, so a lost
   `settled` part can only ever tighten the next window, never hold the wide
   one open — except before this leg has seen ANY real provider output yet
   (see the resume-leg seeding paragraph below), which only delays when the
   clear can fire and never widens a later step's window. `providerPhase` is
   kept as separate state from the reported `phase` specifically so a
   `reasoning-end` marker arriving mid-tool cannot "preserve" `tool-executing`
   into the provider state machine.

   **Only a GUARDED call may enter the phase — an ALLOW-list, not a
   deny-list (BST-1777 final review, I2-C).** The wide window is only safe to
   enter because a per-call guard always fires first, so
   `hasExecutionGuardBehindToolCall`
   (`agent-streaming.ts`) checks a tool name against `runtime.toolNameMap`'s
   KEYS — exactly the set that went through `applyToolGuards` in
   `tool-pipeline.ts`, since that map is populated before the guard runs and
   nothing is added to it afterwards for a tool that skipped the guard.
   Membership is the allow-list; anything not in it defaults to `false` and
   stays on the tight window, per the file's closed-list rule (unknown ->
   tighten) — no growing enumeration required as new unguarded kinds appear.
   Three kinds are deliberately never in the set:
   provider-executed tools (native web search, injected AFTER
   `sanitizeTools`/`applyToolGuards`, marked `payload.providerExecuted ===
   true` — kept as an explicit check because that entry REPLACES a sanitized
   local name that IS still a key), subagent delegation tools
   (`agent-<personaId>`, registered directly on `new Agent({ agents:
   subAgents })`, never run through `combinedTools`/`sanitizeTools`), and
   Mastra-injected memory tools (`updateWorkingMemory`, `setWorkingMemory`,
   `recall` — see `internal-approval-exempt-tools.ts` — merged into the run's
   tool map by Mastra itself, after this pipeline runs). All three keep
   riding the ordinary provider-silence windows — recoverable, honestly
   diagnosed — instead of silently inheriting a terminal, mislabeled 635s
   wedge. `settled` parts are unaffected regardless of tool name (already a
   no-op for an id that was never added).

   **A DELEGATED child's calls are classified through the envelope (BST-1777
   PR review).** Mastra carries a foreground child's parts on the PARENT
   stream inside the delegation's `tool-output` envelope
   (`payload.output` = the child's own part; see `resolveChildDelegation` in
   `delegated-stream-projection.ts`), the child has no watchdog of its own,
   and the parent's `agent-<personaId>` call is deliberately unguarded — so
   classifying only the outer part left a child's guarded execution measured
   against the parent's `streaming` window. Harmless while the guard was a
   flat 60s; a regression once a child command may legitimately run to its own
   600s budget. The classifier therefore UNWRAPS a `tool-output` whose
   `toolName` starts with `SUBAGENT_DELEGATION_TOOL_PREFIX` and is not itself
   `providerExecuted` — POSITIVE identification, not "not in the guarded set"
   (round 2, CodeRabbit MAJOR): the latter is deny-shaped and also matches
   provider-executed tool outputs and Mastra-injected memory-tool outputs
   (`updateWorkingMemory`, `recall`, …), whose `output` could then be misread
   as a nested guarded `tool-call`. `executeCommand`/`runSkillScript`'s own
   `tool-output` parts are never delegation-prefixed, so their `output`
   (arbitrary tool data) is never unwrapped. The same allow-list applies to
   the nested part, recursing for a grandchild (also `agent-<personaId>`)
   under a fixed unwrap bound. Two deliberate consequences: a child/parent
   tool-call-id collision makes a nested `settled` release the parent's entry
   early, which tightens into a RECOVERABLE phase, not a consequence-free one
   — the still-running parent call drops back onto the provider windows,
   where a stall is classified `streaming`, and a `streaming` stall IS
   recoverable, so `runTurnAttempts` can re-send the step while the parent
   tool may still be alive (the second-execution hazard `isRecoverableStall`
   refuses `tool-executing` for). Collision probability across parent and
   child runs is negligible with provider-generated ids, so the keying is
   unchanged, but the envelope already carries the child `runId` that
   `resolveChildDelegation` reads, so a `runId:toolCallId` key is available if
   it ever needs to be; and a child's nested `step-start` does NOT reach the
   scaffolding clear (the outer `tool-output` counts as provider output), so a
   lost nested `settled` is cleared at the PARENT's next `step-start` — the
   same bound every other in-flight id has. BACKGROUND delegation is out of
   scope.

   **A resumed, approval-approved call is SEEDED into the phase (BST-1777
   final review, I1).** Mastra never replays a suspended step's `tool-call`
   part on the resume leg — only the human's answer resumes it — so the call
   that starts executing there has no `started` boundary for
   the classifier to observe. Left unseeded, that execution
   is measured against `firstOutputMs` (the provider's own silence budget)
   instead of `toolExecutingMs`, misclassifying the phase and its recovery
   semantics. `collectResumedGuardedToolCallIds` (`agent-streaming.ts`) passes
   `resumedApprovalToolCall` plus its siblings — filtered through the same
   `hasExecutionGuardBehindToolCall` predicate, so an unguarded resumed call is
   never seeded either — as `withInactivityTimeout`'s `initialToolCallIds`,
   which both seeds `toolCallsInFlight` and sets the very FIRST wait's phase to
   `tool-executing` before any part of the leg is even read. Because a resume
   leg can open with framework scaffolding (`start`/`step-start`) BEFORE the
   resumed call's own `tool-result`, the ordinary scaffolding-clear is gated on
   `hasSeenProviderOutput` (`with-inactivity-timeout.ts`) — a seeded id survives
   any leading scaffolding and is cleared only once this leg has actually
   produced real provider output, which still leaves the closed-list guarantee
   intact (a lost `settled` can only tighten a LATER step's window).
   **Pinned chunk boundary — do not relitigate.** Verified against the
   compiled `@mastra/core` 1.64.0 loop: Mastra's `tool-execution-start` /
   `tool-execution-end` chunks look like the obvious boundary but are emitted
   only `from: "NETWORK"` (agent networks) and never reach this stream; the
   agent loop's real boundary is `tool-call` -> `tool-result` | `tool-error`.
   A `tool-executing` stall is TERMINAL, not retried: `isRecoverableStall`
   (`turn-attempts.ts`) refuses recovery with `tool-still-executing`, since a
   continuation would re-send the step and risk launching a SECOND execution of
   a tool whose first call might still be alive.
   **What the backstop actually guarantees (PR review, honest wording).** Every
   GUARD window is below `toolExecutingMs` by construction, so a guard that
   answers is never pre-empted. Tool-lifecycle HOOKS are not covered: they
   compose OUTSIDE the guard (`tool-pipeline.ts`), the phase opens at the
   `tool-call` part before `PreToolUse` runs, and `hooks/config.ts`
   deliberately caps each hook individually with NO aggregate pre+tool+post
   ceiling — so the silence is `preHooks + guardWindow + postHooks` while
   `TOOL_EXECUTING_BACKSTOP_MARGIN_MS` is only 30s of slack. A long enough hook
   chain can therefore reach the backstop with a perfectly working guard. The
   visible message (`resolveStalledVisibleMessage`, `stream-termination.ts`)
   asserts only what is known: "A tool call was still running after `<ms>`ms,
   including its lifecycle hooks. The turn was ended rather than retried,
   because re-running the step could start a second execution of a command
   that may still be alive. If no PreToolUse/PostToolUse hook is slow, please
   report it with a debug bundle." No aggregate hook cap and no new env knob
   were added — do not add one without a measured case.
   An EMPTY MODEL RESPONSE rides the same attempt rails: a terminal `finish`
   whose reason would complete the run, on a turn the model contributed
   NOTHING to (no text/reasoning delta carrying a non-whitespace character —
   whitespace-only output renders an equally empty bubble — and no
   tool-lifecycle part, across every attempt; the deltas themselves still
   stream, since formatting whitespace between real tokens is meaningful —
   `ToolLifecycleState.sawModelContribution`, carried
   like the billing flags; resume legs initialize it true because the resumed
   tool call is model output), throws `EmptyModelResponseError` from the
   mapper's `finish` case instead of completing. Field case 2026-08-23:
   OpenRouter's `stealth/ox-alpha` route degraded into HTTP 200 streams with
   one instant zero-usage step and a clean `stop` finish; mapping that to
   `run.finished` painted an empty assistant bubble marked "success". An
   ABNORMAL finish reason is deliberately NOT re-classified — it already fails
   the run with its own truth (gate: `COMPLETED_FINISH_REASONS`, shared with
   `makeTerminalRunEvent` so the two cannot drift).
   The adjacent `withToolCallInputTimeout` wrapper applies its OWN, much wider
   `BRAINSTRIKE_TOOL_CALL_INPUT_MS` window as an absolute deadline from the
   first streamed tool-input marker to its matching input end/complete call.
   `tool-call-delta` proves transport activity and continues to render
   progress, but it never extends that deadline: a provider cannot keep a run
   alive indefinitely by dribbling incomplete JSON arguments. The two windows
   are DELIBERATELY decoupled and must not be re-merged (BST-839): the
   inactivity window asks "is the transport still delivering parts?", this one
   asks "will this call ever become executable?". Reusing the 120s inactivity
   window as the input budget false-positived on legitimate large argument
   payloads — a model writing tens of KB of file content streams argument
   deltas continuously for minutes on a slow upstream route (observed on
   OpenRouter → GLM, which took >120s to stream one file-write input while the
   transport was demonstrably healthy). The wrapper ignores non-tool stream parts before
   probing tool-call IDs, so ordinary text and reasoning deltas do not allocate
   identifier candidate arrays. Expiry uses the distinct
   `tool_call_input_streaming_timeout` terminal code and aborts before an
   incomplete call can execute. A complete call leaves this layer and remains
   governed by the ordinary per-tool execution guard.
   Every initial, approval-resume, and suspended-tool-resume stream owns an
   internal AbortController linked to the caller's signal. The watchdog rejects
   with `StreamStalledError` first, then aborts that exact controller so provider
   work cannot outlive the terminal stream without misclassifying the timeout as
   a user cancellation. Stream teardown also aborts the controller before
   disposal, preventing late provider progress/results from reaching a closed
   consumer. For the built-in local provider this signal crosses
   `LlmHostChatModel → LocalLlmHostClient → LlmHostManager`, removes the exact
   pending request, and sends the hidden renderer's cancel command.
   When watchdog expiry or caller Stop aborts a memory-backed turn, Mastra
   (>= 1.62) itself persists the cancelled run's transcript through its
   `MessageHistory` output processor — completed tool work and any partial
   text, partial tool calls filtered — without awaiting that write. The stream
   adapter's abort seam (`mastra/aborted-turn-persistence.ts`) then persists
   the user input, every assistant message with its partial text RETAINED, and
   only COMPLETED tool invocations from Mastra's live `MessageList`, appends
   `[Assistant turn aborted before completion.]` as the last text part, and
   awaits the save before runtime disposal. Incomplete tool calls are the one
   thing excluded, so Stop cannot resurrect execution on the next turn; the
   awaited save is also the join that keeps Mastra's floating write from racing
   storage close (contract and measurements in
   `docs/agents/assistant-persistence.md`). The same finalizer covers approval
   and suspended-tool resume streams, while Mastra read-only memory remains
   write-free. Ordinary completion still uses Mastra's finish writer only;
   teardown never performs a second normal write.

   Delegated children (BST-1719) capture their native MessageList on the abort
   signal, independent of consumer speed. Mastra's public `afterToolCall` hook
   joins the native child writer before the same abort snapshot is saved.
   `runTurnAttempts` awaits child finalizers before replacing a stalled attempt
   and before runtime disposal, even when the parent later finishes normally. Native `lastMessages: false`
   disables the child's automatic MessageHistory output processor, so the
   root-only join is insufficient. No incomplete child tool call is restored
   by a late native save. See `assistant-subagents.md` for the real desktop
   cancellation/reconstruction proof and the remaining nested-resume boundary.


## 2026-09-22 — each background task is its own producer lane

Supports "Each BACKGROUND task is its own producer LANE" in
`assistant-runtime.md` § Stream inactivity watchdog.

**Defect.** On a background leg the watchdog wraps the host idle loop's
COMBINED stream (`withBackgroundIdleLoop`): the parent's turns, every running
child's parts as `background-task-output`, and the loop's own bookkeeping. The
classifiers read only the OUTER part, so every child part counted as ordinary
output, and after the parent's own `finish` the stream sat in `streaming`.
Every background-child silence — its time-to-first-token on a large context,
its reasoning gaps, a silent `executeCommand` build — was judged against the
120 s `BRAINSTRIKE_STREAM_INACTIVITY_MS` window, not its phase window, and a
`streaming` stall is RECOVERABLE, so the attempt was replaced. The contract's
"Background delegation is out of scope" line recorded the gap.

**Why lanes, not just unwrapping.** One stream carries several producers, and a
single phase follows whichever spoke last. Fan-out is the common case: a
sibling returns, the parent's wakeup continuation answers and finishes, and its
`finish` leaves `streaming` while another child is still on its first token.
Unwrapping alone was also unsafe: a child's nested `step-start` would count as
scaffolding and clear the in-flight set that holds the PARENT's own running
call, dropping it onto a provider window whose stall is retryable — the
second-execution hazard `isRecoverableStall` exists to refuse. So each task
keeps its own phase and in-flight set, the scaffolding clear is per producer,
and the stream waits on the widest open lane. A call in flight in any lane
reports `tool-executing`, even if a misconfigured provider window is wider.

**Bookkeeping.** Native lifecycle events and the host's `run-event` /
`tool-approval-answered` rows are no producer's output. Counted as output, a
ledger row landing during the parent's first-output wait tightened it to
`streaming`. `started`/`running` open a lane but never reset an open one (a
new manager subscriber is re-told every running task) nor reopen a closed one
(a fast child's terminal can outrun the dispatch acknowledgement — the idle
loop's own `settled` rule); only `resumed` reopens. A terminal or suspension
closes it, running call and all, because a parked child waits on a human.

**Known limits (not bugs this change claims to fix).**
- A foreground child's parts — and a background worker's foreground
  grandchildren — still ride their owner's lane: their tool boundaries are
  unwrapped, but their provider phases are not, so the owner reads
  `streaming` while such a child waits on its first token.
- A resume leg's in-process child writes raw delegation envelopes into the
  parent's lane; its task lane, opened by `resumed`, holds the first-output
  window until its terminal, so its mid-answer silence is judged at that wider
  window.
- `background-task-resumed` names no leaf call, so a live-resumed child's
  approved call is not seeded like `initialToolCallIds`: it rides the
  first-output window until its first part.
- One stream-level timer cannot catch one wedged child while a sibling keeps
  producing; that needs a child-owned watchdog.

Guard: `packages/agent/src/mastra/__tests__/mastra-background-watchdog-lanes.spec.ts`
(production part shapes; mutations: collapsing lanes into the root, never
closing, resetting on `opens`, reopening a closed lane on a late start,
counting host rows as output, skipping the task's envelope all fail it) and
`packages/agent/src/__tests__/with-inactivity-timeout-lanes.spec.ts`.

## 2026-09-22 — each background child has its own watchdog; the parent judges only itself (BST-1802)

Supports "Each BACKGROUND child has its own watchdog" and "The parent watchdog
judges only the parent" in `assistant-runtime.md` § Stream inactivity watchdog.
SUPERSEDES the lane record above: the per-task lanes are removed.

**What the lanes left.** One timer over the combined stream fired only once
every open lane had outlived its own window, so it could not end ONE wedged
child while a sibling kept producing; and when everything went quiet it fired
as a PARENT stall, whose recovery aborted the leg and whose teardown stopped the
background manager, cancelling the stalled child and every healthy sibling.
Measured with `background-child-watchdog.integration.spec.ts` against the lane
code (1 s inter-output window, two background children, the wedged child's
provider silent after its first `text-delta`):
- one child wedged: `run.stalled` (`streaming`, 1000 ms), the wedged child's
  `subagent.failed` `cancelled`, then `run.failed` (the continuation, on the
  same runtime, stalled too); the wedged task `cancelled`, the sibling
  `completed`, the turn failed with "The model stream stalled after 1000ms
  without output.";
- both children wedged: `run.stalled`, both `subagent.failed` `cancelled`,
  `run.resumed`, `run.finished` — the parent answered with neither result.

**Decision (owner, 2026-09-22; do not relitigate).** A canonical per-subagent
watchdog, as Claude Code's `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` (reset on every
stream event): each background child's own stream under its own phase-aware
watchdog with the SAME four windows; a wedged child fails as its own task, and
its siblings and the parent keep running; the parent watchdog judges only the
parent's own output. No new setting or env var (the windows' Settings UI is
BST-1801).

**Seam.** `background-child-watchdog.ts`, one per runtime, created with the
runtime's other owners and disposed first. It follows the manager's lifecycle
stream for the root agent's scope from construction — before any dispatch, so
no event of a task this runtime runs can precede it — and demultiplexes each
task's `background-task-output` into that child's own stream, judged by
`withInactivityTimeout` with `resolveMastraProducerOptions`, the root's own
classifiers (the task's delegation envelope is unwrapped once; a grandchild's
envelope stays the child's output, as a foreground child's is the root's). A
resume leg's host executor publishes its child's parts itself, never as task
output, so it feeds the same instance (`hostExecution`). Rejected seams: the
child's output processors and `onChunk` see only a subset of parts (no
`start`/`step-start`, so every later step's time-to-first-output would ride
`streaming`); the parent consumer's delegated projection is paced by that
consumer, so a slow persistence write would read as child silence; wrapping
the child `Agent.stream` would mean overriding Mastra's `MastraModelOutput`.

**Ending a stalled child.** The delegation binding composes one stall
controller per prepared execution into the child's signal and into its
EXECUTION signal — the deadline seam of "Background child deadlines" — and
`afterToolCall` rejects with the stall whatever the unwinding child threw or
returned, so Mastra classifies the attempt `retry` (retries are pinned to 0) →
`failed` with the stall's message, never `timed_out` or `completed`. The
child's projection is the deadline's: one child `run.failed`, whose detail is
that message and whose metadata carries the breadcrumb (`code`, `phase`,
`inactivityMs`, `partsSeen`, `lastPartType`). The ledger quotes the message to
the parent model ("failed — Subagent stalled: …").

**When a child's watch ends.** From `running`, `resumed` or a host executor's
start until its own stream ends (`finish`, `error`, `abort`, `tripwire`) or it
pauses (`tool-call-approval`, `tool-call-suspended`), or its task reaches a
terminal or suspension. Measured through the real background manager: a
completed child's task output ends `… step-finish, finish`, then
`background-task-completed`; a paused child's ends at `tool-call-approval` with
NO `finish`, then `background-task-suspended`. What follows the child's own end
— its message save, task row and terminal publish — is host persistence;
judging that gap as the child's silence would fail a finished or parked child
whenever the database is slow.

**The parent.** `createMastraStreamPartRouter` now routes child output, native
lifecycle events and host rows as bookkeeping (re-arms, moves no phase). A task
HOLDS the stream open from its `started` acknowledgement on the parent's own
turn to its terminal or suspension (a released task is held again only by
`resumed`, mirroring the idle loop's `settled` set). `running` holds nothing:
the manager re-tells it to every new subscriber and publishes it for work this
stream never dispatched — the lanes opened a lane for such an orphan and held
the parent at the first-output window for the rest of the leg (PR #3283
review). `heldWork.watching(held)` says whether any task THIS stream holds is
being watched: while one is, the parent sets no window — every watched child
ends within its own window and its terminal re-arms the parent. Held work
nothing watches — dispatched but not running yet, stream ended with its
terminal still to arrive, or a stall with no live execution here to end
(`background_child_stall_undeliverable`) — waits the first-output window, the
value the lanes gave a task that had produced nothing, and the wait is
re-judged the moment the watch changes, without a part. Removed as dead: named
lanes, per-lane phases and in-flight sets, the widest-lane wait, and the
router's unwrap of a task's envelope into its lane.

**After (same spec).** One wedged: the sibling's `subagent.finished`, the wedged
child's `subagent.failed` (`failed`), `run.finished`; the wedged task `failed`
with "Subagent stalled: no output for 1000ms while streaming its answer (its
inter-output window), so the host ended it."; that child's one `run.failed`
carries `{code: background_child_stalled, phase: streaming, inactivityMs: 1000,
lastPartType: text-delta}`; the wakeup names the failure and the parent gives
its final answer. Both wedged: each fails alone and the parent finishes. No
`run.stalled` in either.

**Envelope unwrap (PR #3283 review).** `unwrapDelegatedChildPart` returns
`{ child }` so an envelope carrying no part is told apart from a non-envelope;
the lanes' `?.child ?? output` read such an envelope as the part itself. The
child watch reads the wrapper explicitly: an empty envelope moves the phase as
output but names no part in the breadcrumb.

**Contract moves paying for the rules.** The local-provider sentence was
shortened: the watchdog's abort crosses `LlmHostChatModel → LocalLlmHostClient
→ LlmHostManager` and sends the hidden renderer's cancel command. The
subagents contract's restatement of the envelope rule became a reference to
this section.

**Known limits (recorded, not fixed here).**
- A parent that wedges MID-TURN while a held child is watched is judged by its
  own window only once no held child is watched. The lanes behaved alike while
  the child was healthy (the widest lane was the child's), but cancelled it.
- Foreground children and a background worker's foreground grandchildren have
  no watchdog of their own; their provider phases still ride their owner's.
- A resume leg's in-process child writes raw delegation envelopes, which stay
  the parent's output (inert while its task's hold is watched).
- `background-task-resumed` names no leaf call, so a live-resumed child's
  approved call is not seeded: its execution rides the child's first-output
  window.
- With the default windows the Mastra task deadline
  (`MAX_BACKGROUND_TASK_TIMEOUT_MS`, 300 s) fires before a child's first-output
  (600 s) or tool-executing backstop, so only inter-output and shorter child
  stalls can fire first.
- A `running` replayed for a task not executing in this runtime is watched by
  the child watchdogs, stalls with nothing to end
  (`background_child_stall_undeliverable`) and never holds the parent.

Guard: `packages/agent/src/mastra/__tests__/background-child-watchdog.spec.ts`,
`mastra-background-watchdog-holds.spec.ts`, `delegated-conversation-binding-stall.spec.ts`,
`background-resume.spec.ts` ("a resumed executor's child is watched …"),
`packages/agent/src/__tests__/with-inactivity-timeout-holds.spec.ts`,
`background-child-watchdog.integration.spec.ts` and the quiet-child case of
`background-worker-stream.integration.spec.ts` (now also under a 500 ms
first-output window). Nineteen mutations each turned a guard red: never ending
a watch at the child's own end; re-arming an ended execution on a late
`running`; feeding one child's output to every watch; `resumed` not starting a
fresh watch; a task terminal not ending it; a stall only logged; the stall
winning only when the unwind threw nothing; the stall aborting the selected-Stop
controller; judging a watched hold; not re-judging on a changed watch; giving
unwatched held work the producer's window; child output counted as the
parent's; `resumed` not holding a released task; a resumed executor not
feeding its watch; the parent watchdog not given the child watch; the child
terminal losing the stall detail; an empty envelope read as the part; an
orphan `running` holding the parent; any watched task (not only a held one)
suspending the parent.

### 2026-09-22 — review of PR #3286 at 857add17f (BST-1802)

Each finding was checked against the code, not only the diff.

- **A lifecycle feed that ends (valid, fixed).** The reader returned on `done`
  and left every watch armed with no feed. Each child would then "stall" at its
  window and be ended while healthy, and `watching(held)` kept the parent
  unbounded. Mastra 1.64's `manager.stream` closes only on its abort signal,
  which only `dispose` aborts, so no production path reached this; it was still
  wrong. A feed that ends or throws is now logged
  (`background_child_watchdog_feed_ended` / `_failed`, naming the tasks being
  watched) and every watch is stopped. Each stop is announced before the
  listeners are released, so the parent re-judges its held work at once and
  bounds it at the first-output window.
- **The hook's cleanup on a stall (not valid; pinned).** Everything
  `afterToolCall` releases (`preparedKeys`, the pending deadline, the stall
  controller) is released before the stall is thrown. The persistence owner runs
  whatever the binding throws: `composeDelegatedHooks` settles both owners with
  `Promise.allSettled`, pinned by `stream-options.spec.ts`. `executionSignals` is
  kept for the binding's life, as `controllers` is, because queued child output
  is projected after the hook ("Signal ownership survives queued output").
  Before this change `prepare` already set it for every execution that had a
  native signal (every background task, and every foreground call with one),
  and the binding is per host run, so there is no new leak. Every `prepare` is
  followed by `afterToolCall`: Mastra's `wrapToolWithHooks` runs it on success
  and on a throw; the delegation config and the hooks are installed together,
  descendants included (`delegatedExecutionOptions`); and the resume leg's host
  executor calls it in `finally`. Two cases now pin the release: a stalled
  execution, and a failed one.
- **A deadline captured after preparation (latent, fixed).** The only
  production caller, the resume leg's host executor, captures before the native
  `execute`, and `execute` always runs `onDelegationStart` and so `prepare`.
  Still, a capture after `prepare` replaced the stall-composed signal with the
  raw deadline. The capture now composes with the prepared execution's stall, so
  the child's terminal keeps the stall's detail and breadcrumb in either order.
- **A malformed lifecycle event (valid, fixed).** A missing id threw into the
  reader and disposed every watchdog. The event is now logged
  (`background_child_watchdog_event_malformed`, with its type and the missing
  fields) and skipped. Output and terminal events need only `taskId`; a start
  also needs the `runId` and `toolCallId` that address the execution to end.
- **A late `resumed` after a host-run execution (valid, fixed).** A task whose
  execution the host runs itself (`hostExecution`) is now watched only by that
  execution. The manager's copy of its lifecycle never starts a watch nothing
  feeds, and so never ends a newer execution of the same invocation.
- **Change listeners pile up (valid, fixed differently).** Keeping one
  `changed()` promise across iterations would not have helped, because
  `Promise.race` attaches a reaction to every input on every call.
  `HeldWorkWatch` now exposes `subscribe(listener) → release`. Each wait
  subscribes once and releases in its `finally`, so the stream holds at most one
  listener; `dispose` releases every listener after announcing its stops.
- **`endStalledExecution` optional (valid, fixed).** It is now required on
  `DelegatedConversationBinding`. A hand-built binding without it is a compile
  error, as the decision-contract fixture showed. The construction check stays
  only for a background runtime that has no binding or scope at all.
- **Leaf-module claim (fixed differently).** Moving the `StaticMastraChunkType`
  declaration out of `agent-streaming.ts` would break the R6 guard
  (`scripts/mastra-stream-chunk-contract.mjs` pins that declaration in that
  file). `mastra-watchdog-options.ts` and `background-child-watchdog.ts` now
  type their maps against Mastra's own `ChunkType['type']` and import nothing
  from `agent-streaming`. `satisfies` still rejects a renamed key: renaming
  `tool-call` or `background-task-output` in those maps fails to compile.

Guard: `background-child-watchdog.spec.ts` (feed end, parent bound after feed
end, malformed event, late `resumed`, listener release),
`delegated-conversation-binding-stall.spec.ts` (post-prepare capture, stalled
and failed release), `with-inactivity-timeout-holds.spec.ts` (at most one
listener). Ten mutations turned a guard red: a normal feed end leaving the
watches armed; listeners released before the stops are announced; a
post-prepare capture dropping the stall; output events requiring every id; a
malformed event throwing; the manager feed restarting a host-run task; a wait
that never releases its listener; a listener per part; and a renamed Mastra
key in each map (type-check).

### 2026-09-22 — targeted review of PR #3286 at 2cd023d27 (BST-1802)

- **The stall throw in `afterToolCall` (verified; no restructure needed).** Read
  in full (`delegated-conversation-binding.ts`, the hook at `afterToolCall`).
  Every release (`preparedKeys`, the staged deadline, the stall end) comes
  before the stall throw. The only statement after it is the deadline check,
  which only throws, and the stall supersedes it. A comment now states that
  invariant. The pins were strengthened to catch a skipped release: after the
  hook rejects, whether the unwinding child resolved or threw its abort, the
  stall end is gone, a second hook call is a no-op, a new execution may prepare
  at the address, and a deadline staged there is not inherited. Mutations
  (throw before any release; keep the staged deadline; keep the prepared
  address; keep the stall end) each turned them red.
  - **Persistence owner.** `composeDelegatedHooks` runs it whatever the binding
    throws (`runtime-assembly/stream-options.ts`, `Promise.allSettled`), pinned
    by `stream-options.spec.ts` ("rejects.toBe(failure)" then two persist
    calls).
  - **Mastra always calls the hook.** `wrapToolWithHooks` calls
    `afterToolCall` on a throw and on success (`@mastra/core` 1.64.0
    `dist/agent-DsRUDsS_.js`, in `wrapToolWithHooks`). The hooks and the
    delegation config are installed together, descendants included, through
    `delegatedExecutionOptions`.
- **A resumed child's stall address (verified; not a defect).** The resume
  leg's host executor calls the native `execute` with `toolCallId: task.toolCallId`
  and `messages: []`. Mastra's tool wrapper treats that as an agent execution
  (`dist/utils-C9npriyv.js`: `isAgentExecution`, `agent.toolCallId`). The agent
  tool takes the delegation's `toolCallId` from `context.agent.toolCallId`, and
  its `runId` from `getToolsForExecution({ runId: task.runId })`. So `prepare`
  registers `{task.runId, task.toolCallId}`, the same address the stall uses;
  the "leaf" mutation in `background-resume.ts` concerns only the after-call
  context.
  - **Integration guard.** `background-child-watchdog.integration.spec.ts` ("a
    resumed child's stall ends that resumed execution as its own failed task")
    wedges an approval-resumed child. It is ended at its inter-output window,
    the task fails with the stall text, the child gets one `run.failed`, and
    the leg never stalls. Mutations: addressing the stall to another call id
    turns it red; so does never watching the host execution (the child then
    ends at the first-output window with a different message).
  - **Unit guard.** `background-resume.spec.ts` now also pins the dispatch
    address the host execution registers.
- **A manager that errors the feed on our own abort** is disposal, not a lost
  feed. The `catch` branch now has the `done` branch's `!disposed` guard, so it
  logs nothing.
- **Watch churn elsewhere.** The watchdogs announce every watch change in the
  root scope. A parent waiting on held work now re-judges its wait only when
  its OWN verdict (`watching(held)`) flips, so another task's watch starting or
  ending never pushes back the first-output bound on its unwatched held work.
  Pinned with a stand-in and with the real watchdogs, and mutating the flip
  check turns both red.
