# Assistant persistence

Use this contract when changing transcripts, reload, memory, thread selection,
usage or notifications. Desktop history belongs to the host's append-only SQLite
run log. The host is its only writer; durable facts commit before publication.
The renderer and Mastra memory adapter consume projections rather than maintain
parallel transcripts. [ADR-0011](../adr/0011-run-log-and-state-store.md) owns the
storage decision; [StateStore](state-store.md) owns its physical lifecycle.

## Canonical history and live output

- Preserve canonical thread, run, message and tool-call identities through live
  display, replay, continuation and branching. Readers validate the producer's
  shape; missing or damaged history refuses rather than becoming an empty thread.
- Complete model steps own durable text and reasoning. Open-step text, reasoning,
  shell slices and MCP progress are transient telemetry. Late subscribers receive
  bounded in-memory replay with ordinals and explicit omission notices; committed
  parts replace the overlay without duplicating it.
- Stop, terminal watchdog abort and orderly host shutdown preserve observed
  partial replies. An unclean process exit can lose uncommitted text; recovery
  records interruption. A replaced failed attempt contributes no partial reply.
- Raw tool results and artifacts keep their execution identity. Model-output
  pruning, supersession and compaction are projections; they do not rewrite the
  stored result into a shortened transcript.

Owners: [log projections](../../packages/agent-host/src/log-projections.ts),
[telemetry replay](../../packages/agent-host/src/telemetry-replay.ts).

## Memory and accounting

Mastra memory is a run-owned library adapter over committed host history and the
existing StateStore writer. It creates no transcript store or independent
permission authority. Recall from other threads includes settled turns only;
active or suspended work is not completed provider history.

Keep observations within the selected chat provider's privacy boundary under
[ADR-0013](../adr/0013-observational-memory.md), with concrete resolved models and
explicit credential authority. Actual observer and reflector usage belongs in
billing and spend totals. A rewind preserves observation residue; branched
history withholds observations it cannot attribute safely instead of guessing
which text to remove. Strict deletion and reset must also erase affected memory.

The context meter describes the latest provider step, not accumulated billed
usage. Estimates, unknown cost and unavailable measurements remain labelled;
missing cost is never asserted as zero.

Owner: [host memory adapter](../../packages/agent-host/src/adapters/state-store-host-memory.ts).

## Thread state and clients

Core owns each thread's non-secret model/configuration selection, including CLI
and composer changes. Wakes admit from the current committed selection; restart
recovery uses the admitted run snapshot. See [ADR-0019](../adr/0019-host-thread-run-selection.md).

Workspace presentation and execution bindings are distinct. Hydrate before
saving presentation state, preserve outgoing thread state, and reject stale
asynchronous publication. Execution uses admitted live root identities, never
saved display paths or a later view's binding.

Hydration seeds notification baselines without replaying old alerts. Notification
preferences and focus are checked at event time; payloads omit message content.
Follow-up queues are session-lived and scoped to their owning conversation;
inspection panes cannot dispatch another conversation's queue. Current-schema
reopen, deletion and reset remain required; historical data conversion does not.
See [ADR-0020](../adr/0020-greenfield-data-lifecycle.md).
