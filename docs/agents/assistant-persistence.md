# Assistant persistence

Desktop history belongs to the host's append-only SQLite run log. The host is its only writer, and durable facts commit before publication. The renderer and the host's provider request consume projections; neither keeps a parallel transcript. [ADR-0011](../adr/0011-run-log-and-state-store.md) owns the storage decision; [StateStore](state-store.md) owns its physical lifecycle.

## Canonical history and live output

Owners: [log projections](../../packages/agent-host/src/log-projections.ts), [telemetry replay](../../packages/agent-host/src/telemetry-replay.ts).

- Keep canonical thread, run, message and tool-call identities through live display, replay, continuation and branching.
  - Readers validate the producer's shape; missing or damaged history refuses rather than becoming an empty thread.
- Complete model steps own durable text and reasoning.
  - Open-step text, reasoning, shell slices and MCP progress are transient telemetry.
  - Late subscribers get bounded in-memory replay with ordinals and explicit omission notices; committed parts replace the overlay without duplicating it.
- A model step and its approval interactions commit together.
  - Tool-call counts recognize the step's assistant calls before exposing its approvals.
  - The stream consumer commits independently, so its copy of a call may arrive in either order. Ledger and child cards count each `(runId, toolCallId)` once across both records.
- Stop, a terminal watchdog abort and orderly host shutdown keep observed partial replies.
  - An unclean exit can lose uncommitted text; recovery records the interruption.
  - A replaced failed attempt contributes no partial reply.
- Raw tool results and artifacts keep their execution identity. Model-output pruning, supersession and compaction are projections; they never rewrite the stored result.
- At start-up `thread/list` answers before Core has folded every thread ([thread listing](../../packages/agent-host/src/thread-listing.ts)).
  - It reads only the event types the list shows (origin, presentation, binding, latest run and its decisions) and folds them with Core's own folds.
  - Every other Core method waits for the full fold. The window re-reads the list when Core's cost views answer, because recovery may have finished a run and the full read may have found damage.

## Accounting

- A run's side calls (its thread title, an Auto-review, a compaction summary) commit the usage each reported under the model it ran on (`model.usage`, `context.compacted`), and count toward that run.
- The context meter describes the latest provider step, not accumulated billed usage. Estimates, unknown cost and unavailable measurements stay labelled; missing cost is never shown as zero.

## Thread state and clients

- Core owns each thread's non-secret model/configuration selection, including CLI and composer changes.
  - Wakes admit from the current committed selection; restart recovery uses the admitted run snapshot ([ADR-0019](../adr/0019-host-thread-run-selection.md)).
- Workspace presentation and execution bindings are separate.
  - Hydrate before saving presentation state, keep outgoing thread state and reject stale async publication.
  - Execution uses admitted live root identities, never saved display paths or a later view's binding.
- Hydration seeds notification baselines without replaying old alerts. Notification preferences and focus are checked at event time; payloads omit message content.
- Follow-up queues are session-lived and scoped to their conversation; inspection panes can't dispatch another conversation's queue.
- Current-schema reopen, deletion and reset are required; historical data conversion is not ([ADR-0020](../adr/0020-greenfield-data-lifecycle.md)).
