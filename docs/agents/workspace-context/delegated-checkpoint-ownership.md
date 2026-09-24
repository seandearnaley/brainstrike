# Delegated workspace checkpoint ownership — evidence

Supports `docs/agents/workspace-context.md` §
"Delegated workspace checkpoint ownership".
Read before changing child snapshot baselines, child file-mutation cancellation, or child root binding (BST-1726).

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

The child input processor awaits its existing host admission, including a
turn-start shadow snapshot before first execution. Child resume/recovery retains
that baseline; recovery before execution finishes any roots whose capture was
interrupted. A legacy child with an existing run but no baseline remains
unrestorable; capture failure records the existing failed-capture sentinel. No
new content journal or persistence store is introduced.

The child header identifies the shared workspace and the per-path file-write
serialization mode. No isolated worktree or automatic merge is implied.
The shared child view provides the existing checkpoint context for its child
thread and refreshes it on terminal host updates. Revert uses the ordinary
conflict-checked IPC operation and survives reopening/reload. It restores only
the selected journaled paths; independent user files remain untouched.

Paired proofs: `assistant-tools-write-staleness.integration.test.ts` uses real
sibling workspace tools and temporary Git repositories,
`delegated-workspace-snapshot.integration.test.ts` covers baseline recovery and
failed/legacy captures, and `delegated-worker-write.desktop.test.ts` opens the
real child, restores its created file, and reloads without replaying the worker.

Child file-mutation callbacks retain Mastra's per-execution `abortSignal` as well
as the host-leg signal. After waiting for the canonical path lock and reading
before-state, they check both immediately before write/replace/delete/rename.
Stopping one child cannot start its queued mutation when the lock is released.
A filesystem operation already started still settles its existing checkpoint
and index attribution; Stop does not roll back completed edits. The real path-lock
cases in `assistant-tools-write-staleness.integration.test.ts` cover all four
mutations, preserved completed bytes, and an unaffected sibling.

A child's explicit bound root also wins over the currently focused folder on
non-Git workspaces. Disconnecting that root is a visible error; neither a new
folder focus nor unavailable worktree capability authorizes switching roots.
The same integration file proves both actual filesystem destinations.

The native executor passes a durable execution thread separately from the
read-state scope; a DB-less scope sentinel never becomes checkpoint ownership.
Tool input cannot choose that identity: strict native schemas reject extra
identity fields and the common execution reader reads only the second, host-owned
context argument. Initial and approval-resumed writes are paired integration
cases, with a distinct host-leg checkpoint run for each. Already stopped native
mutations reject before acquiring a path lock; the post-lock check remains
necessary when cancellation arrives while waiting.

All live desktop initial, approval and suspension-resume requests share the
`handleAssistantPost` initializer and its snapshot dependencies; background work
and active child input retain that runtime. Snapshot Git failure records a
failed-capture sentinel. Admission does not swallow ledger/database failures: a
child must not begin work after its baseline ownership could not be established.
Post-effect checkpoint recording retains its existing error-reporting contract.

Child workspace breadcrumbs require the same FileExplorerProvider as AppLayout.
The live/reloaded child tests mount that provider rather than replacing its
selector. A disconnected bound root displays an explicit unavailable-folder
label, never an opaque root identifier or a replacement workspace.

