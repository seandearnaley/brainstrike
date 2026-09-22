# Abort finalization and the native-stream join — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION". Read this before proposing to change the abort-persistence seam, its ordering against Mastra cleanup, or the settle deadline.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Mastra deliberately skips its normal finish writer (`executeOnFinish`) when an
abort signal wins. Since Mastra >= 1.62 (upstream #22243; BST-1667 moved core
to 1.64.0) that is no longer the whole story: the `MessageHistory` output
processor persists a cancelled run's transcript through normal output
processing (`processOutputResult` → `persistMessages` →
`storage.saveMessages`, partial tool calls filtered), the
`persistPartialOnAbort` opt-in is gone because cancellation persistence is no
longer optional, and that write is NOT awaited by the aborted loop. Measured on
the live-loop PGlite proof
(`packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts`):
a user Stop landing right after a tool result carries the completed tool work
and no partial text; a watchdog abort persists the stalled attempt's partial
text as its OWN assistant row; an approval-resume cancel persists the partial
text. That live-loop proof and the ordinary `PgliteMemoryStore` integration
cases start from `createAgentMemoryTestDb()`: one pristine schema snapshot
supplies immutable bytes, while every case receives a fresh database. This
removes repeated schema bootstrap from assertion timing without sharing mutable
state. The store's cold initialization and transient-failure cases remain
explicit empty-database/mock paths, and reload/abort cleanup still runs through
the real PGlite and Mastra persistence owners.

For terminal watchdog aborts and user cancellation only,
`packages/agent/src/mastra/aborted-turn-persistence.ts` (created by
`createRuntimeAbortedTurnPersistence` in `turn-attempts.ts`) therefore owns one
bounded abort-finalization seam over Mastra's public live `MessageList`: it
drains the unsaved messages, keeps the user input and every assistant message,
REMOVES tool invocations that never completed (Mastra filters partial tool calls
from its own write and the seam must not re-introduce one, or Stop could
resurrect execution on the next turn), RETAINS partial text (dropping it cannot
remove the row Mastra already wrote, and a snapshot that disagrees with the UI
transcript is the BST-1415 failure), drops assistant messages left with only
`step-start`, appends the model-visible
`[Assistant turn aborted before completion.]` marker as the last text part of
the last retained assistant message (or as a standalone assistant message when
none remains), and awaits `Memory.saveMessages` before disposing the per-run
runtime — including when a recovery continuation fails during construction.
Re-saving ids Mastra already wrote is an upsert of identical content. Under
Contract A the partial text tail is therefore RETAINED; only incomplete TOOL
work is excluded. The awaited save is also load-bearing as a join: with
`shouldPersist` forced false (measured 2026-09-06), Mastra's floating
abort-time write raced the PGlite `close()` in suite teardown and wedged the
vitest worker at 100% CPU — the BST-1320 mechanism. That save joins Mastra's
transcript write only. Mastra's post-run snapshot cleanup (`deleteRunSnapshots`:
two `DELETE FROM mastra_workflow_snapshot` statements) is awaited before the
agentic loop closes ITS stream, so it is settled only for a caller that reads
the native stream to its end; an attempt abandoned early — watchdog, Stop, or
a consumer's `.return()` — leaves it floating past the end of the turn. Traced
2026-09-12 (BST-1221, `mastra-memory-persistence.integration.spec.ts`): the
second DELETE's Bind landed after `close()` had already deactivated the
backend, trapped, and the stock PGlite loop spun the worker forever; which
import layout the process happened to have decided the microtask order, which
is why the wedge looked layout-dependent. The turn owner therefore joins
Mastra's own consumption of every attempt's native stream — each
`TurnAttempt.settleNativeStream` (`settleNativeStream` in
`packages/agent/src/mastra/turn-attempts.ts`) awaits `consumeStream()`, which
resolves once the base stream has closed, after that cleanup — BEFORE the
abort seam's awaited save and before `runtime.dispose()`. The order is
load-bearing: Mastra's cancel persistence writes inside that window, and the
seam then captures the list Mastra finished with and appends the marker to its
last assistant message as an upsert of Mastra's own id, so the marker is the
last thing the model reads. Saving first puts the marker on the completed
tool-work row while Mastra's later partial-text rows order after it (measured
2026-09-12). By the time the join runs the attempt's abort context is disposed,
so the stream's abort is the expected ending and is recorded at debug
(`mastra_native_stream_settled_with_error`); a failure that surfaces only
during settlement — a failing snapshot DELETE, a persistence error in Mastra's
cancel write, or a `consumeStream` that rejects outright — is recorded at warn
under the same code, never thrown a second time. The expected ending is the
abort reason itself, an error one `cause` hop from it, or any error named
`AbortError` — a deliberate widening: an unrelated inner abort (a tool's own
`fetch`, say) is bucketed as expected and lands at debug, so abort-shaped
failures do not reach warn. One failure is recorded once, but a genuine
failure that surfaces after the abort record still reaches warn. The spec case
"settles Mastra snapshot cleanup before a watchdog-aborted turn ends" holds each
cleanup statement open and asserts the turn cannot end while one is pending or
still to be issued; removing the join makes it fail. The join also made the
watchdog-abort transcript read deterministic: a stalled attempt replaced by a
continuation that stalls again leaves EACH attempt's partial text as its own
Mastra row (four rows, marker on the last); the earlier three-row expectation
had raced the second attempt's write. The same join exposed a
second latent gap: Mastra's MessageHistory processor and per-step save read
`readOnly` from the REQUEST memory options only, so a Memory whose DEFAULTS are
read-only was still written on cancel (the write had previously been lost in
the teardown race, which is the only reason the read-only-defaults case was
green). `resolveMemoryOption` now carries the merged thread config's `readOnly`
onto the request options, so Mastra and the seam enforce the same policy
(`resolveMemoryOption` returns a branded `ResolvedAgentMemoryOption`; the seam
accepts nothing else, so a hand-built option cannot fail open). The join is
bounded: `settleNativeStream` raises the attempt's abort itself and waits at
most `NATIVE_STREAM_SETTLE_DEADLINE_MS` (30 s) for the native stream to close;
a stream that ignores its abort — a hung provider socket, a tool that never
returns — must not hold disposal hostage, so past the deadline it records
`mastra_native_stream_settle_timeout` at error level and disposal proceeds,
with the vitest event-loop watchdog and PGlite's fail-closed trap as the
backstops for the leaked pipeline.

Initial, approval-resume,
and suspended-tool resume streams share this Brainstrike-owned terminal seam;
read-only memory streams skip it and remain write-free. If the snapshot write
itself fails, the seam emits the structured
`mastra_agent_aborted_turn_persist_failed` server error and preserves the turn's
existing terminal chunks and cleanup instead of throwing after termination. A
normally finished turn marks the seam closed before teardown, leaving Mastra's
existing writer exactly-once. The live-loop PGlite proof covers normal
completion, watchdog abort, user Stop, resumed streams, next-turn recall, and
non-reexecution of completed tools; the unit proof
(`packages/agent/src/__tests__/aborted-turn-persistence.spec.ts`, two cases)
pins the content rule. An individual provider attempt that stalls but is
replaced by a successful continuation is not an aborted turn and does not
persist an abort snapshot; abort finalization runs only when the turn itself
becomes terminal.

The same terminal owner also joins delegated child snapshots (BST-1719). Native
delegation sets `lastMessages: false`, so the child cannot rely on automatic
MessageHistory output persistence. Capture the child's public native MessageList
at Stop and await the native `afterToolCall` hook before re-saving that snapshot:
saving before completion allowed a late native write to restore a tool result
and erase the abort marker after the root had returned. All captured child saves
settle even if one fails; the root still attempts its own snapshot and the
existing coded abort-persistence failure reports the errors. No second transcript
store or client-generated child prompt/message id is introduced. Child snapshots
also finalize at a replaced watchdog attempt, independently of the root's
successful-continuation policy, and before runtime disposal. Their content is
frozen through the same JSON representation as the memory store, so a value
accepted by normal storage is not rejected merely by `structuredClone`.

