# Scoped child stream hydration — evidence

Supports `docs/agents/assistant-persistence.md` §
"Scoped child stream hydration". Read this before proposing to change child header settlement, awaited lifecycle persistence, or tool-boundary anchoring.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Native Mastra memory remains the sole child transcript writer. The desktop run
event observer routes scoped child lifecycle events through the delegated
repository's atomic authorization/header/event mutation into the existing
thread-run/run-event tables. A native invocation plus current root host leg
gets its own opaque child host-run id; the root turn id is not a child user
message id, so the nullable child header field stays unset. Usage remains in
the existing root-attributed writer and is not duplicated for these headers.

When that native invocation reaches a terminal outcome, its earlier host-leg
headers can still be running after a parked approval. The authorized terminal
event atomically settles those prior running headers to the same outcome. The
match requires child resource/thread plus native parent run, tool call, child
run and persona from retained events; it cannot close a different invocation
in the same thread. No duplicate terminal event is minted and existing terminal
headers are immutable. A rejected current event cannot settle prior headers.
Paired: `delegated-conversation-insights.integration.test.ts` and
`delegated-deadlines.integration.test.ts` (approval-resume then expiry/reload).

Child lifecycle persistence is deliberately awaited before publication. It
revalidates the invocation and makes the published event durable; an exhausted
write or identity failure propagates through the root error path. The root's
queued writer also fails at final flush, rather than tolerating lost events.
This child path introduces database backpressure at lifecycle boundaries;
ordinary text/reasoning deltas do not perform database round trips. Native
memory's transcript ownership does not make lifecycle authorization optional.

Events retain observed native message identity in sanitized metadata. The
shared history adapter assigns these events by row id before applying the
legacy run-window heuristic, permitting several resume legs in one assistant
group. An observed message outside the loaded window is never assigned to a
different turn. The normal session buffer replays encoded scoped frames without
remapping; the normal assistant-stream decoder consumes child frames.

For a scoped child's `tool.started` event, the observed native message id and
tool-call id anchor the event **after** its persisted tool part, matching the
shared live encoder. Millisecond timestamps cannot establish this boundary:
text, reasoning and a tool start can share the same time, and timestamp weaving
alone moved the event ahead of all three. The shared hydrator preserves content
and journal order while waiting for that specific tool boundary: the anchor
blocks the event queue, so later journal entries cannot overtake it. Exact native
row-to-group assignment happens before tool anchoring, including when different
turns reuse a tool-call id. A final tool part releases its queued events through
the existing trailing flush. Tool-call deduplication is scoped to one assistant
group: snapshot rows of that turn still merge, while later turns and regenerated
siblings retain their own same-id tool parts. Legacy events keep their existing
time-based placement. A cancelled call whose unfinished
tool part was removed still retains its journal events; hydration never invents
that missing tool part or drops its failure history.

Scoped `tool.completed` and `tool.failed` events also wait until their own tool
part has been emitted, including when the loaded journal contains no matching
start. This is a lower bound, not a replacement timestamp: terminal events
still wait for their recorded time so text emitted while a tool ran remains
before its completion. Journal order is preserved for following legacy events.
The paired history tests cover both terminal kinds with tied timestamps and
no start, mixed legacy events, and text emitted during tool execution.

`delegated-stream-parity.integration.test.ts` compares text, reasoning, tool
name/id/input/result and every lifecycle data payload in order from the real
native desktop stream with the current and reconstructed memory engine. The deterministic hydration tests cover tied
timestamps, two distinct tool boundaries, native grouping with reused tool ids,
a final tool event tail and a removed cancelled tool part. Decoder-private
fields and ephemeral tool runtime fields are outside that parity assertion.
This proves the tested normal turn; changed native ids across resume and full
receiver/replay remain separate BST-1719 acceptance.

The host returns sanitized metadata to the live stream as well as storage.
On snapshot resume, a parent wrapper can precede its own native message id.
Atomic invocation binding returns its latest previously observed message id
from the existing event journal, restricted to the exact native run, parent
call and persona. Projection uses that id until Mastra supplies the current
one. A missing identity fails before child projection state is registered;
termination never invents a transcript id or silently drops an event.

Paired proofs: desktop `delegated-runtime.integration.test.ts` (real native
transcript, shared hydration and engine reconstruction),
`delegated-conversation-host.integration.test.ts` (host ownership, pins,
idempotency and resumed event grouping), and agent `data-stream-session.spec.ts`
(decoder and byte-identical replay). These do not claim packaged UI parity or
cancelled child transcript durability; those scenarios remain tracked.

