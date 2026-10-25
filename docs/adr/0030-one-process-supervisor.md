# ADR-0030: One process supervisor; the OS exit is the only completion

- **Status:** Accepted (Sean adopted all five stages, 2026-10-25)
- **Date:** 2026-10-25
- **Amends:** [ADR-0026](0026-lifecycle-readiness-liveness-joined-quit.md) (R2 and R5 are held
  by one implementation instead of each owner), [ADR-0027](0027-canonical-electron-quit.md)
  (a killed git ends with its whole tree, not only its launcher)
- **Follows:** [ADR-0017](0017-cli-first-agent-host.md), [ADR-0029](0029-main-is-a-launcher.md)

## Context

Windows stop, close and quit failures kept arriving one at a time. Measured on `main` at
f93e0253, they share three causes.

1. **No single owner of a process's life.** About 20 owners each write their own spawn,
   close request, kill and exit wait: agent host, indexer, index query reader, egress proxy,
   embedding host, renderers, terminals, LSP, git, gh, ripgrep, worktree setup, command
   sessions, agent commands, fence, hooks, host state index, CLI starter and test fixtures.
   They use four ways to kill a tree (`tree-kill`, `process.kill(-pgid)`, a per-command Job,
   nothing) and seven grace values from 500 ms to 30 s. ADR-0026's rules are prose, so each
   owner drifts back to a short clock tuned on a fast machine. Its own example, a 1.5 s
   attach bound, survived in `host-lease` until #4308.
2. **POSIX kill semantics on Windows.** Windows refuses to terminate a process that is
   already exiting, so Electron's `kill()` returns false; the indexer transport called that
   `indexer-kill-failed` and blocked the index for good (queue run 40164820640). Windows has
   no process groups, so killing a launcher or shim leaves the real program running (the
   Chocolatey `rg` shim, #4306; `cmd\git.exe`, ADR-0027). Electron reports a utility's `exit`
   before the OS exit, so Main polls the process start time every 25 ms. `process.kill(-pid)`
   and inherited flocks are POSIX only.
3. **Containment stops at the agent host.** The host joins a kill-on-close Job at startup
   (ADR-0017), so its tree ends with it, and agent commands run in their own Job. Main's own
   children (ripgrep, git, gh, LSP, terminals) have none: Node's job kills a direct child when
   Main dies, but lets its children break away. And while an owner lives, ending a tree
   ends only its root on Windows, so a timed-out shim leaves its real program running.

ADR-0027 rejected an app-wide Job for Main. This ADR keeps Main out of one, for a reason of
its own (decision 2).

## Decision

1. **One supervisor per owning process.** Main, the agent host and the CLI host start every
   child through one supervisor: Electron utilities through one fork helper in Main, Node and
   native children through `spawnNativeChild`. Owners keep their protocol (what close means)
   and lose the mechanics (kill, wait, clock).
2. **Containment at spawn.** On Windows the agent host keeps its kill-on-close Job
   (`windows-job-native` `initialize()`, also the call the E2E launcher makes), so the OS ends
   everything under it however it dies. Main does not join one: `shell.openExternal` can
   start the user's browser as Main's child, and a Job would close it with the app. Main's
   Electron children already end with Main, and its Node children move to the host under
   ADR-0029. Ending a tree while its owner lives uses `terminateTree` (`tree-kill`, which runs
   `taskkill /T /F` on Windows) for every third-party child, so a launcher or shim never
   leaves its real program running. A persistent CLI host is started by a CLI that holds no
   Job, and is its own owner. On POSIX each child leads its own process group, and our own
   Node children hold a lifeline pipe that ends them on EOF. The inherited Root flock stays
   (ADR-0017).
3. **The OS exit is the only completion.** A child is gone when its process (or Job) handle is
   signalled on Windows, or it has exited and been reaped on POSIX. Terminate is a request:
   its result is logged and never acted on. A refused terminate is not a fault, and no owner
   is retained or blocked because of one.
4. **Two constants, both owned by the supervisor** (`@brainstrike/state-store`):
   - `CHILD_CLOSE_BUDGET_MS` (30 s, ADR-0026's owner-decided host value): our own children
     are asked to close, and the window runs from that request to their exit, not to an ACK.
     After it, the tree is terminated and the exit is still joined.
   - `CHILD_SIGNAL_GRACE_MS` (2 s): third-party trees are terminated at once on Windows; on
     POSIX they get SIGTERM, then SIGKILL after the grace. A terminated child whose exit has
     not arrived after the grace is logged, and still joined.

   Startup keeps one user-facing deadline (`HOST_STARTUP_TIMEOUT_MS`), which refuses that
   start alone. No other lifecycle constant exists.
5. **Quit is the supervisor closing its children in dependency order**: factory reset,
   renderers, host stop, utilities, database (ADR-0029's end state).

## Stages

Each stage ships alone and deletes more than it adds. A stage starts only after the previous
one met every done criterion below.

1. **Exit is the only completion.** The two constants; the indexer transport's one close
   window and its refused kill as a request; the agent host and host state index on the
   budget. Deletes `indexer-kill-failed`, the post-ACK exit window and the retained
   lifecycle error.
2. **Tree termination.** `terminateTree` for every third-party tree (ripgrep, LSP, git, gh,
   worktree setup, command sessions, terminals), and `endTreeOnDeadline` for every bounded
   child; on Windows the exit joined on the process handle (`waitForProcessExit`) instead of a
   start-time poll.
3. **Every remaining lifecycle timer onto the two constants**: egress, embedding host, index
   reads, fence, command sessions.
4. **POSIX lifelines and test fixtures** spawn through the same supervisor; the launcher
   watchdog's shell loop goes.
5. **Quit shrinks** as ADR-0029 moves services into the host, which uses the same supervisor.

## Interim patches each stage removes

The end state replaces the point fixes; it does not sit on top of them. At the end, a search
for each name below finds nothing.

| Stage | Removed |
| --- | --- |
| 1 | The indexer's post-ACK exit window (`exitMs`, 1 s, then 30 s in #4308), `indexer-kill-failed`, `IndexerLifecycleError` and the retained-owner path, the host state index's 1 s close and 1 s exit, `KILL_GRACE_MS`, `HOST_COOPERATIVE_CLOSE_MS` |
| 2 | Hand-written tree kills (`killTree` and its `TreeKill` seam, the terminal's own `tree-kill` call, worktree setup's launcher-only kill on Windows), `timeout` and `signal` options on `spawn`/`execFile` that kill only a launcher (ripgrep, git, gh, the workspace walk's git query), the LSP server's 500 ms shutdown race and its refused-kill error (`killChild`, `rejectNextKillForTest`, `forceKillForTest`), the 25 ms start-time poll on Windows (`PROCESS_EXIT_JOIN_POLL_MS`), ADR-0027's "git's launcher ends on its own" caveat, the open shim-`rg` follow-up |
| 3 | `LOOPBACK_ANSWER_MS` and the egress startup kill, `EMBEDDING_HOST_SHUTDOWN_TIMEOUT_MS`, `EMBEDDING_HOST_STOP_TIMEOUT_MS`, the index read 1 s and 5 s deadlines, the fence's 500 ms grace and confirmation, `PROCESS_EXIT_TIMEOUT_MS`, `WORKTREE_SETUP_TERMINATION_GRACE_MS`, `SQLITE_QUERY_EXIT_REPORT_MS`, `HOST_STARTER_CANCEL_EXIT_TIMEOUT_MS`. The removed 1.5 s attach bound (#4308) stays removed: `HOST_STARTUP_TIMEOUT_MS` is the one startup deadline |
| 4 | The launcher watchdog's shell loop, per-fixture lifelines (folded into `spawnNativeChild`), per-owner "group SIGTERM is a retirement" labelling |
| 5 | Quit steps for each service ADR-0029 moves, ADR-0027's native-thread join on Main |

## Done criteria

Every stage is proven against all of these before the next starts. Only real, uncached runs
count; a cached or replayed run proves nothing. A miss is reported with its evidence and is
not patched around.

1. **No orphans.** Killing the test runner (SIGKILL, and Stop-Process on Windows) while the
   lifecycle suites run leaves zero processes behind, on sean-ubuntu and sean-pc.
2. **Slow Windows.** The Stop, quit and close lanes (the indexer and host-lease
   lifecycle suites and the desktop quit, shutdown-signal and app-owned Stop E2E specs) pass
   20 of 20 on sean-pc with the test run pinned to two cores while below-normal busy loops
   hold every other core, at the default timeouts with no retries. Not one core: Electron's
   Windows event loop shares libuv's completion port between two threads, and Electron
   widens the port for them only when the machine has one processor
   (`base::SysInfo::NumberOfProcessors() == 1`, electron#15975), not when the process's
   affinity allows one. Pinned to one core of sean-pc's sixteen, every Electron process
   spins on that port: Main burned 45-50 CPU-s and app-owned Stop timed out, while on two
   cores Main used 2.2 CPU-s and the same test took 12 s. Two cores is not a lower bar: the
   hosted Windows runners this repository uses have two (private-repository
   `windows-latest`), and a real one-processor machine gets Electron's wider port. The spin
   still reaches any Electron process whose threads are starved on a saturated machine, CI
   included, so criterion 3 stays the proof under real load, and the fix for the spin itself
   belongs in Electron (always size the port for its two threads), not in a timeout here. With busy loops at normal
   priority, every unpinned system process (Defender's scans of the files the tests write,
   svchost, dwm) lands on the one core they leave and a 0.7 s test took 31 s. Busy loops on the test's own core leave it a
   quarter of a core, where no fixed harness budget holds (Vitest's 5 s watchdog, the 20 s
   database budget): measured on sean-pc, the state-observation suite went from 8 s to 116 s
   and every join still completed.
3. **Hosted Windows.** The Windows merge-queue lanes pass three runs in a row, uncached, and
   every job ends cleanly: no step hangs after the tests, and the runner's orphan cleanup
   terminates none of our processes (node, electron, git, rg).
4. **No regressions elsewhere.** `pnpm check` passes, and the same lifecycle suites pass on
   sean-ubuntu.
