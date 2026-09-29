# Human continuation admission — evidence

Supports `docs/agents/database.md` § "Human continuation admission".

Migration 135's receipt/decision-claim model in full: admission refusal codes, ambiguous crash receipts, cancellation fencing, usage attribution, and discovery. Read before changing continuation admission or its refusal vocabulary.

The record below is the original contract text, extracted unchanged.

Migration 135 adds `brainstrike_delegated_continuations` and its exact leaf
`brainstrike_delegated_continuation_decisions` claims. A human wake reuses the
existing authorized native child/resource and immutable profile but has a new
request receipt, managed root host leg, and native run. It never invents a
parent tool call or rewrites the original delegation invocation. The shared
outward graph walk checks every native resource and reports the actual depth.
Read-only `getContinuation(scope, id)` discovery needs no execution host ID.
There is currently no persisted conversation archive field; worktree archive
is a separate contract and must not be mistaken for conversation ownership.

Admission and the existing durable tree/child budget reservation share one
transaction. Input IDs are global immutable request identities (the shared
composer creates a UUID and retains it through uncertain acknowledgement).
Reusing one under another root is an explicit admission refusal and never
reveals, replaces, or replays the other receipt. Duplicate input IDs and overlapping active root admissions fail;
ambiguous crash receipts never automatically resend user input. An existing
identical receipt fails with `continuation-input-already-admitted`; changing
its child/text fails with `continuation-input-id-conflict`. Neither means the
input was undelivered. Only a fresh admission refusal reports
`continuation-input-not-admitted`. The startup
reaper marks dead claimed/running receipts and their decision claims interrupted.
An unclaimed persisted approval/question remains pending for an explicit exact
native decision. A saved native pause after a claimed resume is not proof that
its effect did not run: the crash may precede snapshot acknowledgement. Such
ambiguous claims remain non-actionable; only the owning live host may release
a claim before native execution.
Decision resumes retain the receipt’s originating turn and its existing budget;
the database refuses a claim from a managed host attached to another turn.
Managed run creation resolves that saved turn before inserting a resume host;
a new child input instead anchors its stable request ID. Decision claims retain
the outer native continuation run but consume the exact leaf native run/tool
call, so sibling leaves with identical tool-call IDs remain distinct. Nested
paths start at the continuation child, never the original root invocation;
only the current host may release an unexecuted claim. A claimed resume settles
the previous paused projection header; releasing before execution restores it. Cancellation
fences native binding/resume before joining the existing managed host owner;
a failed join remains a failed Stop, never successful cancellation. A new
explicit message after Stop is eligible for admission; old approval events on
cancelled/failed child runs no longer represent live pending decisions.

Receipt settlement atomically settles the current child projection header,
even when native consumption fails before emitting its terminal event. Stop
preserves already completed native headers and creates cancellation metadata
from continuation identity alone, never from a previous tool event. Cancelled
decision state takes precedence independently of database result ordering.

Ordinary child run headers/events retain rich history. Metadata carries the
continuation ID and native run separately from the display message ID. Usage
uses the existing root-attributed table, one row per continuation/current host
leg with an unambiguous JSON-tuple row identity; cumulative redelivery within a
leg takes maxima and separate resume legs remain additive. The pinned native
runtime reports zero usage at approval/question pauses and its accumulated
usage at completion: two pauses then completion produce 0, 0, 3 tokens for
three one-token model steps. These are observed native finish totals, not
invented per-model-step deltas. Its nullable continuation FK uses `ON DELETE SET NULL` so
child deletion retains spent root tokens. Both receipt tables cascade from the
native graph and are registered in every reset path; reset clears usage too.
Suspended-run HTTP discovery enumerates owned pending receipts even if the
original root has no native pause. Each candidate is reauthorized through the
graph, then an inert native reader verifies its exact saved pending decision;
receipt rows alone never manufacture a resumable control. Independent receipt
and native reads run concurrently; ancestry traversal within each read remains
dependent. Unauthorized/malformed saved state or invalid suspension timestamps
fail discovery visibly rather than return an apparently complete partial list.
Responses preserve
the continuation anchor and annotate durable leaf claim/cancellation state.
Real DB and desktop-host continuation integration tests cover transactional
admission, dumped-engine reconstruction, exact decisions, cancellation join,
usage, child deletion, and production-ledger upgrade/replay.
