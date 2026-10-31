# ADR-0006: Scope desktop maintenance triggers with Effect

- **Status:** Retired 2026-10-17 (BST-2068). Desktop PGlite and the maintenance triggers this
  decision scoped were deleted; it governs no current code.
- **Ticket:** BST-1824
- **Amended:** ADR-0005, for the maintenance subsystem only.

## Decision (historical)

- Database and dimension-index maintenance triggers, and scheduler-observer subscriptions, used
  Effect resource scopes with shared acquire/release code and separate admission and SQL
  policies.
- Resources were acquired only after the capability probe at app-ready.
- The owner exposed async start and close plus a synchronous stop fence.
  - Stop blocked new dispatch immediately; close joined finalizers.
  - Repeated calls or a start racing stop could not leak or resurrect a retired generation.
  - Failed acquisition released what that generation had acquired and surfaced the original
    error.
- Shutdown sealed both owners before awaiting either close; finalizer failures stayed visible.
  The ordered shutdown and five-second deadline stayed authoritative.
- An admitted maintenance pass was not a child of the trigger scope; interrupting a trigger never
  meant cancelling non-abortable SQL.
- Timing kept the native unreferenced timeout + interval (slow passes skip ticks; no catch-up
  buffering), because Effect's fixed schedule can fire zero-delay catch-up ticks. Tests used
  controlled native timers and a real process-exit check, not `TestClock`.
- It did not authorize a whole-main Layer graph, profile scope or database ownership.
