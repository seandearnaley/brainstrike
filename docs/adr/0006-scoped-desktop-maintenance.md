# ADR-0006: Scope desktop maintenance triggers with Effect

- **Status:** Retired 2026-10-17 (BST-2068). Desktop PGlite and the maintenance triggers
  this decision scoped were deleted; it governs no current code.
- **Ticket:** BST-1824
- **Amends:** ADR-0005 for the isolated maintenance subsystem only.

## Decision

Use Effect resource scopes for the database and dimension-index maintenance
triggers and scheduler-observer subscriptions. Share their acquisition and
release implementation; preserve their separate admission and SQL policies.
Construct the scheduler facades at module evaluation as before and acquire
resources only at the existing app-ready, post-capability-probe start point.

The Promise-facing owner exposes asynchronous start and close, with a
synchronous stop fence. Stop prevents new automatic dispatch immediately;
close joins resource finalizers. Repeated operations and a start racing stop
must never leak or resurrect a retired generation. Failed acquisition releases
resources already acquired by that generation and surfaces the original failure.
This is a deliberate partial-acquisition cleanup policy for maintenance only.

The database shutdown step seals both owners before awaiting either close.
Finalizer failures remain visible and do not bypass the existing database drain.
The existing ordered shutdown and five-second deadline remain authoritative.
Factory reset continues using the database work barrier; it does not close or
restart maintenance scopes.

An admitted maintenance pass is not a child of the trigger scope. Its Promise
remains observed, its single-flight guard stays active until it settles, and the
existing DatabaseWorkScheduler owns its drain. Interrupting a trigger must never
be represented as cancellation of non-abortable SQL. Database lookup, assistant
work checks, corruption recovery and SQL remain in their existing scheduler lane.

## Timing and tests

Retain the native unreferenced initial timeout followed by an unreferenced
interval in one scoped adapter. A slow pass skips overlapping ticks; missed
intervals are not buffered. Effect's pinned fixed schedule can produce a
zero-delay catch-up tick; repeating an awaited pass also changes cadence.
Neither is an equivalent replacement for this event source.

Effect owns acquisition and cleanup through Scope and acquireRelease. Test the
actual native timer adapter with controlled timers and a real process-exit
check. TestClock is appropriate for Effect Clock consumers, not evidence for a
native setInterval adapter; no custom clock protocol is introduced to exercise it.

A narrow Context/Layer owner acquires both actual trigger resources after the
capability probe, while the scheduler facades still validate at construction.
Startup is atomic across the pair: if the second trigger fails to acquire, the
first is fenced before rollback finalizers run, both trigger scopes are closed,
and acquisition plus cleanup failures remain visible. A close racing start
joins acquisition and release before database drain. The parallel group Scope
closes two sequential child Scopes so one slow finalizer does not prevent the
other close attempt. This decision does not authorize a whole-main Layer graph,
a profile scope, database ownership, or new admission policies.

## Evidence

`docs/archive/agent-contract-history/effect-boundary/desktop-maintenance-runtime.md` records falsification,
resource counts, bundle measurements and runtime costs with the implementation.
