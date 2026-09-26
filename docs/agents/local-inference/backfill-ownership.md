# Background-indexing backfill ownership, cancellation, and index recovery — evidence

Supports `docs/agents/local-inference.md` § "Background-indexing backfill
ownership". Read before touching `cancel()`/`detach()`, the in-flight
cancellation sweep, the pending-enqueue race, or HNSW suspension around a
backfill. Each paragraph records a bug that a shortcut reintroduces.

## Ownership, detach vs cancel (BST-1654)

     never by the React tree that requested it (BST-1654). The renderer's
     `WorkspaceCollectionSyncService` exposes two distinct teardowns and callers
     must not conflate them: `cancel()` is a deliberate stop (manual pause,
     indexing disabled, restart-active) and cancels the host run; `detach()` is
     the requester going away and releases only local state — it aborts the
     renderer-side loop and drops the progress subscription while the durable
     run keeps going. The provider's teardown effect MUST call `detach()`: it
     re-runs on every `service` identity change, so cancelling there tied a
     host-owned run's lifetime to a React memo dependency list and silently
     killed a user's backfill on navigation. The next `sync()` re-attaches via
     `selectRecoverableBackgroundBackfill`; `useResyncOnReturnToVisibility`
     remains the recovery path for hard teardowns only.

## Abort controllers, the cancellation sweep, HNSW, and queue health

   - The renderer loop and the backfill therefore need SEPARATE abort
     controllers, and the signal handed to `enqueueBackfill` is the backfill's.
     On desktop the signal dies at the IPC boundary, so sharing one controller
     looked harmless; on web there is no host process — `enqueueLocalBackfill`
     merges the caller's signal into the run and awaits it, so the promise IS
     the run and aborting that signal kills the backfill. While they shared a
     controller, `detach()` still destroyed the run on web: the original bug,
     unfixed on that path. `detach()` aborts only the renderer loop; `cancel()`
     and a superseding `sync()` abort both.
   - Detaching drops tracking, never cancellation authority. An explicit pause
     or disable cancels in-flight `background-indexing` runs regardless of which
     provider instance is mounted, so `cancel()` and the disabled `sync()` path
     both enumerate `getBackfillsInFlight()` and cancel every run whose request
     id carries the `background-indexing-backfill:` prefix — a detached run is
     in no instance's `activeBackfill`, and the instance that sees the stop is
     usually a fresh one tracking nothing. Runs the prefix does not claim are
     left alone, and an undeliverable stop rejects instead of reporting success.
     Never make `detach()` the answer to a deliberate stop: trading the
     navigation bug for "pause does not stop indexing" is the worse half.
   - That enumeration sweep MUST be failure-isolated. A `for … await` loop that
     lets the first rejection escape never attempts the cancels behind it, so
     one uncooperative run silently spares every later one — "pause did not stop
     indexing" reappearing through a different door. Attempt every enumerated
     run, then surface the failures together (`AggregateError`); isolation must
     not become silent success.
   - A stop that lands while an `enqueueBackfill` is in flight cannot be closed
     by the sweep alone: it enumerates a host that cannot report the run yet,
     and the cancel it fires for the speculative `pending:` tracking entry races
     ahead of the run's creation. `enqueueManagedBackfill` therefore re-checks
     the backfill signal once the enqueue resolves and cancels the freshly
     created run, so at least one cancel is ordered AFTER the run exists.
   - A backfill suspends the dimension HNSW index before enqueueing. Every
     interruption after that point, including producer faults and timeouts,
     must either restore the index immediately when the scoped set has drained
     or schedule the existing deferred recovery after that scoped drain.
     Non-cancellation failures must never intentionally leave the index
     suspended for an unrelated maintenance tick.
   - Renderer queue-health writes carry the wall-clock time of the completed
     database poll. The store keeps poll freshness separate from the deduped
     count snapshot so always-mounted queue subscribers do not rerender on an
     idle polling cadence. Diagnostics consume the stored poll timestamp; they
     must not synthesize queue freshness during React render.

## Shutdown of deferred HNSW recovery (2026-09-26)

An Electron smoke run canceled a background backfill with two active scoped jobs
after suspending dimension 384's HNSW index. Its fire-and-forget deferred recovery
kept polling a captured DB handle after shutdown retired that handle, logging
`DB host manager is retired.` The shutdown owner now stops that poll before its
next query and leaves the suspension row intact. A later eligible maintenance run
reconciles that durable row (`packages/db/__tests__/dimension-index-maintenance.test.ts`).
The focused backfill regression retires its mock DB after shutdown and requires
zero further queries. Non-shutdown recovery errors remain visible.
