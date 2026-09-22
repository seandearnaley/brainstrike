# Managed opaque workspace leases — evidence

Supports `docs/agents/workspace-context.md` §
"Managed opaque workspace effects".
Read before changing workspace leases for native shell/skill processes or delegated command sessions (BST-1726).

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

Finite native shell and skill processes acquire an exclusive lease on their
canonical declared workspace root until actual process settlement. Queueing and
execution share the existing call deadline; an expired waiter never spawns. Native file
mutations acquire a shared workspace lease around their existing ordered
per-file locks, including staleness/capture/write/checkpoint/index settlement.
Overlapping parent/child root paths conflict; disjoint roots and disjoint file
mutations without an opaque owner retain concurrency. Queued cancellation
refuses execution before any effect. Skill runtime resolution plus lease wait
continues to share its original timeout budget. Expiry names both runtime preparation
and workspace ownership, including a resolver that settles only after the budget.
Admission expiry and cancellation
produce trusted model-visible no-execution errors; a session conflict preserves
the owning session ID and process-exit requirement through the ordinary tool guard.

A long-lived **delegated** command session retains its exclusive lease until
PTY exit. A conflicting managed edit/process fails visibly with the session ID
and the requirement to wait for process exit before editing; it is never queued indefinitely
or silently applied later. This is a stop/edit/restart workflow when the child
chooses a persistent process. The existing Command sessions surface can stop
the named session, and selected child Stop joins the sessions owned by those
host-observed native child identities before acknowledging completion. That
ownership lives in the existing process manager, not a parallel registry.
Lease release follows actual exit; a failed stop cannot release uncertain work.
A root/global disposal timeout retains the exit observer even after inventory
removal, so a later actual exit releases ownership without exposing live work. The
conflict message does not direct the user to a control that has already retired.

Ordinary root/user command sessions retain their existing dev-server/edit flow;
this lease does not claim to serialize arbitrary user-owned background servers
or external processes. Shell cwd checks remain the existing containment rule,
not a sandbox: command bodies are unrestricted after permission. Remote MCP
servers own their own filesystem scope and cancellation semantics; arbitrary
tool input or metadata never establishes client-side workspace confinement.
The real HTTP MCP worker fixture proves an approved server-owned disposable
file effect once, preserves dirty/sibling files, refuses replay, and prevents
execution when the pending worker is stopped before dispatch.

Native delegated thread IDs may exceed a filesystem/ref component length at
three levels of recursion. Snapshot ownership retains the exact native ID in
the existing ledger and commit metadata; the Git lineage key is bounded as
documented in changeset-diff.md. Never increase root directory validation limits
or truncate native identity to make a recursive child snapshot fit. Real delegated
capture/recovery and selected-path restore preserve independent user/sibling files.

