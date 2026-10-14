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
- Init deadline: the DB host init request covered WAL replay, this rebuild and migrations under one 90 s
  deadline, and a timeout terminated the host. A host killed mid-rebuild leaves no clean-shutdown marker, so
  the next open reads as unclean and rebuilds again from scratch: a rebuild slower than the deadline would
  never finish. 11.8 s was 13% of 90 s. The deadline is now per phase; see the BST-1883 update below.

### Update (2026-09-29, BST-1883): what the rebuild, WAL replay and migrations cost

Supports the per-phase init deadline (`platform-contracts.md` § "Graceful shutdown ownership (hidden hosts
and background indexing)"; budgets in `apps/desktop/src/db-host-init-budget.ts`). Machine: Apple M1 Pro, 10
cores, 16 GB, macOS 27.0, APFS SSD. Electron 44.4.5 (utility process Node 24.21.0, V8 15.2), system Node
24.18.0 (V8 13.6). PGlite 0.5.8 (repo patch), pglite-pg_textsearch 0.0.10 (extension 1.3.1), pgvector 0.8.1.
Every instance came from the production factory `createBrainstrikePglite` on an on-disk NodeFS `dataDir`.

**Runtime.** The same REINDEX of the incident database (2.3 GB, 83,004 chunks, average 1060 chars) took
11.9-12.6 s in Electron's utility process (12532, 11941, 11957, 12572 ms) and 16.0-25.1 s in system Node
(19596, 15962, 20263, 25079, 21837 ms). Every rebuild point below was measured inside a real Electron utility
process, because that is the production runtime.

**REINDEX throughput.** Each point: fresh on-disk database, a `file_chunks`-shaped table, the production index
DDL `CREATE INDEX ... USING bm25 (content) WITH (text_config='english')`, `CHECKPOINT`, then
`rebuildCrashSensitiveIndexes` twice. Rows are `'topicN <md5> pipeline scheduler'` blocks of ~123 or ~1420
characters; REAL is an APFS clone of the incident database after its repair.

| point | rows | avg chars | content MB | heap MB | toast MB | index MB | REINDEX ms (runs) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100k x 123 | 100,000 | 123 | 11.7 | 20.4 | 0 | 19.2 | 1718, 1731 |
| 300k x 123 | 300,000 | 123 | 35.1 | 61.6 | 0 | 57.4 | 5258, 5793 |
| 1M x 123 | 1,000,000 | 123 | 116.9 | 205.5 | 0 | 191.2 | 20368, 19942 |
| 100k x 1420 | 100,000 | 1420 | 135.4 | 156.3 | 0 | 202.8 | 23418, 22026 |
| 150k x 1420 | 150,000 | 1420 | 203.1 | 234.4 | 0 | 304.4 | 27369, 26858 |
| 300k x 1420 | 300,000 | 1420 | ~406 | 491 (file) | | | did not complete: `CREATE INDEX` failed with PostgreSQL `error: out of memory` |
| REAL | 83,004 | 1060 | 83.9 | 130.7 | 211.4 | 32.1 | 12532, 11941, 11957 |

Throughput per candidate predictor (fastest run per point):

| predictor | spread (max/min) | slowest point | fastest point |
| --- | --- | --- | --- |
| `content` bytes (`sum(length(content))`, O(n) scan) | 1.29x | 5.9 MB/s (1M x 123) | 7.6 MB/s (150k x 1420) |
| `heap` bytes (`pg_relation_size(table)`, O(1)) | 1.68x | 7.1 MB/s (100k x 1420) | 11.9 MB/s |
| `heap + toast` bytes (O(1)) | 4.04x | 7.1 MB/s | 28.7 MB/s (REAL: its heap carries the stored tsvector, 211 MB of toast) |
| `index` bytes | 4.21x | 2.7 MB/s (REAL) | 11.3 MB/s |
| rows | 12.8x | 4,540 rows/s | 58,207 rows/s |

`content` bytes predict best (5.9-7.6 MB/s), but measuring them is a full detoasting scan, roughly half the
cost of the REINDEX, so it cannot be a pre-phase input. The best O(1) input is `heap + toast`: an upper bound
of the stored content (except where TOAST compression shrinks it), with a slowest observed rate of 7.1 MB/s.
Index bytes and row counts are 4x and 13x apart and are not usable. `CREATE INDEX` costs the same as REINDEX
(1753 vs 1718 ms; 22137 vs 22026 ms). The 300k x 1420 point (about 4.8x the incident database) never reached
REINDEX: after the insert its BM25 `CREATE INDEX` ended in a server-side PostgreSQL `out of memory` (the machine
was paging, swap 9.4 of 10 GB, so the ceiling is not pinned). pg_textsearch 1.3.1 builds the index in memory,
and a build of a few hundred MB of content can exhaust PGlite's WASM heap. That is a different failure of the
same rebuild, not a deadline problem; today's classifier labels it `corruption` (`classifyInitializationFailure`),
and SQLSTATE class 53 (`insufficient_resources`) is not damage. A follow-up ticket, not BST-1883.

**WAL replay** (system Node, so conservative against Electron): a child opens a fresh on-disk database,
`CHECKPOINT`s, inserts ~1 MB-of-WAL statements until `pg_wal_lsn_diff` reaches the target with no further
checkpoint, and idles; the parent SIGKILLs it and times `createBrainstrikePglite` (startup redo runs inside
`PGlite.create`).

| WAL since last checkpoint | rows | `pg_wal` bytes on disk | open after SIGKILL | clean reopen | redo rate |
| --- | --- | --- | --- | --- | --- |
| 33.9 MB | 76,000 | 50.3 MB | 1080 ms | 123 ms | ~35 MB/s |
| 269.0 MB | 604,000 | 285.2 MB | 2867 ms | 153 ms | ~99 MB/s |
| 1,074.8 MB | 2,416,000 | 1,090.5 MB | 4663 ms | 68 ms | ~234 MB/s |

No automatic checkpoint ever ran: `pg_control_checkpoint()` still reported the probe's explicit `CHECKPOINT`
after 1.07 GB of WAL, past `max_wal_size = 1GB` (`checkpoint_timeout = 5min` needs a checkpointer process, which
single-user PGlite lacks; `fsync = off`, `shared_buffers = 128MB`, `maintenance_work_mem = 64MB`, `work_mem =
4MB`). The app issues no `CHECKPOINT` (grep of `apps/desktop/src` and `packages/db/src`, tests excluded); PGlite
checkpoints at a clean `close()`. So the redo length after a crash is bounded only by what was written since
the last clean close (the incident backup's `pg_wal` holds 912 MB even after its clean close). Redo is fast and
its per-MB rate rises with size (fixed open cost dominates small cases). Index-heavy WAL (HNSW, GIN, BM25 full-page
images) and redo inside Electron were not measured. A periodic `CHECKPOINT` from the scheduled maintenance pass
would bound both `pg_wal` and the redo; a separate ticket, outside BST-1883.

**Migrations** (system Node): fresh `initdb` + open 1960 ms; the full chain of 136 migrations 835 ms; a no-op
`migrate` on the migrated database 10 ms (4 ms after a 146 ms reopen). No migration rewrites a large table
today. A future data-rewriting migration is unbounded by the fixed 90 s budget: it must report its own phase
(or be split) before it ships, and the runner would need an `onMigration` hook then.

**A SIGKILL mid-REINDEX** (system Node, incident-database clone: checkpoint and clean close, a child starts
the REINDEX, the parent kills it 4 s in, then reopens and compares `base/<db>` files with
`pg_class.relfilenode`): the reopen took 94 ms (pg_textsearch builds in memory and had written little); the
index kept its old `relfilenode`, stayed `indisvalid = true` and a BM25 ranked query succeeded, so a kill
mid-REINDEX discards the work without making things worse than the crash that caused the rebuild. Exactly one
new file remained, the 8 KB relfilenode the aborted REINDEX allocated. PostgreSQL recovery never removes files
a crash orphans, so every killed attempt leaves one, up to the size of the index being built (a late kill of a
32 MB build); two attempts before a loop breaker bound this to two files per incident, and a manual retry adds
one each. Not cleaned up by BST-1883.

**Risks not retired.** TOAST compression (pglz/lz4) can store text in fewer bytes than its `length()`, so a
highly repetitive corpus could rebuild slower per stored byte than the 7.1 MB/s floor point; the 7x margin
absorbs up to ~7x compression on a reference-speed machine and is not measured. Every number is one M1 Pro on
APFS: Windows, Linux, HDD and network drives are unmeasured (Linux/Windows pg_textsearch qualification is
already owed, BST-1080). REINDEX with several BM25 indexes is budgeted per index and was not measured.

**How to re-measure and re-pin.** Repeat the ladder above inside a real Electron utility process (fresh
on-disk database, production index DDL, `CHECKPOINT`, `rebuildCrashSensitiveIndexes` twice), recompute the
slowest heap+TOAST rate and the slowest redo rate, set the constants in `db-host-init-budget.ts` under those
rates with a stated margin, and re-pin the worked examples in `db-host-init-budget.test.ts`. Never raise a
constant to absorb a slow phase. The probes were session scripts (`electron-main.cjs` + `utility-entry.cjs`
for delivery and the Electron ladder, `throughput-core.mjs`, `reindex-throughput.mjs`, `reindex-real.mjs`,
`wal-replay.mjs`, `migrations-fresh.mjs`, `orphan-probe.mjs`, `fit.mjs`), not committed; the method is the
description above.

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
  comes from `pg_get_indexdef(oid, 1, true)`, an index that is not valid and ready fails the gate
  (`index-validity`) instead of being filtered out, and an HNSW index with no rows to probe fails
  instead of passing. The listing is checked, as a set of schema-qualified names with no duplicates,
  against `pg_indexes` read with its own literal schema filter, so it shares no join and no filter
  with the listing (a first version counted with the listing's own clause, so a join added there
  shrank both and could never fail; a count also let a drop and a duplicate cancel out). Restoring
  the `indkey[0]` join in the listing's clause fails the gate with `listed 1 of 7 hnsw indexes`, and
  `crash-injection-verify.integration.test.ts` checks every access method's listing against
  `pg_indexes` independently.
- A probe proves nothing unless the plan scanned through its index. The first check matched the
  index name anywhere in the text plan, and the BM25 probe names its index in the query, so a Seq
  Scan's Filter or a Sort Key printed the name with no index scan behind it. The check now walks
  `EXPLAIN (FORMAT JSON)` for an `Index Scan`, `Index Only Scan` or `Bitmap Index Scan` node whose
  `Index Name` is exactly the index and that has an `Order By`, in the query's own tree: an InitPlan
  or SubPlan scanning it does not count (the HNSW probe's query vector is an InitPlan). Pinned: a
  Seq Scan whose Filter names the index, and an index scanned only in an InitPlan, are rejected.
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
