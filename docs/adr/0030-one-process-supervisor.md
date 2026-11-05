# ADR-0030: One process supervisor; the OS exit is the only completion

- **Status:** Accepted (Sean adopted all five stages, 2026-10-25)
  - 2026-11-01 (BST-2436, [ADR-0035](0035-workspace-retrieval-is-live-search.md)): the indexer, query reader and embedding
    host processes are deleted. The host state index is the one index process left.
- **Date:** 2026-10-25
- **Amends:** [ADR-0026](0026-lifecycle-readiness-liveness-joined-quit.md) (R2 and R5 are held
  by one implementation instead of each owner), [ADR-0027](0027-canonical-electron-quit.md)
  (a killed git ends with its whole tree, not only its launcher)
- **Follows:** [ADR-0017](0017-cli-first-agent-host.md), [ADR-0029](0029-main-is-a-launcher.md)

## Context

Windows stop, close and quit failures kept arriving one at a time. Measured at f93e0253, they
share three causes.

1. **No single owner of a process's life.**
   - About 20 owners each wrote their own spawn, close request, kill and exit wait (agent host,
     indexer, query reader, egress proxy, embedding host, renderers, terminals, LSP, git,
     ripgrep, worktree setup, command sessions, agent commands, fence, hooks, host state index,
     CLI starter, test fixtures).
   - Four ways to kill a tree and seven grace values from 500 ms to 30 s.
   - ADR-0026's rules were prose, so owners drifted back to short clocks (e.g. a 1.5 s attach
     bound in `host-lease`, removed in #4308).
2. **POSIX kill semantics on Windows.**
   - Windows refuses to terminate an exiting process, so Electron's `kill()` returns false; the
     indexer called that `indexer-kill-failed` and blocked the index for good.
   - No process groups: killing a launcher or shim leaves the real program running (Chocolatey
     `rg` shim, #4306; `cmd\git.exe`, ADR-0027).
   - Electron reports a utility's `exit` before the OS exit, so Main polled start time every
     25 ms.
3. **Containment stopped at the agent host.** The host joins a kill-on-close Job (ADR-0017), but
   Main's own children (ripgrep, git, LSP, terminals) had none, and ending a tree on Windows ended
   only its root.

## Decision

1. **One supervisor per owning process.** Main, the agent host and the CLI host start every child
   through one supervisor: Electron utilities through one fork helper in Main, Node and native
   children through `spawnNativeChild`. Owners keep their protocol (what close means) and lose
   the mechanics (kill, wait, clock).
2. **Containment at spawn.**
   - Windows: the agent host keeps its kill-on-close Job (`windows-job-native` `initialize()`).
     Main does not join one, because `shell.openExternal` can start the user's browser as Main's
     child. Main's Electron children end with Main; its Node children move to the host
     (ADR-0029).
   - Ending a live owner's third-party tree uses `terminateTree` (`tree-kill`, i.e.
     `taskkill /T /F` on Windows), so a shim never leaves its real program running.
   - A persistent CLI host is its own owner.
   - POSIX: each child leads its own process group; our Node children hold a lifeline pipe that
     ends them on EOF. The inherited Root flock stays (ADR-0017).
3. **The OS exit is the only completion.** A child is gone when its process or Job handle is
   signalled (Windows) or it has exited and been reaped (POSIX). Terminate is a request: logged,
   never acted on. A refused terminate is not a fault and blocks nothing.
4. **Two constants, owned by the supervisor** (`@brainstrike/state-store`):
   - `CHILD_CLOSE_BUDGET_MS` (30 s): from the close request to exit (not to an ACK); after it
     the tree is terminated and the exit still joined.
   - `CHILD_SIGNAL_GRACE_MS` (2 s): third-party trees are terminated at once on Windows; on POSIX
     SIGTERM, then SIGKILL after the grace. A late exit is logged and still joined.
   - Startup keeps one user-facing deadline (`HOST_STARTUP_TIMEOUT_MS`; the CLI starter's
     `HOST_STARTER_READY_TIMEOUT_MS`), which refuses that start alone.
   - A bound on one request a user waits on (ADR-0026 R5(a): index read, git query, ripgrep
     search) refuses that request alone, ends its process through the supervisor and joins the
     exit.
   - No other lifecycle constant exists.
5. **Quit is the supervisor closing children in dependency order:** factory reset, renderers,
   host stop, utilities, database (ADR-0029's end state).

## Stages

Each stage ships alone, deletes more than it adds, and starts only after the previous one met
every done criterion. At the end, a search for each removed name finds nothing.

1. **Exit is the only completion.** The two constants; the indexer's single close window with a
   refused kill treated as a request; agent host and host state index on the budget.
   - Removes: the indexer's post-ACK `exitMs`, `indexer-kill-failed`, `IndexerLifecycleError`
     and the retained-owner path, the host state index's 1 s close/exit, `KILL_GRACE_MS`,
     `HOST_COOPERATIVE_CLOSE_MS`.
2. **Tree termination.** `terminateTree` for every third-party tree and `endTreeOnDeadline` for
   every bounded child; Windows joins exit on the process handle (`waitForProcessExit`).
   - Removes: hand-written tree kills (`killTree` / `TreeKill`, the terminal's own `tree-kill`,
     worktree setup's launcher-only kill), launcher-only `timeout`/`signal` spawn options, the
     LSP 500 ms shutdown race (`killChild`, `rejectNextKillForTest`, `forceKillForTest`),
     `PROCESS_EXIT_JOIN_POLL_MS`, ADR-0027's git-launcher caveat, the shim-`rg` follow-up.
3. **Every remaining lifecycle timer onto the two constants** (egress, embedding host, SQLite
   query, CLI starter, worktree setup, fence, command sessions).
   - Removes: `LOOPBACK_ANSWER_MS` and the egress startup kill, `EMBEDDING_HOST_*_TIMEOUT_MS`,
     the fence's 500 ms grace, worktree setup's abandon timer, `PROCESS_EXIT_TIMEOUT_MS`,
     `WORKTREE_SETUP_TERMINATION_GRACE_MS`, `SQLITE_QUERY_EXIT_REPORT_MS`,
     `HOST_STARTER_CANCEL_EXIT_TIMEOUT_MS`, the `stop-failed` command-session answer.
   - Kept: index read bounds (R5(a) request bounds). The 1.5 s attach bound stays removed.
4. **POSIX lifelines and test fixtures** spawn through the supervisor.
   - Removes: the launcher watchdog's shell loop, per-fixture lifelines, per-owner "group SIGTERM
     is a retirement" labelling.
5. **Quit shrinks** as ADR-0029 moves services into the host.
   - Removes: quit steps for each moved service and ADR-0027's native-thread join on Main.

## Done criteria

Only real, uncached runs count. A miss is reported with evidence, not patched around.

1. **No orphans.** Killing the test runner (SIGKILL; Stop-Process on Windows) during the
   lifecycle suites leaves zero processes, on sean-ubuntu and sean-pc.
2. **Slow Windows.** The Stop, quit and close lanes (indexer and host-lease lifecycle suites;
   desktop quit, shutdown-signal and app-owned Stop E2E) pass 20/20 on sean-pc pinned to two
   cores with below-normal busy loops on the others, at default timeouts, no retries.
   - Why two cores, not one: Electron widens its Windows completion port only on a
     one-processor machine (electron#15975), not for a one-core affinity, so a one-core pin
     makes every Electron process spin. Hosted Windows runners have two cores.
   - Busy loops run below normal priority; at normal priority, Defender, svchost and dwm crowd
     the one free core and no fixed harness budget holds.
3. **Hosted Windows** (superseded 2026-10-26): no merge-queue batch runs on Windows. Hosted
   Windows runs unit tests nightly and on dispatch; Windows integration and E2E run on demand on
   a real machine.
4. **No regressions elsewhere.** `pnpm check` passes and the lifecycle suites pass on
   sean-ubuntu.
