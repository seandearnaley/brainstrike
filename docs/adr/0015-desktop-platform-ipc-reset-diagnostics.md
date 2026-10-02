# ADR-0015: Desktop IPC authorization, the factory-reset registry and diagnostics

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914

## Context

Three desktop platform contracts carry rulings that outlive the reset. Sensitive IPC
gained two-factor sender authorization (BST-1641) and contract modules with a channel
manifest (BST-1648). A second, test-only reset list drifted and let shuffled tests
inherit state (BST-938), and the three table-clearing reset paths now share one
registry (BST-992). Logging kept one redaction-safe entry point (BST-1663), and the
NDJSON backstop sits on the logging choke points.

## Decision

- **IPC authorization.** Possession is not authorization, and both factors, sender
  role and sender frame, are mandatory for a contract domain. They run before a
  handler sees any renderer-controlled argument. The manifest owns channel literals,
  preload imports are allowlisted by purity, and the migration inventory is closed in
  both directions.
- **Factory reset.** Any new persistent store or state is wired into factory reset.
  Probing, not catching: a relation that may be absent is probed, never deleted and
  caught. The registry owns the set. Module-scope reads of imported constants stay
  banned, and migration 066 stays as it is. Whole-profile no-resurrection coverage
  exists and does not replace table-by-table `db:clearAll` proofs.
- **Diagnostics.** Logging has one gate and one redaction pass, and `instanceof` is
  not the gate. Diagnostic events stay separate from the run-scoped run-event
  timeline, with a different scope, retention and sanitization contract. The NDJSON
  sink hangs off the two `logging-ipc.ts` choke points, not a pino transport. The last
  shutdown step stays last, and flat main entries resolve from `__filename`.

## Consequences

- Pino transports run in a worker thread and see only main-process output, missing
  every renderer and hidden-host record forwarded over IPC; that is why the sink is
  not a transport.
- The stores in ADR-0011 (state DB, blobs, derived store, web OPFS) join factory
  reset, and the reset test covers every store.
- The agent-host protocol in ADR-0017 authenticates clients with a token; the
  two-factor rule continues to govern Electron IPC.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/platform-contracts.md:107` (sender factors), `:176` (IPC contract
  modules), `:314` (reset probing and registry), `:992` (no-resurrection coverage),
  `:42` (logging gate), `:643` (diagnostic events), `:806` (NDJSON sink placement),
  `:913` (sink and shutdown order).
- `AGENTS.md:41`, the cross-cutting invariant on factory reset.
