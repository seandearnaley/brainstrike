# Session lifecycle, the deadline, and process-group teardown — evidence

Supports `docs/agents/code-execution.md` § "FenceExecutor". Read this before
changing the serialization queue, the entry-scoped deadline, the SIGTERM →
SIGKILL → signal-0 confirmation sequence, or the treatment of `EPERM` from the
probe. The contract holds the rules; this file is the record of why, including
the BST-1437 follow-up measurement.

- **Session lifecycle: initialize ONCE per process, `updateConfig` per
  execution.** `SandboxManager` is a process-global singleton — a second
  `initialize()` is a no-op, and its network proxy reads the module-level
  config at *request* time. So the wrap-time `customConfig` override alone
  would leave the proxy filtering on a stale allow-list; both are applied.
  Because that state is global, executions are SERIALIZED process-wide (a
  module-level queue) and executors are refcounted: `dispose()` calls
  `SandboxManager.reset()` only when the last one goes away.
  `cleanupAfterCommand()` runs after every execution (it clears bwrap mount
  points; inert elsewhere, but one code path).
- **The deadline starts when `execute()` is entered, not at spawn.** Because
  executions are serialized, a spawn-scoped timer would silently mean
  "queue wait + `timeoutMs`" and a caller behind two other runs could not tell
  a queue from a hung fence. If the whole budget elapses while queued, nothing
  is spawned and `FenceQueueTimeoutError` is thrown — never a fabricated
  `ExecResult` for code that did not run.
- **Timeout kills the whole process TREE, and no successful path settles before
  the group is down.** Children are spawned `detached: true` (so the child is a
  process-group leader) and the timeout signals the negative pid: SIGTERM,
  then SIGKILL after 500 ms. Sending SIGKILL is not itself proof of teardown:
  settlement waits up to 500 ms for a signal-0 probe to report `ESRCH` for the
  process group, so a runnable descendant cannot land one final side effect
  after a successful result. That confirmation is bounded because a zombie,
  uninterruptible process, or `EPERM` probe must not deadlock the process-global
  execution queue.

  **`EPERM` FROM THE PROBE IS INCONCLUSIVE, NOT A DENIAL — do not relitigate.**
  Every member of the group is our own descendant running as us, so a genuine
  permission failure is impossible; the same reasoning is recorded at
  `apps/desktop/src/terminal-ipc-handlers.ts` for its own group kill. What
  `EPERM` reports is the post-reap race — the leader is a just-SIGKILLed zombie
  and the kernel refuses to route a group signal through it. Measured against
  the real sandbox fence on macOS, the group reaches `ESRCH` about 7 ms later.
  Treating that first `EPERM` as fatal rejected EVERY normal teardown on that
  host (the BST-1437 follow-up).

  So `EPERM` polls on exactly like `alive`, and ONLY `ESRCH` returns. Returning
  early on `EPERM` would be unsound in the other direction, however it is
  corroborated: a process group can outlive its leader, so "the leader is gone"
  never proves the group is empty. An `EPERM` that survives the whole window is
  still a teardown failure, so the fail-closed guarantee is unchanged — a
  tracked group is released only by `ESRCH`. Failure rejects with `FenceProcessGroupTeardownError`; a
  completed `ExecResult` is attached as `outcome`, while cancellation remains
  an `ExecAbortedError` with the teardown error as its `cause` and partial output
  intact. The failed group remains tracked, and later executions fail closed
  before installing another process-global policy until `ESRCH` proves it gone.
  The timeout path shares one memoized SIGKILL confirmation rather than starting
  a second poll from its hard backstop. `timedOut` is set; the exit code is
  `128 + signum` when no code is available. Settling on `'close'` alone would
  be a bug: a descendant that detaches its stdio closes our pipes while still
  running, so an early settle would clear the pending SIGKILL and return with
  that process alive — free to still be running when `updateConfig()` installs
  the NEXT execution's allow-list. So `'close'` only settles once the root's
  exit status is known, and the settle path itself SIGKILLs the group. Two
  proven tests cover this: a grandchild does not outlive a timeout kill, and a
  detached-stdio descendant does not outlive a normal completion. Live groups
  are also reaped on the host's `process exit` event —
  `detached` means a run would otherwise outlive the timer that bounds it.
  **Residual risk**: a hard crash of the host process (SIGKILL) cannot run
  that reaper, so a sandboxed run would keep going — still inside its fence,
  but unbounded. Removing that needs an out-of-process supervisor, not a
  change here.
- **Capture honours the request's `maxOutputBytes`**, not a backend constant,
  and COUNTS what it drops into `stdoutOmittedBytes` / `stderrOmittedBytes` —
  per stream, so 1 KB of loss is distinguishable from 100 MB. Bytes past the
  cap are dropped rather than buffered (a runaway loop must not exhaust
  memory) while the pipes keep draining so the sandboxed process never blocks.
  The tool layer still owes its own model projection budget
  (docs/agents/assistant-providers.md).
- **Cancellation**: `input.signal` is honoured while QUEUED as well as while
  running — pressing Stop behind two other executions must not wait for them.
  Either position throws `ExecAbortedError`; the mid-run path kills the group
  first and carries the partial output on the error. Both are tested, and the
  real-fence test asserts a grandchild does not outlive the abort.
- **Capability reconciliation**: `execute()` re-parses `execInputSchema` and
  calls `assertExecRequestSatisfiable` before touching the filesystem, so a
  caller that bypassed the seam still cannot reach a spawn.

The integration suite skips only with a message naming exactly what is
missing (platform, srt dependency, interpreter, or unsandboxed reachability of
the probe URL) — never by weakening an assertion. The reachability guard
matters in both directions: without it the allow-list test fails RED on a host
with restricted egress, AND its sibling network-deny test would pass
VACUOUSLY, asserting a leak guard it never actually exercised.
