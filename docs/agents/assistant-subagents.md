# Assistant subagents

Use this contract when changing persona delegation, child conversations,
background results or recursive cancellation. A child is an ordinary host-owned
run in its own canonical thread. Core owns admission, ancestry, status, results
and decisions; the shared conversation UI displays those facts.
[ADR-0010](../adr/0010-approvals-and-delegation.md) governs permission and restart
semantics.

## Admission and authority

- Commit the parent effect, child origin and initial child run atomically before
  publishing the child. Ancestry comes from committed origins, never parsed IDs
  or UI paths. Refused delegation creates no child conversation.
- A persona narrows the parent's admitted tools. Read-only personas receive their
  declared read-risk tools and cannot delegate or use working memory. Only
  explicit workers delegate recursively, within the admitted depth limit.
- Freeze the persona instructions, catalog and executable identities for the
  admitted run. Later settings cannot widen it or replace a paused call's
  authority. Live root grants can release child asks; later reductions and denies
  still apply.
- Children inherit the admitted parent model. Model-pinned personas currently
  refuse explicitly; do not claim pinned-model parity or substitute another model.
  Delegation is unavailable in plan mode and for the built-in local provider.
- Child system context is host-projected. The delegated prompt is task input,
  not authority to replace system instructions, credentials or tool scope.

Owners: [child admission](../../packages/agent-host/src/child-runs.ts),
[persona capability](../../packages/host-capabilities/src/delegation.ts).

## Work and results

Tree limits come from admitted subagent settings. Invocation admission is atomic
across parallel calls. All descendants share the turn's work queue; model streams
and tool execution hold permits, while delegation and approval waits hold none.
Each child has its own execution watchdog, and its last model step is reserved
for a tool-free summary.

Root delegation defaults to background unless explicitly requested inline;
nested delegation runs inline. The parent's model receives the bounded child
result, while the child's complete transcript and artifacts remain in its own
log with original usage attribution. Starting work never proves completion.

A child pause does not wake the parent. Background completion delivers the whole
turn's invocation ledger with a durable delivery watermark. Wakes use the
parent thread's current committed selection and retain the original admitting
client origin. See [ADR-0019](../adr/0019-host-thread-run-selection.md).

Owner: [Core child manager](../../packages/agent-host/src/core-child-runs.ts).

## Conversation controls and retirement

Opening a child panel neither starts nor cancels its run. Controls name the
selected child and exact host interaction; root controls are not inherited by
accident. Human input during active child work ends that run after its current
step, then starts the child's next run once; failed or stopped work reports why
it could not consume the input.

A delegation card shows its child's committed run — working, waiting on a person, or
how it ended, with its tool calls — read from the child's own log, never from the
delegation call, which settles when a background child starts. While a root has no
run of its own, its working background children are named at its composer, and their
Stop is the turn's root Stop (accepted after that run ended).

Root Stop cancels its turn's descendants; child Stop leaves its parent and siblings running.
Join actual work and memory/provider owners before releasing resources. Stopped
turns keep results for the next user turn and do not auto-wake. Restart marks
child runs and interactions interrupted rather than replaying them. Deletion
includes the authorized child subtree. Full debug exports and usage projections
retain their original scope and lineage.
