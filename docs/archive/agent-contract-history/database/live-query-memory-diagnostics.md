# Desktop live-query memory regression calibration — evidence

Supports `docs/agents/database.md` § "DESKTOP LIVE-QUERY MEMORY TEST DIAGNOSTICS".

The BST-438 memory lane: what the bounded test-only snapshots contain, why reload reaping needs all three WebContents teardown shapes, and the CI-calibrated collection thresholds. Read before changing the lane's bounds or the ownership reaper.

The record below is the original contract text, extracted unchanged.

BST-438's memory regression lane observes live-query ownership without widening
the production renderer bridge or changing cache lifetime. The database demo
installs `__brainstrikeDatabaseDemoTestHooks__.getMemorySnapshot` only when the
desktop lifecycle bridge reports test mode. Its bounded snapshot contains the
active collection ID, at most 100 currently visible record IDs, cardinalities
for the existing collection/page caches, and the query-telemetry live
subscription/update counts. It also reports an opaque generation ledger for the
actual mapped `records` array identities. The ledger keeps at most 256
`WeakRef`s, numeric generation IDs, the current/alive/collected counts, and a
visible dropped-generation count. It never holds a strong reference to a result
array or exposes a row. An empty result clears both the current generation and
last-identity reference; a later return of the same array object is therefore a
new generation. Missing `WeakRef` support in explicit test mode throws, and
dropping a ledger entry is observable rather than silent. Outside test mode the
hook and tracker are absent. The snapshot must never include SQL, parameters,
content, paths, or complete result arrays.

The remote ownership snapshot is also test-only and counts the same live query
at each retaining layer. The DB-host `diagnostics` response carries its internal
`activeLiveQueryCount`; `DbHostManager.getDiagnostics()` deliberately strips
that field from the normal diagnostics IPC result. In explicit test mode,
`getLiveQueryDiagnosticsForTests()` reports the DB-host map and manager proxy
map counts. Database IPC registration installs the main-process
`__brainstrike_e2e_db_live_query_diagnostics__` function only in that mode,
adds the renderer-owner map count, and removes the function when those handlers
unregister. Missing test mode or a missing diagnostic function throws; it must
not return a fabricated zero.

The visible renderer telemetry count is realm-local, while the IPC, manager,
and host diagnostics aggregate their process-wide ownership maps across
renderer owners. Reloading the visible renderer preserves its `WebContents`,
so main-process ownership must be reaped by the live-query owner reaper, not
only on `'destroyed'`: `db:live-query:start` attaches teardown listeners for
all three shapes (`'destroyed'`, `'render-process-gone'`, `'did-navigate'`),
and any firing removes all three listeners, bumps a per-owner generation, and
cleans up every subscription that owner holds — mirroring the fs-watch owner
reaper (`attachOwnerReaper` in `file-system-watch-ipc.ts`). A start whose
`createLiveQueryHandle` await straddles a reap observes the generation change
and tears its fresh handle down instead of registering an orphan. Reloads are
therefore idempotent for the main-side counts: the mutation regression
performs a second reload + panel mount after the pre-warm capture and requires
all three main-side counts to return to the pre-warm values exactly, gated on
the renderer-local count so the transient window before the fresh page
re-registers cannot pass. The regression then captures each layer before
selecting a collection and asserts the same exact **+5** delta thereafter: the
three database-demo queries (`file-records`, total, and collection counts) plus
the active-set queue-count and coverage queries mounted by
`useEmbeddingControls`. That computed object is rechecked after every warm and
switch window and after the final insert and delete; absolute counts are never
hardcoded.

The database IPC channel, role, raw-envelope, and parser declarations live in
`apps/desktop/src/ipc-domains/database.contract.ts`. Main keeps a narrow
event-aware registration adapter because scheduler admission and live-query
ownership require the authenticated `IpcMainInvokeEvent`; visible and hidden
preloads derive their exact database method sets from the same pure contracts.
Do not replace the visible live-update multiplexer with one Electron listener
per hook: its shared listener and local subscriber isolation are intentional.

Memory release means superseded result arrays and live-query handles stop
accumulating. It does **not** mean evicting inactive database-demo pages: that
surface intentionally retains one page per visited collection for fast
revisits. The three-collection regression therefore captures an empty pre-warm
cache, warms A/B/C, and requires every chunk-page, collection-count,
record-page, record-total, and loaded-page cache to contain exactly three keyed
entries throughout repeated switching. It also mutates the final collection
after switching and requires both the inserted and deleted state, proving the
remaining current subscription is live rather than merely bounded. The
mutation regression separately commits 100 alternating inserts/deletes and
requires each current result before continuing.

Forced collection must remove the mutation baseline and midpoint generations,
leave the current generation alive, collect at least 97 of at least 101 tracked
arrays, and leave at most four alive. The switching test must remove all three
warm generations, leave the current generation alive, collect at least 30 of at
least 35 tracked arrays, and leave at most eight alive (CI-calibrated: the
first ubuntu memory-baseline dispatch held 7, local runs hold 5). Both require
zero dropped
ledger entries. These identity assertions are the primary retained-result
proof; renderer heap and visible-renderer working set are independent physical
pressure bounds, not substitutes for collection evidence.

Renderer heap assertions require real forced collection AND real heap reads.
The desktop E2E launcher passes `--js-flags=--expose-gc` plus
`--enable-precise-memory-info` (without the latter,
`performance.memory.usedJSHeapSize` is quantized and cached for 20 minutes, so
every in-test heap delta reads as exactly `0.0`), and
`forceRendererGarbageCollection` throws when `window.gc` is unavailable; a
silent no-op would make the retained-heap result meaningless. Both regressions
live in `apps/desktop/e2e/database-live-query-memory.desktop.test.ts` and are
explicitly selected by the `memory-baseline` branch of
`.github/workflows/desktop-e2e.yml`; nightly `full` runs include the file too,
and both branches are pinned by
`scripts/__tests__/desktop-memory-dispatch-contract.test.mjs`. Paired unit/contract coverage lives in
`packages/db-explorer/src/__tests__/database-demo-panel.test.tsx`,
`packages/db-explorer/src/hooks/__tests__/use-database-demo-test-hook.test.ts`,
`packages/db-explorer/src/__tests__/use-database-demo-data.test.ts`,
`apps/desktop/src/__tests__/main/db-host-entry.test.ts`,
`apps/desktop/src/__tests__/main/db-host-manager.test.ts`,
`apps/desktop/src/__tests__/ipc-domains/db-ipc.test.ts`, and
`apps/desktop/src/__tests__/desktop-e2e-harness-contract.test.ts`.

The collector latches retention-clock failure per instance, logs the first
producer failure, stops timer-driven publication, and
publishes a stable explicit failed snapshot to `useSyncExternalStore` reads.
Imperative `snapshot()` calls still throw the latched error.
Count buckets use a boundary-inclusive bucket interval: a count can remain for
up to one coarse bucket after its individual event crosses the strict duration-
sample cutoff. A nonzero count with zero retained percentile inputs at that
boundary is therefore expected.
