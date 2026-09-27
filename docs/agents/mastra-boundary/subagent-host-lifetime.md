# First-class subagent host lifetime — evidence

Supports `docs/agents/mastra-boundary.md` § "First-class subagents: host lifetime
decision" (BST-1716, BST-1723, BST-1718). Read this before changing background
ownership, cancellation, or the local `@mastra/core` patch. The xxhash-wasm hunk
has its own record in `semantic-recall-wasm-leak.md`.


Keep `Agent` plus Brainstrike's owned host services for the first-class
subagent project. The installed native loop already supports recursive
delegation and nested approval/suspension; the executable matrix and planned
limits live in `assistant-subagents.md`. `AgentController` is a beta alternative
session owner, not a prerequisite for those capabilities. Adopting it now would
duplicate existing permission, workspace, run and thread responsibilities.

**BST-1723 background ownership:** the service acquires the root conversation's
FIFO execution owner before constructing Mastra or opening a turn checkpoint.
The host-owned `withBackgroundIdleLoop` (`background-idle-loop.ts`, passing
Mastra's typed `_skipBgTaskWait`) keeps that owner through native background
work and parent continuations; release follows session closure and
terminal persistence, including when the transport subscriber detaches. The
PGlite composite store registers a resource/thread-scoped background domain;
retries are zero and per-task timeouts must be positive and at most five minutes
(superseded 2026-09-22 by the host-owned runtime limit below).
Explicit root Stop closes native admission, cancels running, queued and suspended
tasks, and joins workflow writes. Ordinary paused shutdown and construction
failures retain pending approvals; only the external root Stop cancels them.
Stopped durable pauses are cancelled through the native storage CAS and their
native background workflow snapshots are deleted after live owners settle.
Cancellation uses explicit resource/thread/native-parent-run filters and does
not construct a runtime that might restart unrelated work. The local core patch
preserves native child suspension IDs and joins workflow cleanup in ESM and CJS,
even when pubsub flush fails. Joins share the existing native shutdown deadline:
a held flush/executor produces an explicit cleanup error at that deadline,
never success or an infinite owner wait. Cleanup errors retain the original
stream failure and do not skip diagnostics. The native execution timer is
cleared in the workflow executor's `finally` on suspension; waiting for a human
does not spend the execution deadline (the host-owned `maxChildRuntimeMs` since 2026-09-22). Remove each patch hunk only when its native regression passes
against an upstream replacement. Actual desktop tests distinguish renderer reload
from a guarded host restart with a changed native process ID. Selective child
controls, human follow-up and additional interrupted-work recovery acceptance
remain BST-1723 work; this layer does not establish the whole ticket.



The selective-cancellation native regression holds one executor's cleanup while
a sibling remains active. Native `cancel()` must join that executor before
acknowledging Stop, or reject visibly at the existing native grace deadline.
The core patch owns the executor promise by task ID in both ESM and CJS;
it does not shut down the shared manager to stop one task. Terminal cancellation
retries join the same outstanding executor. A cancelled database status alone
does not prove that workspace effects have stopped. This native contract is a
prerequisite for the host-authorized child controls, not proof of their UI wiring.
The selected join also owns the native workflow's deletion and pending-queue
settlement. Cleanup failures propagate to that task's cancel call, including
repeated calls after settlement, and remain reported by root shutdown. A completed
executor or terminal task row does not release an unfinished workflow write.
Native delegation also composes the child's configured `abortSignal` with its
parent tool signal in both ESM and CJS. Core 1.64.0 otherwise overwrites the child
signal with the parent signal. The foreground regression aborts the child from
its first real tool, verifies that tool sees cancellation and no second child
model step starts, and verifies the parent is not cancelled. This preserves root
abort propagation; it does not itself wire the application Stop control.

Do NOT pass `untilIdle` (settled 2026-09-14, `assistant-subagents.md`): Mastra's
loop wakes the parent model on a child's SUSPENSION with a "waiting for explicit
resume input" directive. The host loop (`withBackgroundIdleLoop`) reproduces the
loop's transport contract — the leg's `fullStream` spans the first turn plus
host-driven continuations, first-turn aggregate properties are not a complete
background-run transcript — and wakes the parent only for a returned, failed or
cancelled task. The installed `streamUntilIdle()` declaration is deprecated. This lifecycle change does not
authorize a Mastra HTTP server, replacement workspace tools, or a second
permission/persistence system.

Mastra 1.64 retains a suspended task's executor context in its original
runtime, while a reconstructed runtime must register one before `resume`.
`createResumedExecutors` reads `manager.taskContexts.has(task.id)` only to
preserve that existing native stream/result owner. `taskContexts` is marked
`@internal` in the installed declaration; this is a version-sensitive,
read-only compatibility seam, not a public Mastra API or a fallback executor.
The same-runtime and reconstructed-root native guards in
`background-resume.spec.ts` and
`reconstructed-root-live-approval.integration.spec.ts` must pass on upgrade.

BST-1718 publication boundary: `conversationBinding.bindRun` is a direct,
process-local host callback. `streamAttemptChunks` awaits its native identity
binding before mapping a child event, with a fresh authorization cache for each
attempt/resume leg. It never serializes host authority into RequestContext or
RuntimeData and never treats skipped resume input processing as authorization.
Desktop run-scoped memory activates this port through a server-derived
owner/root/turn scope. Resume authorizes the original invocation against the
current host leg, rather than recreating it. The existing usage writer resolves
native completion ids to that same invocation; its stream queue waits for the
matching parent terminal so completion cannot outrun publication authorization.

## 2026-09-22: the five-minute ceiling is replaced by a host-owned runtime limit

The ceiling above ("per-task timeouts must be positive and at most five
minutes") recorded no rationale: it adopted Mastra's own `defaultTimeoutMs`
(`3e5`) as a hard maximum, and `PgliteBackgroundTasksStore` rejected anything
larger. In a live swarm (thread-2ae51014, 2026-09-22) healthy, actively
streaming children died with `Task timed out after 300000ms`. Three facts made
the ceiling worse than a plain five minutes:

- Mastra arms ONE wall-clock `setTimeout` per execution attempt; progress does
  not reset it, so a working child is killed exactly like a hung one.
- The delegated work permit is acquired per STEP inside the child
  (`delegated-work-budget.ts`), after the timer is armed, so time spent queued
  behind siblings for one of the two concurrent slots spends the deadline:
  six children sharing two slots each got roughly a third of it.
- Mastra ranks the model's `_background.timeoutMs` above host config, so the
  model could shorten its own child's life; only prompt text discouraged it.

Research across Claude Code, the Claude Agent SDK, Codex, OpenAI Agents, the
Vercel AI SDK, Temporal and LangGraph found no agent loop with a wall-clock
deadline by default; liveness is an inactivity/heartbeat timer that re-arms on
progress (`docs/superpowers/research/2026-09-22-agent-timeout-and-budget-standards.md`).

Replacement: the deadline is the user setting `maxChildRuntimeMs` (Settings →
Models → Subagents), default Off. `resolveChildTaskTimeoutMs` feeds both
Mastra's `defaultTimeoutMs` and the scoped store, which pins every task's
`timeoutMs` to it (logged `background_task_timeout_pinned`, mirroring the
BST-1749 retry pin) and rejects a different value on update. Mastra 1.64 has no
"none" and Node clamps any delay above 2^31-1 ms (Infinity included) to 1 ms, so
Off resolves to `NODE_TIMER_MAX_MS` (~24.8 days) rather than a patch; the store
refuses any host value Node would fire immediately. The parent idle loop's
300 s patience, which borrowed the same constant, is gone: BST-1800 removed that
timer and the stream watchdog judges liveness.
Guard: `pglite-background-store.integration.spec.ts`,
`delegated-deadlines.integration.test.ts`.

## 1.71 upgrade: accepted decision lifetime

On 2026-09-26 the user selected retaining and simplifying the existing host
parent-turn coordinator after the native reference probe demonstrated EOF during
an accepted decision's durable commit. `untilIdle` observes native running tasks,
not asynchronous host decision admission; an out-of-band resume after its EOF
executes the child but cannot publish through the closed parent stream.

The coordinator uses public `Agent.stream`, `BackgroundTaskManager.stream`,
`registerTaskContext`, `resume` and `cancel`. Mastra owns both agent loops and
native executions. Brainstrike holds decision reservations through commit and
resume, records the generation, and derives wakeups from durable task rows.
One symbol per decision replaces separate reservation counts and generation
counters: releasing an old decision cannot release a newer one. There is no
second child loop, dummy keepalive task, native-method interception or private
`_skipBgTaskWait`/`taskContexts` access. Public `waitTimeoutMs: 0` suffices.

The application lifetime probe in `background-grant-wire.integration.spec.ts`
holds the decision commit until the final running sibling returns, then verifies
one resumed effect and the final parent outcome on the same stream. Native
`untilIdle` policy patches were removed. The reference tests retain both the
native capability boundary and the working host composition; neither is skipped.
