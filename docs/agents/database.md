# Database: Model Catalog Migrations, PGlite Extensions, First-Run Bootstrap

> Extracted from AGENTS.md (2026-07-12). Read before adding migrations, models, PGlite construction sites, or touching browser bootstrap. Keep updated with the code.

## MODEL CATALOG MIGRATIONS (CRITICAL)

Adding, removing, or renaming a supported AI model is a multi-layer change. Updating only the static registry is NOT enough — the in-app model picker is driven by a DB-backed catalog.

When changing the model catalog:
1. Update the static registry (single source of truth):
   - packages/assistant-contract/src/provider-registry.ts
2. Add a numbered DB migration that upserts/deletes catalog rows, and register it in BOTH:
   - packages/db/src/migrations/index.ts (numbered MigrationRunner — used by tests)
   - the `customMigrations` ledger in packages/db/src/drizzle/migrate.ts (used by the real app)
   - Registering in only one means tests pass but existing users never see the change.
3. Preserve user choices on kept rows with `ON CONFLICT (id) DO UPDATE SET ... is_enabled = models.is_enabled`.
   - INVARIANT: never use `is_enabled = EXCLUDED.is_enabled` for a catalog refresh — it clobbers the user's toggle. Force on/off only for a deliberate (e.g. security) swap.
4. Remap dropped IDs in the preference stores so persisted selections don't dangle:
   - MODEL_ID_MIGRATIONS in packages/preferences/src/stores/assistant-preferences-store.ts (bump its store version)
   - MEMORY_MODEL_TARGET_MIGRATIONS in packages/preferences/src/stores/assistant-memory-preferences-store.ts (also self-heals on every rehydration)
5. Add any new `packages/db/__tests__/*.test.ts` to `dbUnitLaneDefinitions` in `packages/db/scripts/db-test-lane-manifest.mjs` — that is the ONLY registration needed. Both `test-lanes.mjs` (PR unit lanes) and `coverage-lanes.mjs` (nightly coverage lanes) import and derive from this single manifest: `buildDbCoverageLaneMap` resolves each test's coverage lane automatically from its unit lane via `coverageDefaultsByUnitLane`. Add an entry to `coverageOverridesByLane` only when a test needs a *different* coverage lane than its unit-lane default (e.g. build-hygiene tests like `runtime-import-extensions.test.ts` are unit-laned under `schema-migration` but overridden into the `architecture` coverage lane). The one remaining manual step is introducing a brand-new *unit lane* (not just a new test in an existing one): it needs its own `coverageDefaultsByUnitLane` entry, and `buildDbCoverageLaneMap` fails LOUDLY — not silently — if that entry is missing. Verify: `node scripts/test-lanes.mjs check` and `node scripts/coverage-lanes.mjs check` (the Static job runs both on every PR; `packages/db/__tests__/db-test-lane-manifest.test.ts` also guards this in the regular unit-test run). This manifest unification is what structurally fixed the historical dual-registry drift that caused issue #1101 (registries independently maintained, one edited without the other) — that failure mode is no longer reachable for ordinary test additions.
6. Every LLM model entry MUST declare `contextWindow` (and `maxOutputTokens` when documented) in
   packages/assistant-contract/src/provider-registry.ts — compile-enforced, static-registry-only
   (no DB migration). It drives the thread context meter and the auto-derived
   `agentLoop.inputTokenLimit` (see packages/assistant-contract/src/context-budget.ts).

---

## PGLITE EXTENSION INVARIANT

Every PGlite construction site MUST load the same engine-extension set, or the
corresponding `CREATE EXTENSION` migration fails with a cryptic "could not open
extension control file" error on that path only:

- `vector` (pgvector, from `@electric-sql/pglite-pgvector`)
- `pg_trgm` (from `@electric-sql/pglite/contrib/pg_trgm` — powers `brainstrike.grepSearch` trigram prefilter, migration 038)
- `pg_textsearch` (BM25 index AM, from `@electric-sql/pglite-pg_textsearch` — CONSUMED by migration 053 (`idx_file_chunks_content_bm25`), which powers the BM25 lexical arm of hybrid search; the ranking expression references the index BY NAME via `to_bm25query`, so a construction site missing this module breaks BOTH the migration and every fullTextSearch call. Proofs: `search-bm25-textsearch-spike.test.ts` (BM25 1/12 vs ts_rank 12/12 on the IDF-discriminating corpus) + `search-bm25-empirical-gate.test.ts` (production-shape filtered plan, websearch fuzz, post-build index maintenance, default_limit ordering, 511 ms index build at 50k chunks))
- `live` (client-side reactive queries — loaded everywhere EXCEPT the two live-less worker hosts: `pglite-worker-entry.ts`, where the PGliteWorker client installs it, and `browser-first-run-bootstrap-worker.ts`, whose short-lived bootstrap instances serve no reactive queries)

Construction sites (keep in sync when adding extensions or new sites):
- packages/db/src/wasm-loader.ts (cached loaders + HMR reset in `resetExtensionCaches`)
- packages/db/src/pglite-worker-entry.ts (engine extensions only)
- packages/db/src/browser-first-run-bootstrap-worker.ts (engine extensions only; the dedicated first-run bootstrap worker — see BROWSER FIRST-RUN FAST BOOTSTRAP)
- apps/desktop/src/db-main.ts (main-process host; ambient type shims live in apps/desktop/src/types/)

Tests that construct PGlite directly and run migrations must also pass the full
extension set (see drizzle-migrate.test.ts / drizzle-job-queue-compatibility.test.ts).

---

## BROWSER FIRST-RUN FAST BOOTSTRAP (idb:// STORES)

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
  `packages/db/src/browser-first-run-bootstrap.ts`, wired in `db-provider.tsx`'s
  `initializeDirectPGlite` for `idb://` paths.
- Pipeline (memory migrate → dump → strict load → flush) over injectable PGlite
  constructors: `browser-first-run-bootstrap-pipeline.ts`.
- Production execution: a DEDICATED plain worker
  (`browser-first-run-bootstrap-worker.ts` + `-worker-entry.ts` — a PGlite
  construction site, engine extensions vector + pg_trgm) driven by
  `wasm-loader.ts`'s `runFirstRunBootstrapInWorker` over a two-message
  `{type:'run',dataDir}` → `{type:'result',ok,error?}` protocol with a
  fail-loud 5-minute timeout.

Invariants (do not regress):
- NEVER rebuild this on "relaxed bootstrap + syncToFs + strict reopen": on a
  relaxed instance PGlite's public `syncToFs()` fire-and-forgets the underlying
  flush and `close()` does not flush at all (verified against
  @electric-sql/pglite 0.5.4 src/pglite.ts). Dump/load into a strict instance
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

---


