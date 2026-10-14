# Browser first-run fast bootstrap — evidence

Supports `docs/agents/database.md` § "BROWSER FIRST-RUN FAST BOOTSTRAP (idb:// STORES)".

The ~53 s first run that motivated the fast path, the four-step pipeline, and the rejected rebuilds (relaxed-instance `syncToFs`, PGliteWorker sessions). Read before changing the bootstrap pipeline or its capability gates.

The record below is the original contract text, extracted unchanged.

A genuine first run of the web app used to pay ~53s creating `idb://web-pg18`:
initdb + every migration under strict durability, where each statement awaits a
full IDBFS `syncfs` round (#1111). The fast path creates a MISSING store
greenfield in seconds — WITHOUT ever relaxing durability on the persistent
store:

1. initdb + all migrations run in a throwaway `memory://` PGlite.
2. `dumpDataDir('none')` captures the migrated data dir as a tarball.
3. A short-lived STRICT (`relaxedDurability: false`) PGlite opens the real
   `idb://` store with `loadDataDir: <tarball>`; one explicit awaited
   `syncToFs()` flushes the whole data dir to IndexedDB in a single pass
   (atomic: IDBFS reconcile is ONE readwrite transaction and its callback
   fires on `transaction.oncomplete`).
4. Only after that flush (plus an existence re-probe) is bootstrap complete;
   the long-lived strict worker client then opens the store exactly as before.
   The #1111 guarantee therefore holds for every byte the store ever sees.

Layers:
- Orchestration (probe/marker/lock/recovery):
  `packages/db/src/browser-first-run-bootstrap.ts`, wired in
  `pglite-direct-transport.ts`'s `open()` for `idb://` paths.
- Pipeline (memory migrate → dump → strict load → flush) over injectable PGlite
  constructors: `browser-first-run-bootstrap-pipeline.ts`.
- Production execution: a DEDICATED plain worker
  (`browser-first-run-bootstrap-worker.ts` + `-worker-entry.ts` — a PGlite
  construction site, engine extensions vector + pg_trgm + pg_textsearch)
  driven by
  `wasm-loader.ts`'s `runFirstRunBootstrapInWorker` over a two-message
  `{type:'run',dataDir}` → `{type:'result',ok,error?}` protocol with a
  fail-loud 5-minute timeout.

Invariants (do not regress):
- NEVER rebuild this on "relaxed bootstrap + syncToFs + strict reopen": on a
  relaxed instance PGlite's public `syncToFs()` fire-and-forgets the underlying
  flush and `close()` does not flush at all (verified against
  @electric-sql/pglite 0.5.3 src/pglite.ts). Dump/load into a strict instance
  is the only public-API path with a guaranteed awaited flush.
- NEVER run the bootstrap through PGliteWorker sessions: its leader-election
  machinery rejects in-flight RPCs with 'Leader changed, pending operation in
  indeterminate state' when the asynchronously delivered leader-here/leader-now
  events land after the client starts issuing RPCs — ephemeral sole-member
  groups hit this readily under load (observed live in dev; it failed DB init).
  The dedicated worker has no election and no RPC layer, and the dump never
  crosses a thread boundary. The shared `pglite-worker-entry.ts` host stays
  untouched (no `loadDataDir` on its wire — so a leader takeover can never
  replay a stale load).
- Crash safety: a localStorage marker
  (`brainstrike.pgliteFirstRunBootstrap:<dataDir>`) is written before the first
  IndexedDB write and cleared only after the strict flush. marker+store on a
  later launch ⇒ the partial store is deleted (warn-logged) and the bootstrap
  re-runs greenfield — safe because a store whose marker never cleared cannot
  contain user data. Factory reset's blanket `localStorage.clear()` covers the
  marker.
- Capability-gated, never silent: missing IndexedDB / Web Locks / usable
  localStorage each SKIP with an explicit logged reason (the pre-existing
  strict slow path runs instead, slower but equally correct); a bootstrap
  FAILURE rejects into DbProvider's visible init error state — no fallback.
- Multi-tab: serialized on the `brainstrike-pglite-first-run:<dataDir>` Web
  Lock; the loser re-probes inside the lock and skips (`existing-store`).
- Scope: browser `idb://` only (including the per-session `idb://web-e2e-*`
  Playwright stores, which get the same speedup). `opfs-ahp://`
  (worker-host-only backend, far cheaper syncs) and desktop (native FS via
  Electron main) keep their existing paths.

Paired tests: `packages/db/__tests__/browser-first-run-bootstrap.test.ts`
(orchestration/marker/probe), `browser-first-run-bootstrap-pipeline.test.ts`
(phase ordering/cleanup), `browser-first-run-bootstrap-worker.test.ts`
(protocol + STRICT store-load PGlite option pinning),
`browser-first-run-bootstrap.integration.test.ts` (REAL PGlite +
fake-indexeddb over the production pipeline: durable fast bootstrap across
reopen, strict post-ready writes, torn-store recovery),
`wasm-loader-worker.test.ts` (worker runner protocol/timeout), and
`db-provider-first-run-bootstrap.test.tsx` (wiring order + error surfacing).
