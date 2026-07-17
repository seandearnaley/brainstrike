# Decision: keep the manual `collection_indexing_stats` rollup; no LISTEN/NOTIFY layer

> Ledger strategy report item 10 (deferred from Phase 1). Investigated 2026-07-17.
> Verdict on both sub-items: **do not change** — the risk/benefit does not clear the bar.
> Both mechanisms were verified to *work* in PGlite 0.5.4 (probes below); the ruling is
> about fit, not capability.

## 1. `collection_indexing_stats` stays a hand-maintained rollup table

Proposal evaluated: replace the manual rollup (migration 030 +
`packages/db/src/services/collection-indexing-stats.ts`) with a native
`MATERIALIZED VIEW`.

**Rejected, four reasons — the first is a categorical blocker:**

1. **Live queries reject materialized views outright.** The PGlite `live`
   extension works by installing `AFTER INSERT OR UPDATE OR DELETE` triggers
   (calling `pg_notify`) on every relation a subscribed query touches, and
   Postgres forbids triggers on matviews. Verified empirically on PGlite 0.5.4:
   `live.query('SELECT * FROM <matview>')` throws
   `relation "stats" cannot have triggers` at subscribe time. That hard-breaks
   both live consumers of this table:
   `packages/workspace-search/src/panel/collection-stats-query.ts` (consumed by
   `search-coverage-banner.tsx`) and
   `packages/vector-management/src/collection-select/collection-select.tsx`.
2. **`REFRESH MATERIALIZED VIEW` is all-or-nothing.** It recomputes every
   collection — a full scan of `file_chunks` across all embedding sets — where
   `refreshCollectionIndexingStats` recomputes only the requested set ids.
   During active indexing the refresh cadence is ≤5 s / 512 chunks
   (`embedding-worker.ts` stats-refresh controller), so per-refresh cost must
   stay bounded to the sets actually changing.
3. **The metadata columns are part of the reader contract.** `dirty` and
   `last_refreshed_at` tell readers "this row is stale mid-index" (the #1115
   gotcha; see the doc comment on `ACTIVE_COLLECTION_LIVE_COUNTS_QUERY` and
   `search-coverage-banner.tsx`). A matview has no side-band columns — keeping
   them would need a companion table, reintroducing exactly the manual plumbing
   the migration was meant to remove.
4. **QoS integration.** Refreshes route through `DatabaseWorkOptions`
   (`priority: 'background'`) on the single-connection scheduler as bounded
   statements. `REFRESH` is one monolithic statement that would occupy the sole
   PGlite connection for the whole recompute — unschedulable, and hostile to
   the foreground-quiet-window design in `database-work-scheduler.ts`.

Also considered and rejected: **incremental maintenance via row triggers** on
`file_records`/`file_chunks` (count-delta updates). Bulk import writes tens of
thousands of chunk rows per batch; per-row trigger overhead lands inside the
import transaction on the latency-critical single connection. The existing
design — mark dirty at write time, recompute per-set in batched background
refreshes — amortizes the same work deliberately.

**Framing for future readers:** the manual rollup *is* a materialized view —
hand-rolled to be incremental, per-collection, metadata-carrying, and
QoS-scheduled. Native matviews offer none of those properties.

Revisit if: PGlite gains an incremental-view-maintenance extension (pg_ivm) or
`live` support for matviews, AND the per-set refresh shape becomes a measured
problem.

## 2. No raw LISTEN/NOTIFY layer for queue wakeups / cross-tab invalidation

Proposal evaluated: use PGlite LISTEN/NOTIFY (supported: `db.listen()` works,
and `PGliteWorker` proxies `listen`/`onNotification` across tabs) to replace or
complement interval polling for (a) job-queue worker wakeups and (b) cross-tab
invalidation.

**Rejected:**

1. **`live` already IS LISTEN/NOTIFY.** The extension's dist creates
   `_notify_trigger_` functions calling `pg_notify` and dispatches over
   `LISTEN`. Cross-write/cross-tab UI invalidation therefore already has push
   semantics everywhere `live` is wired (see the extension-set invariant in
   `docs/agents/database.md`). A raw LISTEN/NOTIFY channel would be a second,
   parallel instance of the same mechanism — with none of `live`'s re-query
   plumbing. Where `live` has known gaps (Electron `collection-select`), the
   fix was explicit app events, not a new DB channel.
2. **The idle poll being replaced is already near-free.** The embedding worker
   claims with exponential idle backoff, 400 ms → 1000 ms cap
   (`embedding-worker-scheduler.ts`). At worst that is ~1 indexed
   `claimMany` probe per second against an in-process WASM database — no
   network, no server round-trip. The winnable latency is ≤1 s on the first
   job after idle, for a background indexer. There is no measured cost here to
   recover.
3. **Polling cannot be removed anyway → dual wakeup semantics.** Notification
   delivery is dispatched by leader-tab JavaScript, so it is subject to the
   same Chrome background-tab timer throttling documented in
   `docs/bst-364-background-throttling-qos-research-2026-05.md`, and
   notifications are lost across worker restart/suspend. The poll loop must
   stay as the source of truth; NOTIFY would only ever be an *additional*
   wakeup path — more states in exactly the layer that produced the #1247
   starvation wedge (self-inflicted QoS foreground-db-pressure yielding).
   NOTIFY storms during bulk enqueue would feed the pressure controller /
   quiet-window machinery a new burst-shaped input that every bounded layer
   (starvation bypass, bounded permit, tree-gate grace) would need re-proving
   under, with real integration tests.
4. **Desktop needs a new IPC bridge surface.** The db host bridges only
   live-query subscriptions (`apps/desktop/src/ipc-domains/db-ipc.ts`,
   `db-host-entry.ts`); raw notifications would need new cross-process
   plumbing on the same class of channel where PGliteWorker leader-election
   already bit us (see the first-run bootstrap invariants in
   `docs/agents/database.md`).

Revisit if: the queue ever moves out-of-process to a shared server Postgres
(then LISTEN/NOTIFY is the standard tool), or profiling shows idle claim polls
as a real cost on battery/CPU.

## Verification appendix (PGlite 0.5.4, 2026-07-17)

Probe 1 — matview capability: `CREATE MATERIALIZED VIEW` over an aggregate,
`REFRESH` (stale-until-refresh confirmed), and `REFRESH ... CONCURRENTLY` with
a unique index all succeed; `db.listen` + `NOTIFY` round-trips a payload.

Probe 2 — live-over-matview: with the `live` extension loaded,
`db.live.query('SELECT * FROM stats', ...)` over a matview throws
`relation "stats" cannot have triggers` — subscribe-time failure, not silent
staleness.

Code evidence: `live` dist contains `CREATE OR REPLACE FUNCTION "_notify_...`
+ `pg_notify` + `AFTER INSERT OR UPDATE OR DELETE ON` trigger DDL;
`worker/index.d.ts` declares `listen(channel, cb)` / `onNotification(cb)` on
`PGliteWorker`.
