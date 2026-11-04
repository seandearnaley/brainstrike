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
- Freeze the persona instructions, catalog and executable identities for the admitted run.
  - Later settings can't widen it or replace a paused call's authority.
  - Live root grants can release child asks; later reductions and denies still apply.
- Children inherit the admitted parent model. Model-pinned personas refuse explicitly (`persona.model-pinned`); never substitute another model.
- Delegation is unavailable in plan mode.
- Child system context is host-projected. The delegated prompt is task input, not authority over system instructions, credentials or tool scope.

## Work and results

Owner: [Core child manager](../../packages/agent-host/src/core-child-runs.ts).

- Tree limits come from admitted subagent settings; invocation admission is atomic across parallel calls.
- All descendants share the turn's work queue.
  - Model streams and tool execution hold permits; delegation and approval waits hold none.
  - Each child has its own execution watchdog, and its last model step is reserved for a tool-free summary.
  - A descendant at any depth prepares each step from the root's provider, never by wrapping its parent's, so one step holds one permit and follows only its own persona's step rules.
- Root delegation defaults to background unless inline is requested; nested delegation runs inline.
- The parent's model receives the bounded child result; the child's full transcript and artifacts stay in its own log with original usage attribution.
- Starting work never proves completion.
- A child pause does not wake the parent.
- Background completion delivers the whole turn's invocation ledger with a durable delivery watermark.
  - Wakes use the parent thread's current committed selection and keep the original admitting client origin ([ADR-0019](../adr/0019-host-thread-run-selection.md)).
  - Delivery follows the thread, not the dispatching reply: a regenerate or edit of that reply's message takes its undelivered results once.
  - An outcome is in full only in the delivery that first takes it. A later ledger of the turn lists that invocation by its outcome's opening, which still reaches the model after Memory's window drops the earlier message.

## Conversation controls and retirement

- Opening a child panel neither starts nor cancels its run.
- Controls name the selected child and exact host interaction; root controls are never inherited by accident.
- Human input during active child work ends that run after its current step, then starts the child's next run once.
  - Failed or stopped work reports why it could not consume the input.
  - Work that took human input (a background invocation, or a completed follow-up typed into an idle child) reaches the parent once, in the same delivery as the run that took the input and any input that run took in turn, however it ended. That run is the one the input's committed run/start started.
  - A regenerate or edit of the input's message is the person's own follow-up and reports only when it completes.
  - A restart delivers both at the next user turn; it does not replay the input.
- A delegation card shows its child's committed run (working, waiting on a person, or how it ended, with its tool calls), as Core folds it from the child's own log, never from the delegation call, which settles when a background child starts.
  - Core folds each thread's summary (latest run, waiting interactions, answered approvals) once per committed row. `thread/tree` serves a thread's summary with every descendant's, and `thread/tree/changed` names a changed thread and its ancestors.
  - A thread view reads its tree again only when told, and never reads a child's log for its cards, approvals strip or waiting questions. Reading every descendant's full log made a thread with many subagents hold hundreds of megabytes and kept the host busy for seconds (2026-11-02).
- While a root has no run of its own, its working background children are named at its composer; their Stop is the turn's root Stop (accepted after that run ended).
- Root Stop cancels the turn's descendants; child Stop leaves its parent and siblings running.
- Join actual work and memory/provider owners before releasing resources.
- Stopped turns keep results for the next user turn and don't auto-wake.
- Restart marks child runs and interactions interrupted; it never replays them.
- Deletion includes the authorized child subtree. Debug exports and usage projections keep their original scope and lineage.
