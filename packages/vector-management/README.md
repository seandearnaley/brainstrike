# @brainstrike/vector-management

Shared embedding-set controls, runtime status, queue diagnostics and search
embedder composition. This UI observes and controls existing owners; it does
not run local inference or own canonical persistence.

## Compose admitted surfaces

`VectorStatus`, `VectorStatusWithDb`, `EmbeddingControlsPanel`, `QueueHud` and
diagnostics use the props/context declared by the source. A DB-connected component
needs its database/queue/runtime providers. `QueueHud` uses its existing `variant`
contract, not the old `position`/`maxItems`/`autoHide` example.

`createVectorQueueService` takes injected dependencies rather than a bare database.
Its actual operations include `refresh`, `backfill`, `reembedSet`, `retryFailed`
and `wipeQueue`; the old `getSnapshot`/`backfillChunks`/`cancelBackfill` example is
not its API. See
[`vector-queue-service.ts`](src/vector-status/vector-queue-service.ts).

Database-backed queue controls and desktop native-index controls are different
capability paths. Their presence does not imply desktop uses PGlite or starts a
worker in the visible renderer. Reuse the injected embedding/search runtime;
component detach does not retire work owned by a longer-lived host.

## Status and lifetime

Keep model/profile, scope, source revisions and generations through backfill and
search. Coverage and publication acknowledgements come from the actual index
owner, not from a UI queue count. Stop/pause/cancel and destructive clear reach
the owning runtime and retain failed joins visibly.

Re-embedding on the database-backed service clears then backfills; the two phases
are not atomic. A failed backfill must remain visible and recover through the
existing backfill operation rather than claiming the set is complete.
Device/preferences/credentials use their existing owners and reset lifecycle;
local worker payloads carry no provider secrets.

Exports and scripts live in [`package.json`](package.json) and
[`index.ts`](src/index.ts). See [inference](../../docs/agents/local-inference.md)
and [indexing](../../docs/agents/indexer.md) contracts.
Select checks with
[validation guidance](../../docs/agents/ci-quality.md).
