# Renderer child conversation receiver — evidence

Supports `docs/agents/assistant-runtime.md` § "Renderer child conversation receiver".
Read before changing `BrainstrikeDataStreamRuntimeAdapter`'s scoped-envelope handling, receiver lifetimes, or child failure precedence. BST-1719.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4620-4668), extracted verbatim.

`BrainstrikeDataStreamRuntimeAdapter` consumes scoped envelopes when the
`onDelegatedConversation` consumer is supplied. The panel and stable runtime
hook forward the current callback. Each native invocation owns one installed
`DataStreamDecoder` and `AssistantMessageAccumulator`; changing the observed
native message id does not replace that decoder or lose an open tool input.
Descendant envelopes use the same receiver recursively. Child tools are decoded
from host results, never executed against the parent's client tool registry.

Updates are ephemeral full snapshots with the immutable native invocation
coordinates and latest observed native message id. Consumers replace state for
that invocation on replay. Native memory remains the only transcript writer;
this layer adds no store, migration, endpoint, synthetic native identity or
parent-model budget change. Parent part indices and existing auxiliary data
remain intact; child text never becomes parent text. Rendering these snapshots
in child tabs and associating them with durable graph threads remains BST-1724.

A receiver lifetime starts at the matching native opening frame. Full session
replay builds fresh decoders and replaces snapshots, without a new model POST.
An unseeded suffix or mismatched opening identity fails visibly instead of
presenting an incomplete prefix as a complete transcript. Seeded suffix replay,
real nested approval/resume and artifact recovery remain BST-1719 acceptance.

Normal child error frames stay in that child. Missing child terminals produce
an incomplete child snapshot and fail the parent transport visibly. The response
owner settles every child pipeline even when an upstream fault bypasses stream
flush. Cancellation gates callbacks and drains vendor tool substreams through
normal closure, preserving the existing stream-insulation contract. No sleeps,
retries or timeout changes establish these lifecycle guarantees.

The public adapter tests cover concurrent children sharing tool ids, changed
observed message ids with partial arguments, recursive descendants, replay
replacement, malformed openings, partial updates, transport failure and abort.
The desktop native parity fixture now drives the public replay adapter directly
with the real host response; it no longer extracts child frames by hand. Its
content/lifecycle assertions still match native memory after reconstruction.

Receiver completion uses the same `deferMessageFinishUntilFlush` transform as the
parent. Both final part streams and descendant receivers settle before a complete
snapshot is published. Producer failures/cancellations still emit their required
`d` finish frame; an error frame alone is a truncated stream, not a valid child
terminal. Cleanup preserves the primary transport/envelope/abort failure and logs
secondary settlement failures once. Consumer presence selects receiver installation
at run start; an installed receiver reads the latest committed callback on each
update, including callback replacement during an active run.

Within a child receiver, the first observed failure remains authoritative across
observer, decoder, writer-close and descendant settlement errors. The paired
regression throws in the observer before a malformed subsequent frame fails
the decoder; the original observer error still reaches the response owner.
