# ADR-0015: Desktop IPC authorization, the factory-reset registry and diagnostics

- **Status:** Accepted, with seven amendments below.
  - Its "existing shutdown deadlines" language is superseded by
    [ADR-0026](0026-lifecycle-readiness-liveness-joined-quit.md) (joined quit, no global
    deadline).
  - No migration 066 exists in the current tree (the PGlite schema is gone); that clause is
    history.
- **Date:** 2026-10-02
- **Ticket:** BST-1914

## Context

Three desktop platform contracts carry rulings that outlive the reset.

- Sensitive IPC gained two-factor sender authorization (BST-1641) and contract modules with a
  channel manifest (BST-1648).
- A second, test-only reset list drifted and let shuffled tests inherit state (BST-938); the
  three table-clearing reset paths now share one registry (BST-992).
- Logging kept one redaction-safe entry point (BST-1663), and the NDJSON backstop sits on the
  logging choke points.

## Decision

- **IPC authorization.**
  - Possession is not authorization. Both factors, sender role and sender frame, are mandatory
    for a contract domain, and run before a handler sees any renderer-controlled argument.
  - The manifest owns channel literals; preload imports are allowlisted by purity; the migration
    inventory is closed in both directions.
- **Factory reset.**
  - Any new persistent store or state is wired into factory reset; the registry owns the set.
  - Probing, not catching: a relation that may be absent is probed, never deleted and caught.
  - Module-scope reads of imported constants stay banned, and migration 066 stays as it is.
  - Whole-profile no-resurrection coverage exists and does not replace table-by-table
    `db:clearAll` proofs.
- **Diagnostics.**
  - Logging has one gate and one redaction pass; `instanceof` is not the gate.
  - Diagnostic events stay separate from the run-scoped run-event timeline, with a different
    scope, retention and sanitization contract.
  - The NDJSON sink hangs off the two `logging-ipc.ts` choke points, not a pino transport.
  - The last shutdown step stays last; flat main entries resolve from `__filename`.

## Amendments

- **Session ownership (approved by Sean, 2026-10-10).**
  - Chromium owns a dedicated `session-data` container in every desktop launch.
  - Reset clears the default and browser-pane sessions through Electron's APIs after writer
    preparation, keeping only their engine container during the app-owned file purge.
  - Windows holds that directory open even after the owner clears its data, so physical rename
    is not a valid Session reset primitive.
  - Clearing failures stay visible and fail the reset; no browser or app user state may return
    after renderer replacement or a full restart.
  - Main's coordinator and profile reset lease stay the reset authority; no cross-process owner or
    migration is added.
- **Terminal quit (approved by Sean, 2026-10-10).**
  - An accepted reset completes deletion under its lease even when quit arrives.
  - Quit cancels replacement readiness and prevents a new profile session; an already-admitted
    replacement host is cancelled and physically joined by its owner.
  - Ordinary reset still waits for renderer readiness before reopening.
  - Only the exact terminal cancellation is expected; unrelated failures and existing shutdown deadlines remain unchanged.
- **No index step (2026-11-01, BST-2436, [ADR-0035](0035-workspace-retrieval-is-live-search.md)).**
  - Main's workspace index is deleted, and with it the index steps of Clear Database, Factory
    Reset and quit.
  - The one derived store left is the host state index. The state store retires it before Clear
    deletes content and before Factory Reset removes the store's files; the userData purge removes
    whatever an older build left in the profile.
- **Main-owned reset (approved by Sean, 2026-10-31, BST-2382).**
  - Main is the only owner of Factory Reset. The userData purge also deletes the sealed
    credential store.
  - After the purge Main loads `about:blank` in every window (so no old document can write),
    clears the default session's storage with `clearStorageData` (`clearData` skips the app's own
    non-web scheme), then reloads each window's document.
  - The renderer only retires its writers and clears its window-scoped `sessionStorage`, which no
    session API reaches. It has no channel that wipes storage, settings or secrets.
  - Renderer stores no longer reset themselves or register resetters: the replaced document
    starts from defaults.
- **Managed worktrees (2026-11-12, build decisions, [ADR-0034](0034-worktrees-are-thread-checkouts.md)).**
  - Managed worktrees live outside userData, and their ledger is in the state DB. Before
    Factory Reset retires the host and deletes the state DB, Main asks the host to archive every
    active one into its repository through the worktree service's own archive.
  - Only Main asks: the request (`reset/worktrees/archive`) travels on Main's private
    platform connection, as the MCP retire for the reset does, and is not a client method, so no
    window can reach it.
  - A worktree left on disk (locked, holding nested repositories, a run active in it, or a
    failed archive) is named with its path and why in the reset's outcome and Main's log. So is
    an archive that could not run. Neither fails the reset, and no worktree folder is deleted
    outside the archive.
  - The replaced window never sees the reset's answer, so Main keeps the worktrees' outcome
    and the replacement window takes it once (`db:takeResetOutcome`) and shows it.
  - The archive deletes each worktree's ignored files. Sean's answer accepted that for the idle
    cap; the build extends it to the reset, and the Factory Reset dialog says so before the
    person confirms.
  - Clear Database keeps settings and deletes the ledger rows; the next amendment covers it.
- **Clear Database retires the worktrees and scratch folders (2026-11-12, build decisions,
  [ADR-0034](0034-worktrees-are-thread-checkouts.md)).**
  - Clear Database deletes the worktree ledger and every scratch thread's rows, but keeps
    userData, so the managed worktrees and `<userData>/scratch` stayed on disk.
  - After the clear's runtimes stop and before the host clears content, Main asks the host for
    Factory Reset's archive, on the same private platform connection. The request is renamed
    `reset/worktrees/archive`, since both resets send it.
  - Once the clear has succeeded, and never before, Main moves every folder directly inside
    `<userData>/scratch` to the system Trash through the scratch-folder guard. A missing
    `scratch` folder is nothing to move.
  - A worktree or scratch folder left on disk is named with why, as is a step that could not
    run; neither fails the clear.
  - One outcome path for both resets: Main keeps the reset's mode, worktrees and scratch
    folders, and the replacement window takes them once (`db:takeResetOutcome`). The Clear
    content dialog says what happens to both before the person confirms.
- **Network history clears on Chromium's schedule (approved by Sean, 2026-11-14, BST-2515).**
  - Factory Reset no longer waits for Chromium to write the cleared network history (HSTS and
    alt-svc entries) to disk. That changes the session-ownership guarantee for the network
    history only: Chromium writes it on its own schedule.
  - The cost: a crash after the reset and before Chromium's write can bring those entries back.
    A normal quit cannot, since Chromium finishes the write before its network service exits.
  - The cause. Under heavy load (load average 100 to 350 on 10 cores) the reset stalled in the
    session clear, and the new window loaded only when the app quit.
    - Only `session.clearData()` stalled, and only on the persistent sessions. Its cache type
      clears the network history, and Chromium answers only once that history is on disk.
    - Chromium writes it with a task it runs at its lowest priority (`BEST_EFFORT`,
      `BLOCK_SHUTDOWN`), for both the `TransportSecurity` and `Network Persistent State` files.
      On macOS that priority runs at background QoS, at most two tasks at a time, which a busy
      machine starves. Shutdown runs such tasks at normal priority, which is why quitting
      finished the reset.
    - Measured: at load 77 to 97, `clearData()` took 4.9 to 33.5 s on the default and pane
      sessions, and Factory Reset's E2E spec failed 3 of 10 runs. In the same runs the in-memory
      agent session took 10 ms or less, and `clearStorageData` under 90 ms.
    - With Chromium's lowest-priority tasks turned off (`--disable-best-effort-tasks`),
      `clearData()` never answered, nor did `clearData` for the cache type alone. Every other
      clear finished in under 80 ms. A trace showed only the network-history step unfinished.
      With the same flag in the app's launch, Factory Reset's E2E spec stayed on "Resetting…"
      until its timeout on the old clear, and passed in 13 s on the new one.
  - The build (BST-2515):
    - The reset awaits every clear a page or the reopened profile can read: `clearStorageData`,
      `clearCache`, `clearCodeCaches`, `clearSharedDictionaryCache`, `clearHostResolverCache`,
      `clearAuthCache` and `closeAllConnections`. A failure of any of them still fails the reset.
    - It starts the full `clearData()` and does not wait for it. That call alone reaches the
      network history and the data types Electron does not name, such as the Reporting and
      Network Error Logging caches.
    - None of the awaited clears is a `clearData` call. Chromium runs one session's `clearData`
      calls one at a time, so an awaited one would wait behind the network history's write.
      Measured with lowest-priority tasks off: a `clearData` for cookies alone waited behind a
      pending `clearData()`.
    - Main logs a failure of the unawaited clear at error, with its session, and tells the person
      (next bullet).
  - Late failures reach the person (build decision by the coordinator, 2026-11-14, BST-2515).
    - The replacement window takes the reset's outcome once, as it starts
      (`db:takeResetOutcome`). A failure Main knows by then rides that outcome.
    - A later failure, or one after a reset that failed and kept its window, Main pushes to every
      window as a reset outcome: a new method, `db:resetOutcome`, on the existing push envelope
      (`brainstrike:push`). It adds no channel and no owner. The window listens before it takes,
      so neither path misses a failure.
    - The person sees a persistent "Factory reset could not clear some browsing data" notice: some
      sites' HSTS settings and connection hints may remain, and running Factory Reset again
      clears them.
  - Not built: deleting the persistent sessions' `TransportSecurity` and `Network Persistent
    State` files at the next launch when the clear did not finish. A reviewer proposed it to close
    the crash window.
    - It would write inside `session-data`, which the session-ownership amendment leaves to
      Chromium alone. That is an ownership change.
    - Its marker would have to outlive the userData purge, which runs after the clear starts.
      Every folder that survives the purge (`session-data`, `logs`, Crashpad's database and the
      profile lock) has another owner.
    - On Windows, the network service sandbox moves those files under `Network/`, so their paths
      depend on the platform.
    - It would close the window for those two files only, not for the other stores the same clear
      reaches, such as the Reporting and Network Error Logging caches.

## Consequences

- Pino transports run in a worker thread and see only main-process output, missing every renderer
  record forwarded over IPC; that is why the sink is not a transport.
- The stores in [ADR-0011](0011-run-log-and-state-store.md) (state DB, blobs, derived store) join
  factory reset, and the reset test covers every store.
- The agent-host protocol in [ADR-0017](0017-cli-first-agent-host.md) authenticates clients with a
  token; the two-factor rule still governs Electron IPC.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/platform-contracts.md:107` (sender factors), `:176` (IPC contract modules), `:314`
  (reset probing and registry), `:992` (no-resurrection coverage), `:42` (logging gate), `:643`
  (diagnostic events), `:806` (NDJSON sink placement), `:913` (sink and shutdown order).
- `AGENTS.md:41`, the cross-cutting invariant on factory reset.
