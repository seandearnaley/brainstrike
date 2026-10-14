# Delegated conversation graph storage — evidence

Supports `docs/agents/database.md` § "Delegated conversation graph".

Migration 126's graph, its cascade semantics against the Mastra tables, and the pre-activation host notes. Read before changing delegated deletion or re-parenting rules.

The record below is the original contract text, extracted unchanged.

Migration 126 owns `brainstrike_delegated_conversations`; its `ledgerKey` is
registered in the numbered manifest and consumed by the production Drizzle
runner. The graph records an immutable root anchor and child nodes keyed by
actual native thread id. Root owner, immediate parent, native resource,
configuration, display identity and workspace snapshot are separate columns.
The composite parent foreign key forbids linking a node across root/owner
boundaries. The repository creates children only beneath existing ancestors;
it exposes no reparent operation and conflicting duplicate delivery fails.

Unlike the older FK-less presentation sidecars, this graph references
`mastra_threads`: migration 117 already guarantees that table exists before 126,
as it already does for the run tables in migration 118. Native thread deletion
cascades its graph node and descendant graph nodes. That FK alone does **not**
delete descendant native transcripts. The single/bulk assistant commands and
native memory-store override now expand the requested branch through the shared
`DELEGATED_THREAD_DELETE_CTES` selection, then delete every native transcript and
ordinary sidecar and emit one mind-op per actual deleted native thread. The
selection verifies the live root, every ancestor and every descendant resource;
an ownership mismatch rejects the entire command without partial deletion.
Bulk unknown-id validation still gates all changes, including overlapping
requested branches. A standalone Mastra store legitimately has no graph table
and retains its existing single-thread behavior after its table probe.

All three table-enumerating clear/reset paths explicitly clear the graph; it is
in the shared reset registry. Root anchors contain no copied presentation or
workspace state. A new direct child snapshots the root's current canonical
`operatingRootId`; nested children inherit their immediate parent's snapshot.
Re-delivery preserves the existing node, including its original workspace.
Configuration must survive a JSON round trip without coercion or omitted data.

The real-PGlite suite `delegated-conversations.integration.test.ts` covers
concurrent duplicate delivery, same-persona siblings, ownership, nested scope
changes, workspace changes, graph deletion, legacy absence, a dumped database
loaded in a new engine, and production-ledger upgrade/replay. The desktop host
uses this graph together with invocation identity, lifecycle correlation and
usage attribution below.

Delegated graph reads authorize against current native scope. A scope change hides
the branch; restoring the exact native scope restores visibility. This storage
layer does not promise permanent revocation or garbage collection. The host must
source child write identities from observed native delegation, never caller ids;
thread creation timestamps are not proof of ownership or delegation.

Before production host activation, note that createChild revalidates current root
workspace metadata even on duplicate delivery. Malformed current metadata rejects
a duplicate write; get still returns the original authorized binding. The host
must distinguish reading an existing invocation from creating a new one and must
not use duplicate createChild as a substitute for resume authorization.
