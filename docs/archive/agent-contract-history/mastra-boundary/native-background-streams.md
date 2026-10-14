# Native background stream normalization — evidence

Supports `docs/agents/mastra-boundary.md` § "Native background stream
normalization" (BST-1723). Read this before changing `background-stream.ts`,
child cancellation capabilities, or native human-input delivery.


`background-stream.ts` normalizes the native background transport (the host idle
loop's combined stream) before the existing R6 mapper. Native child envelopes still enter the same delegated projection and
`StreamChunk` persistence path. Dispatch acknowledgements are not child results;
terminal parent usage includes all continuation legs and parent text has paragraph
boundaries. Eight native background lifecycle/output types are `normalized` in
the exhaustive inventory. An escaped normalized type receives the normal coded
unknown-part warning; it is not silently ignored. Native EOF with unfinished work
fails visibly. `background-worker-stream.integration.spec.ts` exercises the real
native producer and production iterator, including paragraph, usage, pending
decision, queued Stop and lost-result boundaries.

Selected child controls register a process-local cancellation capability on the
actual Mastra runtime and remove it during disposal. The host revokes durable
admission before invoking it. Native foreground signals compose parent and child
abort signals; background cancellation joins both the actual executor and its
workflow deletion. The existing delegated snapshot owner finalizes only the
selected invocation keys. Native foreground/background tests prove the parent
signal and unrelated siblings remain live, and failures propagate before Stop
acknowledgement. No replacement runtime is created merely to cancel work.

Native human child input uses the installed Agent signal API, not a new delegation
call with a reused thread ID. The native child-message integration proof uses
`createMessageSignal` with a stable ID and `signalToMastraDBMessage` for durable
history, then `child.sendSignal` to an observed active child run. A parent Agent
cannot address that child as its own execution (native acceptance is blocked).
Repeated signal IDs reach the child model once. Idle `sendMessage` wakes the same
native child memory thread, but that native proof alone does not establish the
Brainstrike host admission, budget, decision or human-composer integration.

The native active-child input path uses `childAgent.sendSignal` with a canonical
`createMessageSignal` persisted through native Memory first. `ifIdle: discard`
prevents a raced completion from accidentally waking an unowned continuation.
Root-agent delivery to a child is rejected by native agent ownership; the host
registers the actual persona agent capability and supplies observed native scope.
Signal echo metadata carries the exact observed invocation identity for projection;
unknown/finished child owners fail visibly. Foreground/background native tests
preserve exactly-once model consumption and parent terminal result delivery.
