# ADR-0015: Desktop IPC authorization, the factory-reset registry and diagnostics

- **Status:** Accepted, with four amendments below.
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
