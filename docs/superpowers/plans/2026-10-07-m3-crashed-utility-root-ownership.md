# M3 crashed utility: Root reuse before the native tail joins

Studio reproduced this on unpublished work based on
`a07e08dc8ce0a0924e4e38df9344ccd0c6798581`, after the private-port loss repair.
The ordinary desktop launches its real utility Root, creates a New Thread,
approves a native file effect and calls a real local MCP server. A later approved
native command starts actual plain Node PID 94985, start 7 October 04:30:05 UTC.
The command handles SIGTERM so the existing executor's physical grace tail is
observable; no product timer or timeout changed. The fixture sends one explicit
SIGKILL only to its verified owned utility PID 94743, start 04:30:01 UTC.

Once the utility is physically absent, a separate contender acquires the same
Root while native PID 94985 is still alive before and after acquisition. The
test requires `RootLockedError` and fails because no refusal occurred. This is
actual filesystem arbitration, not a mocked lease or an inference from an
aborted Promise. The contender releases its acquired lease; final app cleanup
joins all observed owned processes. Cleanup reports errors `[]`, remaining `[]`,
and Root released `true`. No shared profile, credential or security setting was
touched, and no manual cleanup kill was used. The explicit utility kill is fault
injection, not successful product shutdown.

Receipt `/tmp/brainstrike-m3-utility-loss-root-reuse-before.log`: one selected
failure, normal case unselected by `-t utility-loss`, 6.710 s body / 7.84 s lane.
Evidence directory:
`/var/folders/88/jjwxcv3n76x4p7t1xz693qc00000gn/T/brainstrike-m3-app-owned-SNY8x7-evidence/`.
Its `utility-loss-root-reuse.json` records both physical identities and both
lease owners. No unchanged rerun has occurred.

The durable RootLock record names only the utility's PID/start. Its stale-owner
test has no evidence that Main still owns a native executor or cleanup tail.
Main's private-platform owner now aborts and joins the real executor correctly,
but its in-memory selection retention cannot affect a contender's independent
filesystem decision. Retaining a MessagePort Promise therefore cannot preserve
Root arbitration after the recorded writer process dies.

The approved 6 October startup-owner design requires physical ownership through
cleanup. This is a new causal boundary within that class, following its two
historical repairs. No third product patch is started. Root AGENTS rules 1 and 3
require Sean's decision before a repair needing another durable holder identity,
writer, ownership handoff or new arbitration primitive. The original lock and
writer remain unchanged, and the failing test remains active.

The owner decision must identify who retains the existing Root lease after the
writer utility dies, and how every independent contender can verify that fact.
An existing-owner supervisor must retain ownership through actual native tails
and its own teardown; a native process-tree lease would need an approved bounded
spike. Merely recording Main's PID is insufficient if Main can also die while a
native descendant survives. Moving the configured writer PID or introducing a
retainer list without deciding writer/retirement semantics is not a repair.
No option is implemented by this note.

Finite acceptance: the recorded utility-loss case refuses Root reuse until the
native tail joins; Main/client loss also retains or physically joins the tail;
normal cooperative Stop still returns after process exit; rejected cleanup keeps
arbitration closed; and a subsequent real contender can reuse the Root after
successful physical cleanup. Keep PID/start evidence and all original deadlines.

The ordinary non-crash lane separately passed approval, denial, reconnect, Stop,
reload and reopen. It does not qualify this fault. Windows needs its own native
tail shape rather than assuming POSIX SIGTERM semantics. Full M3 acceptance and
full regression remain open. CI is disabled due to cost; validation must run locally.

Owner approval received through parent dot at 06:13 UTC, 7 October 2026. Sean replied "you can proceed with the proposal" to the bundled questions for persisted MCP server binding and an isolated crash-lifetime prototype. Parent supplied the exact transcript; this is the explicit missing owner decision, superseding the prior pending state.

Crash authorization is only for a bounded isolated Mac/Windows prototype and explicit fail-closed recovery where physical cleanup is unproved. It does not authorize silently shipping a production supervisor or lease-format redesign. Parent allocated existing SEAN9 and Mini workers separate task-local native harnesses, 30 active minutes with a 15-minute checkpoint, no production RootLock/Core/durable-format edits. Windows qualifies Job Object lifetime/kill-on-close against physical children/grandchildren. POSIX qualifies crash ownership and reports detached/closed-fd limits. Studio retains production composition; actual prototype evidence must be reviewed before selecting the final design. Preserve the original failing predicate and deadlines.
