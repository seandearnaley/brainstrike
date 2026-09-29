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

## BM25 is not crash-safe on PGlite; desktop rebuilds it after an unclean shutdown (BST-1871, 2026-09-29)

Supports the `database.md` rule that desktop rebuilds every crash-sensitive index on the
first open after an unclean shutdown, before migrations.

- Root cause: pg_textsearch 1.3.1, the only version `@electric-sql/pglite-pg_textsearch@0.0.10`
  ships, does not WAL-log the index free-space map. After a crash the allocator can reuse a
  block a live structure still owns (timescale/pg_textsearch #430/#426). PR #429 fixes it in
  1.4.0, which no PGlite package ships; the maintainers state that a REINDEX clears the stale
  state.
- SIGKILL crash injection on the pinned builds (PGlite 0.5.8, pg_textsearch 1.3.1), writer killed
  mid-transaction: the BM25 index was broken on 9/15 reopens without a REINDEX between kills and
  clean on 30/30 with `REINDEX` after each kill. Heap, btree, GIN (pg_trgm, tsvector) and
  pgvector HNSW were clean on every kill in every run.
- Why the qualification above missed it: the durability gate checkpoints, closes and reopens
  cleanly, so it never exercises crash recovery. Its 6/6 result says nothing about crash safety.
- Rebuild cost: `REINDEX` took 1.6-10 s at 11k-71k rows in the crash runs. Synthetic in-memory
  rows (~90 chars): 5k rows 37 ms, 100k 612 ms, 300k 1.9 s. The real 2.3 GB on-disk dev database
  took 11.8 s for `idx_file_chunks_content_bm25`, the production incident.
- Init deadline: the DB host init request (`DEFAULT_INITIALIZATION_TIMEOUT_MS`, 90 s in
  `db-host-manager.ts`) now covers WAL replay, this rebuild and migrations, and a timeout
  terminates the host. A host killed mid-rebuild leaves no clean-shutdown marker, so the next
  open reads as unclean and rebuilds again from scratch: a rebuild slower than the deadline would
  never finish. 11.8 s is 13% of 90 s. The timeout was left unchanged.

### Rejected: replace BM25 ordering with `ts_rank_cd`

`ts_rank_cd` has no IDF. Swapping it in for the BM25 ordering and running
`packages/db/src/evaluation/retrieval-eval-cli.ts` (lexical golden v1, five queries):

| Ordering | Precision@1 | MRR | Failing query |
| --- | --- | --- | --- |
| BM25 (current) | 1 | 1 | none |
| `ts_rank_cd`, normalization 0 | 0.8 | 0.85 | `lex-q1-idf-rare-term` |
| `ts_rank_cd`, normalization 1 | 0.8 | 0.9 | `lex-q1-idf-rare-term` |

`lex-q1-idf-rare-term` (`quaternion OR pipeline`) expects `lex-chunk-04`, the only chunk with the
rare term, and needs IDF to put it first: normalization 0 ranked it fourth, normalization 1
second. Only normalizations 0 and 1 were run. The hybrid golden (v2) stayed at Precision@1 1 and
MRR 1 in both runs, and the vector golden was unaffected, so the loss is confined to the
lexical arm. BM25 was kept and made crash-safe by the rebuild instead.

## The SIGKILL crash gate (BST-1875, 2026-09-29)

Supports the `database.md` rules that a PGlite or extension bump passes the SIGKILL crash gate at
200 iterations on every shipped platform, and that a new index access method joins the
crash-sensitive list unless the gate proves it recovers.

- What it does: `packages/db/__tests__/crash-injection-gate.integration.test.ts` spawns a writer
  child (`node --import tsx`, one process so a SIGKILL reaches it) that opens an on-disk, fully
  migrated data dir through desktop's `createBrainstrikePglite` and loops committed transactions
  across btree, BM25, GIN (pg_trgm, tsvector) and HNSW on the real schema, plus a `mastra_messages`
  ledger. After a seeded 300-3000 ms past its first ack the parent SIGKILLs it, reopens through the
  same factory, runs `rebuildCrashSensitiveIndexes`, and verifies acknowledged rows (read from the heap),
  amcheck (heap, every btree with `heapallindexed`, every GIN), an HNSW nearest-neighbour probe per
  index, and a BM25 insert plus ranked search per index. Indexes and tables come from the catalog;
  a new access method fails the gate until the writer and checks cover it.
- "Every index" was wrong in the first version, and the review found it. The listing joined
  `pg_attribute` on `indkey[0]`, which is 0 for an expression index, so the production
  `idx_file_chunks_emb_hnsw_<N>` indexes (`USING hnsw ((embedding::halfvec(N)) halfvec_cosine_ops)
  WHERE vector_dims(embedding) = N`) vanished from amcheck and every probe, and the writer never
  filled `file_chunks.embedding`, so they were empty anyway. The migrated schema has none of them (they
  are built per embedding set), so the gate builds one per model-catalog dimension with the production
  `createDimensionIndex` (six today, plus the thread-message index: seven HNSW indexes). The key now
  comes from `pg_get_indexdef(oid, 1, true)`, the listed count is checked against `pg_index`, an
  index that is not valid and ready fails the gate (`index-validity`) instead of being filtered out,
  and an HNSW index with no rows to probe fails instead of passing.
  `crash-injection-verify.integration.test.ts` pins this: restoring the `indkey[0]` join fails it
  with `listed 1 of 7 hnsw indexes`.
- The BM25 probes must allocate. Consistent with the free-space-map cause above, a ranked search
  straight after the crash passed on all 73 iterations that tried it before recovery; damage
  showed only once a later write allocated (the next writer, or the insert probe). So the probe
  inserts (rolled back) first and searches second. Failures arrive as `58P01`, `XX000` and
  `XX001` with different texts, which is why detection is "the probe threw", never a message match.
- Sensitivity, measured on the pinned builds with the recovery step removed by a local edit (never
  committed), 20 iterations per seed, run one at a time: the first failing iteration was 5, 5, 1, 4,
  4, 1 and 5 for seeds 1-7, so every seed fails inside the PR default of 10. Failures were BM25
  (`corrupt segment`, `invalid segment header`, `Invalid logical page`) or the writer dying on
  `corrupt tombstone page`. The first workload (no stress thresholds, no `VACUUM`) first failed at
  iteration 26 (seed 7) and the stress thresholds `bulk_load_threshold`, `memtable_pages_threshold`
  and `segments_per_level` alone gave 23; adding a `VACUUM file_chunks` every fourth transaction and
  the allocating insert probe together gave 7, 6 and 5 (seeds 7, 1, 2). The effects were not
  measured separately. Embedding all six dimensions in EVERY transaction cost about three times the
  transaction rate and first failed at 2, 7, 3, 8, 1, 10, 4 and 2 (seeds 13, 8, 3, 4, 5, 6, 7, 9;
  some runs overlapped), so a run's first transaction embeds every dimension and later ones rotate
  through them.
- Control: the same workload and probes, recovery still removed, but a clean close instead of a
  SIGKILL, passed 25 of 25 iterations for each of two seeds. The damage is crash-induced, not a
  workload artefact.
- Green, on macOS arm64, with the seven HNSW indexes: 10 iterations took 29 and 31 s of gate time
  (two seeds), 50 took 192 s and 200 took 665 s (3.3 s per iteration, flat across the run because row
  counts are capped at 4,000 chunks and 1,500 thread-index rows). Before the `file_chunks` HNSW
  indexes were covered, 200 took 585 s. Nothing has run on Linux or Windows yet: the first nightly
  durations for each are recorded HERE, and the nightly ceilings (120/115 min) are tightened from them.
- Limits: NODEFS `fsync` is a no-op, so this proves process crashes (SIGKILL keeps every completed
  write), not power loss. The kill instant is random, so the seed reproduces the workload and the
  kill schedule but not the exact kill; a clean run at 10 iterations is evidence, not proof, which
  is why bumps need the 200-iteration nightly on Linux, macOS and Windows.
- amcheck needs its own handle: the factory loads only the production extension set, so the
  verifier opens `ENGINE_EXTENSIONS` plus `amcheck` with `PGlite.create` (a fixture, exempt from
  the construction guard) and drops the extension afterwards.
