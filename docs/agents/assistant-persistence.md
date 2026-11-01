# Assistant persistence

Desktop history belongs to the host's append-only SQLite run log. The host is its only writer, and durable facts commit before publication. The renderer and the Mastra memory adapter consume projections; neither keeps a parallel transcript. [ADR-0011](../adr/0011-run-log-and-state-store.md) owns the storage decision; [StateStore](state-store.md) owns its physical lifecycle.

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

## Memory and accounting

Owners: [host memory adapter](../../packages/agent-host/src/adapters/state-store-host-memory.ts), [memory failures](../../packages/agent-host/src/adapters/memory-failure.ts).

- Mastra memory is a run-owned library adapter over committed host history and the existing StateStore writer. It creates no transcript store or permission authority.
- Recall from other threads includes settled turns only; active or suspended work is not completed provider history.
- Settlement (as Mastra documents for `Memory.settled()`):
  - `run.finished` commits once the answer and the memory's foreground work have joined.
  - Buffered observation and reflection join afterwards; their usage still counts toward that run.
  - The thread's next run, rewind or wake first joins that settlement; deletion and shutdown cancel and join it.
  - A failure after the end is its own `memory.settlement.failed` fact; the run's outcome stands.
  - A run owner without that foreground phase joins whole before its end.
- Each observation and reflection cycle commits one `memory.cycle` fact from Mastra's lifecycle hooks.
  - The agent host installs the hooks next to its provider enclosure, so Core stays the only writer.
  - The fact records the trigger, the outcome (`completed`, `failed`, or `cancelled` by Stop), duration and reported usage. A failed cycle also records its typed `memory.*` code and the reference its cause is logged under.
  - A buffered cycle's failure reaches only its end hook, so this fact is where it first appears.
- Spend is billed from `memory.usage` alone.
- Semantic recall diagnostics (messages returned, `topK`, scope, latency) are live `run/telemetry`, never a fact (ADR-0011 amendment of 2026-10-19).
- Semantic recall runs once per turn, on its first step (as Mastra's recall runs once per agent call in `processInput`); observation and the history window still follow each step.
  - A failed recall is not the turn's outcome: the turn answers without recalled history, and the typed failure commits once as `memory.recall.failed` with its cause's log reference. The timeline shows it as an always-visible notice.
- Keep observations inside the selected chat provider's privacy boundary ([ADR-0013](../adr/0013-observational-memory.md)), with concrete resolved models and explicit credential authority.
  - Observer and reflector usage counts in billing and spend totals.
  - A rewind keeps observation residue; branched history withholds observations it can't attribute safely instead of guessing what to remove.
  - Strict deletion and reset also erase affected memory.
- A memory failure carries a typed `memory.*` code at the step or admission that found it (observer, embedder, vector store, configuration or credential).
  - It is never classified as a chat-provider error, and it names the memory model's own provider.
  - Its correlation id shows in the failure row and the send gate. The agent host forwards its error records, with those ids, to Main's diagnostics so the debug pack finds the cause.
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
