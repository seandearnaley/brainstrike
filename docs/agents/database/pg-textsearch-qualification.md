# pg_textsearch qualification record — evidence

Supports `docs/agents/database.md` § "PGLITE EXTENSION INVARIANT".

The BST-1063 re-qualification of extension version 1.3.1, the BST-1081 greenfield ruling, the macOS-arm64-only platform exception owed under BST-1080, the byte-identical carry-forward argument, and the PGlite Electron process-detection note. NOTE: the version triple quoted below (pglite 0.5.5 / pgvector 0.0.6 / pg_textsearch 0.0.7) is HISTORICAL — the catalog in `pnpm-workspace.yaml` now pins 0.5.8 / 0.0.9 / 0.0.10, and `packages/db/__tests__/migration-066-restore-pg-textsearch.test.ts` pins those literals. `QUALIFIED_PG_TEXTSEARCH_VERSION` is still `1.3.1`. Read before bumping any member of the family.

The record below is the original contract text, extracted unchanged.

- `pg_textsearch` (BM25 index AM, from
  `@electric-sql/pglite-pg_textsearch`) is a fail-closed, version-qualified
  runtime dependency. The compatible package family is pinned together in ONE
  place, the `catalog:` block of `pnpm-workspace.yaml`:
  `@electric-sql/pglite@0.5.5`,
  `@electric-sql/pglite-pgvector@0.0.6`, and
  `@electric-sql/pglite-pg_textsearch@0.0.7`, whose bundled extension reports
  exactly `pg_textsearch 1.3.1`. The literal triple is enforced by
  `packages/db/__tests__/migration-066-restore-pg-textsearch.test.ts`; keep this
  paragraph in step with it. Do not independently bump one member — this
  is not just a peerDependency lint warning: BST-1063 verified empirically
  that constructing `new PGlite()` with pglite core 0.5.4 and a held-back
  `pglite-pg_textsearch@0.0.4` (built against core 0.5.3) throws "PGlite
  failed to initialize properly" outright, before any SQL runs. The family
  moves as one unit or not at all.
  pg_textsearch 1.3.x introduced a persisted paged-memtable design and 1.3.1
  produced invalid BM25 page chains during real `file_chunks` updates when
  qualified against pglite-pg_textsearch@0.0.5 — that finding quarantined
  1.3.1 in migration 065/066. BST-1063 re-qualified the *same* extension
  version 1.3.1 as now bundled by pglite-pg_textsearch@0.0.6 (the PGlite
  0.5.4 bump left no lower-numbered pg_textsearch option): 6/6 durability-gate
  runs clean (5 default-config + 1 heavier stress config) plus 3/3 clean
  trials of the existing-user upgrade path (a BM25 index created under
  pglite-pg_textsearch@0.0.4/extversion 1.2.0, reopened and further
  written/read/VACUUMed under the 0.0.6/1.3.1 binary — extversion stayed
  '1.2.0' in the catalog with no `ALTER EXTENSION UPDATE`, and the index
  stayed valid throughout). All of that evidence is macOS arm64 only; no CI
  lane exercises this opt-in gate on any platform, so Linux and Windows
  remain unproven for this specific engine version. See
  `packages/db/src/pg-textsearch-compatibility.ts` for the qualification
  record.

  That 1.3.1 qualification CARRIES FORWARD across the BST-1283 bump to
  0.5.5/0.0.6/0.0.7 without a re-run, because both extension bumps are pure
  peer-pin re-releases: unpacking the published tarballs and diffing the inner
  payloads shows `pg_textsearch.so`, `pg_textsearch.control`, every versioned
  `.sql`, and the pgvector equivalents are BYTE-IDENTICAL to 0.0.6/0.0.5; the
  only delta in either package is its own `version` and its exact
  `@electric-sql/pglite` peer (0.5.4 → 0.5.5). `default_version` stays
  `1.3.1`, so `QUALIFIED_PG_TEXTSEARCH_VERSION`, `PGLITE_DATA_DIR_VERSION`
  (`pg18`), and `BUNDLED_PG_MAJOR` (`18`) are all unchanged and no data-dir
  migration is implied. Re-derive this the same way before assuming it of a
  FUTURE bump — an extension release that actually rebuilds the binary does
  need the gate re-run on the terms this section sets out.

  **The guard protects greenfield installs only — RESOLVED BY RULING
  (BST-1081, Canceled 2026-08-02): Brainstrike is a greenfield app with no
  existing installs, so greenfield is the entire population.** The structural
  facts stand: migration 066's Drizzle ledger key is a fixed string literal
  (never re-runs for an already-migrated database), nothing calls
  `ALTER EXTENSION UPDATE`, and no runtime code compares the catalog's
  extversion against the loaded binary. They simply have nobody to affect —
  the first public build ships a 1.3.1 family (0.5.4 when this ruling was
  written; 0.5.5 since BST-1283 — the same 1.3.1 binary either way), so every
  install that will ever exist runs migration 066 under it. Pre-bump
  DEVELOPMENT databases
  are the one exception: they land in the 1.2.0-catalog/1.3.1-binary mixed
  state after upgrading, which is accepted (3/3 clean upgrade-path trials;
  the BM25 index is derived data) — if such a DB misbehaves in search, reset
  it or drop/recreate `idx_file_chunks_content_bm25` rather than debugging
  the mixed state. If an upgrade path from a pre-1.3.1 database is ever
  shipped, BST-1081's analysis is the spec: `ALTER EXTENSION UPDATE` alone
  relabels without reconciling index pages (the 1.2.0→1.3.0 upgrade SQL is
  catalog-only), so the migration must also rebuild the index under the new
  binary, backed by a committed existing-install test.
  Migration 065 always drops the historical index/extension first; migration
  066 recreates them only after checking
  `pg_extension.extversion = '1.3.1'`. A package drift therefore aborts
  migration visibly before BM25 writes begin **on a greenfield database**.
  The production lexical arm
  matches through migration 034's generated tsvector + GIN index and orders
  those matches with the migration-066 BM25 index. BM25 orders but never
  matches, so recall is bounded by the tsvector arm; the ts_rank-era
  `rankNormalization` option was removed (BST-908) because pg_textsearch owns
  BM25 normalization and the knob had become a silent no-op.
  `__tests__/fts-search-options-contract.test.ts` pins both facts. When that
  exact English `plain` arm
  returns zero rows, all three file-chunk repository implementations may run
  one bounded `pg_trgm` fallback using the index-supported `$query <% content`
  word-similarity predicate. Websearch and phrase modes remain exact-only so
  their operators/adjacency are never silently discarded, stopword-only
  tsqueries remain honestly empty, and `fuzzyFallback: false` gives evaluation
  callers an explicit opt-out. The fallback pins its session GUC and explicit
  `fuzzyThreshold` to the same value (default `0.6`), returns
  `matchKind: 'fuzzy'`, and does not apply the unbounded BM25 `threshold` to the
  separate 0–1 fuzzy score domain. It reuses every file, root, embedding-set,
  and selection-snapshot scope assembled for the exact arm. Fuzzy-only rows
  omit `ts_headline` because the misspelled tsquery has no honest highlight to
  render. `file-chunk-repository.test.ts` proves typo recall, stopword and mode
  safety, scope retention, explicit opt-out, score-domain separation, and that
  `idx_file_chunks_content_trgm` supports the admission operator when sequential
  scans are disabled; the Electron and Drizzle repository suites pin transport
  parity. The opt-in qualification test is
  `packages/db/__tests__/pg-textsearch-durability-gate.integration.test.ts`;
  run it from the repository root with
  `pnpm --filter @brainstrike/db test:pg-textsearch-durability`. It submits a
  rotated burst of inserts, updates, deletes, BM25 searches, and VACUUM
  requests; PGlite serializes them through its single WASM Postgres instance.
  The gate checkpoints every cycle and repeatedly closes/reopens the same
  on-disk store while verifying heap/BM25 row-count agreement, revision
  continuity, catalog index validity, extension version, forced index
  traversal, and ranked reads. The command logs every bounded cycle/reopen and
  fails a cycle after 60 seconds instead of appearing to hang. Any future
  extension or PGlite upgrade must first change the exact migration guard,
  update the whole peer-compatible package family, pass repeated gate runs on
  every supported desktop platform, and pass the normal
  migration/repository regression suite.

  Hybrid-search performance evidence is produced by the manual, uncached
  `pnpm --filter @brainstrike/db bench:hybrid-search` command. Its default
  10,000-row, 384-dimension real PGlite run compares the complete hybrid service
  with a vector-only control using the same 50-candidate vector source pool,
  alternates pair order, samples each topic evenly, excludes warmups, retains
  raw samples, and fails visibly when hybrid p95 exceeds 500 ms or additional
  p95 exceeds 100 ms. It bulk-builds HNSW after corpus insertion and perturbs
  query vectors so none exactly duplicates an indexed row. Plan evidence
  replays the exact measured repository SQL: natural-planner HNSW selection is
  required, while the lexical plan is reported honestly rather than forcing or
  claiming GIN selection. Unit tests pin the deterministic measurement/reporting
  contract; a small integration test pins real PGlite execution and the forced
  applicability-plan mode. Retained environment and baseline evidence lives in
  `docs/performance/hybrid-search-benchmarks.md`.
  Do not add a query/result cache on benchmark evidence alone: mutable
  local-first search data needs an explicit invalidation owner before cached
  answers can be correct.

  Live-query parameter comparison evidence is produced by the manual, uncached
  `pnpm --filter @brainstrike/db bench:live-query-params` command. It compares
  the current JSON-key strategy with the exact pre-PR-#728 recursive `deepEqual`
  snapshot from `a801ed0c8e63be7065d2ff596bfd2a2e0aea8b7d`, vendored in the
  manual script so production refactors cannot rewrite the baseline. It uses
  freshly allocated primitive, array, and complex-object params. Both strategies
  warm in balanced order, their measured order alternates, and the report uses
  ten-sample medians. The retained baseline and interpretation live in
  `docs/performance/live-query-parameter-benchmarks.md`; it currently refutes a
  lower-cost claim for the JSON-key path, so do not describe PR #728 as a
  measured render-cost improvement or change the default from this isolated
  microbenchmark alone.

  **Recorded exception (BST-1063, 2026-08-01):** the 1.3.1 re-qualification
  above shipped on macOS-arm64-only gate evidence, short of the "every
  supported desktop platform" bar this paragraph states, because the PGlite
  0.5.4 family leaves no lower-numbered pg_textsearch option to fall back to
  — see the "family cannot be split" finding earlier in this section. Linux
  and Windows qualification is owed under BST-1080. This exception covers
  *platform coverage* only. (The existing-install gap that once also blocked
  merge is resolved by the BST-1081 greenfield ruling recorded above.)

  PGlite 0.5.4 also fixed Electron process detection to key off
  `process.type` instead of `process.versions.electron` (upstream commit
  `7e0d6d1`, PR electric-sql/pglite#1033): the previous guard treated
  Electron's main and utility processes as non-Node, which could break
  PGlite's filesystem path there. This lives entirely inside PGlite's own
  bundled code (`IN_NODE` / `isElectronWebContext`) — Brainstrike has no
  corresponding workaround in its own source to remove, and
  `@brainstrike/platform-utils`' `detectPlatform()` is a separate,
  UI-facing Electron/web classifier unrelated to PGlite's internal Node-FS
  detection. What BST-1063 actually verified for the construction sites
  below: the db package's full unit/integration suite (which exercises
  `wasm-loader.ts` and the worker entries, including under `jsdom`) passed
  clean post-bump, and a source read confirmed none of the four sites hardcode
  a PGlite version string, so the bump propagates without code changes. What
  it did **not** verify: `process.type` is only ever defined inside a real
  Electron process — a Node or jsdom test run cannot set it, so no test in
  that suite exercises the exact code path this upstream fix changes. Real
  main-process host (`apps/desktop/src/db-main.ts`) launch verification under
  actual Electron is still **owed**, not done — do not read the passing test
  suite as covering this. The other three construction sites
  (`pglite-worker-entry.ts`, `browser-first-run-bootstrap-worker.ts`,
  `wasm-loader.ts`) are worker/renderer hosts where `process.type` is also
  never `'browser'` (Electron main), so they were never the code path this
  fix targets in the first place; their coverage by the passing unit suite is
  real and sufficient.
