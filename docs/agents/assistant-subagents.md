# Assistant subagents

A child is an ordinary host-owned run in its own canonical thread. Core owns admission, ancestry, status, results and decisions; the shared conversation UI displays them. [ADR-0010](../adr/0010-approvals-and-delegation.md) governs permission and restart semantics.

## Admission and authority

Owners: [child admission](../../packages/agent-host/src/child-runs.ts), [persona capability](../../packages/host-capabilities/src/delegation.ts).

- Commit the parent effect, child origin and initial child run atomically before publishing the child.
  - Ancestry comes from committed origins, never parsed IDs or UI paths.
  - Refused delegation creates no child conversation.
- A persona narrows the parent's admitted tools.
  - Read-only personas get their declared read-risk tools and cannot delegate or use working memory.
  - Only explicit workers delegate recursively, within the admitted depth limit.
  - The task list, `askUser` and `submitPlan` stay the parent's, even under `*`: a child reports a decision it needs to its parent (ADR-0028 rule 1).
- Freeze the persona instructions, catalog and executable identities for the admitted run.
  - Later settings can't widen it or replace a paused call's authority.
  - Live root grants can release child asks; later reductions and denies still apply.
- Children inherit the admitted parent model. Model-pinned personas refuse explicitly (`persona.model-pinned`); never substitute another model.
- Delegation is unavailable in plan mode.
- Child system context is host-projected. The delegated prompt is task input, not authority over system instructions, credentials or tool scope.

## Work and results

Owner: [Core child manager](../../packages/agent-host/src/core-child-runs.ts).

- A turn is a person's message and every run the host starts to carry it on: its wakes, and the run continued in the worktree one of its runs entered (ADR-0028 step 3; `run.started` `turnId`). A root enters a worktree only while none of its workers is still working, so a turn keeps one checkout (ADR-0028 rule 5); its workers from before and after the switch share one queue, ledger, invocation limit and root Stop.
  - Each run's turn is the one its `run.started` commits (`hostRunTurnId`): a wake's delivery turn, a carried-on run's `turnId`, a worker's invocation turn, otherwise its own run ID. Core and the thread summary read the same rule, so a regenerated wake reply starts its own turn in both.
  - A wake continues the turn whose invocations it delivers, else the turn of the run it follows, unless that turn was stopped: then the wake starts its own. A worker's follow-up is its own turn and never names the parent's.
- Tree limits come from admitted subagent settings; invocation admission is atomic across parallel calls.
- All descendants share the turn's work queue.
  - Model streams and tool execution hold permits; delegation and approval waits hold none.
  - Each child has its own execution watchdog, and its last model step is reserved for a tool-free summary.
  - A descendant at any depth prepares each step from the root's provider, never by wrapping its parent's, so one step holds one permit and follows only its own persona's step rules.
- Root delegation defaults to background unless inline is requested; nested delegation runs inline.
- The parent's model receives the bounded child result; the child's full transcript and artifacts stay in its own log with original usage attribution.
- Starting work never proves completion.
- A child pause does not wake the parent.
- Background completion delivers the whole turn's invocation ledger. Each report is one notice (ADR-0028 step 3b, `notices.ts`).
  - A child run's terminal commit posts `notice.posted` on the parent's log in the same transaction, so whether a run reports is decided once, and the report outlives the child's thread.
  - A run takes the notices due on its own branch: not yet taken by a run on that branch (its `run.started` `delivery` names them), and dispatched by a run on that branch. An edit, regenerate or rewind that leaves the run that took one finds it due again; a branch that left the dispatching run never asked for that work.
  - A running run takes what is due at its next step (`prepareStep`): one user message of its own, committed as `model.messages` whose `delivery` names the notices. Nothing wakes for a notice a step took. A run whose last step makes no tool call has no next step, so its thread wakes after it ends.
  - That message sits inside the turn. Readers that need the turn's input (compaction, projection rewrites, Memory's active slice) use `isHostTurnInput` (`turn-input.ts`), never the last user message by role.
  - A regenerated wake repeats its prompt, which is its delivery, so it takes nothing new.
  - Wakes use the parent thread's current committed selection and keep the original admitting client origin ([ADR-0019](../adr/0019-host-thread-run-selection.md)).
  - An edit, regenerate or rewind that forks above a turn whose workers still work ends that turn first, as its Stop would, so no worker of a branch the person left keeps writing beside the new one (`abandoned-turns.ts`). Sending on from the turn keeps it.
  - An outcome is in full only in the delivery that first takes it on the branch. A later ledger of the turn lists that invocation by its outcome's opening, which still reaches the model after Memory's window drops the earlier message.
- A command session that ends by itself is a notice too, posted on the thread that hears it: its starter while that runs, else the nearest busy or root ancestor. An idle child hands its untaken exits on to that thread. A notice no run took survives a restart and rides the next user turn (Q-2: nothing wakes for it).
- `HostCore.idle(threadId)` resolves once the thread and its child threads have no run executing, ending or settling and no wake pending. A run waiting on a person counts as idle. It joins promises the runs and wakes already own, so it starts nothing and never waits on a clock.
  - Tests of wakes and deliveries act, `await core.idle(threadId)`, then assert. "Nothing woke" is then a plain count, with no sleep and no poll. While a test holds a worker's model, `idle` waits for it too, so release the worker first.

## Conversation controls and retirement

- Opening a child panel neither starts nor cancels its run.
- Controls name the selected child and exact host interaction; root controls are never inherited by accident.
- A person's input to a working child (`run/input`) is a notice, its committed command (ADR-0028 step 3b).
  - The running run reads it at its next step as its own user message, drawn inside its reply where it read it. The run does not end early, so an awaited child's answer to the input is its parent's tool result, and a background child's one report carries it.
  - An input committed after the run ended, or sent to an idle child, starts the person's turn on that child (decided in commit order by the wake). That follow-up reports when it completes.
  - A stopped run starts nothing after it: an input it never read waits for the thread's next run, which reads it at its first step. So does one a restart finds untaken.
- A delegation card shows its child's committed run (working, waiting on a person, or how it ended, with its tool calls), as Core folds it from the child's own log, never from the delegation call, which settles when a background child starts.
  - Core folds each thread's summary (latest run, waiting interactions, answered approvals) once per committed row. `thread/tree` serves a thread's summary with every descendant's, and `thread/tree/changed` names a changed thread and its ancestors.
  - A thread view reads its tree again only when told, and never reads a child's log for its cards, approvals strip or waiting questions. Reading every descendant's full log made a thread with many subagents hold hundreds of megabytes and kept the host busy for seconds (2026-11-02).
- While a root has no run of its own, its working background children are named at its composer; their Stop is the turn's root Stop (accepted after that run ended).
- Root Stop cancels the turn's descendants; child Stop leaves its parent and siblings running.
  - A Stop of any run that carries the turn (its first run, even ended, a wake or a continuation) ends every unfinished run of that turn on any thread (`turnRuns`). That Stop is the one "turn stopped" fact (`hostTurnStopped`), read by delivery, command-session exits, a worker whose delegation commit lands after the Stop (it ends stopped), and the approved-plan or worktree continuation, which is refused at its own admission when the Stop landed while it waited to start.
- Join actual work and memory/provider owners before releasing resources.
- Stopped turns keep results for the next user turn and don't auto-wake.
- Restart marks child runs and interactions interrupted; it never replays them.
- Deletion includes the authorized child subtree. Debug exports and usage projections keep their original scope and lineage.
