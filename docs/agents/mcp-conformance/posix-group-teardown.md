# POSIX process-group teardown — evidence

Supports `docs/agents/mcp-conformance.md` § "Official conformance evidence"
(BST-1557). Read this before changing per-invocation cleanup in
`scripts/run-official-mcp-client-conformance.mjs`. The contract holds the
ruling; this is the measured record behind it, including the Darwin/Linux
kernel difference that makes the `EPERM` arm observable on only one of them.

## The three-valued teardown ruling, as landed

Every child inherits that owner. Per-invocation cleanup remains isolated on
POSIX, where group teardown is three-valued and must stay that way (do not
relitigate): `ESRCH` is the only proof the group is gone, while `EPERM` from
`kill(2)` against a group of our own descendants is inconclusive rather than a
denial. It reports the post-reap race in which the group's only remaining
members are killed-but-unreaped zombies, so it polls on exactly like a live
group. Failing the invocation on it surfaced a normal teardown window as a
spurious `cleanup failed` and could mislabel a passing scenario; reading it as
success is unsound in the other direction, because a process group outlives its
leader. The ruling ports but its mechanism does not, and both halves were
measured: Darwin's `killpg1()` drops zombies from its signalable count and
answers `EPERM`, while Linux keeps unreaped members in the group until
`release_task()` and simply succeeds. So the `EPERM` arm is observable only on
Darwin, and the paired test asserts the kernel-appropriate not-gone state
rather than `EPERM` everywhere. A group still unsignalable at the confirmation
deadline is a real permission failure — a descendant that changed credentials,
or a reused pid — and the teardown error names the state it gave up on so the
two are distinguishable. Same ruling as
`packages/agent/src/fence/fence-executor.ts`, pinned by
`scripts/__tests__/run-official-mcp-client-conformance-process-group.test.mjs`.
