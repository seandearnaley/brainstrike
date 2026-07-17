# PG18 Skip-Scan Index Audit

**Date:** 2026-07-11
**Engine:** `PostgreSQL 18.3 (PGlite 0.5.4) on wasm32-unknown-linux-gnu` (verified via `SELECT version()` after a full real-app migration run)
**Scope:** B-tree index consolidation opportunities enabled (or not) by PostgreSQL 18's skip scan, plus classic prefix-redundancy findings, on the tables that dominate write throughput and persisted bytes: `file_chunks`, `file_records`, `job_queue`, `embedding_cache`, `file_token_cache`.

## Method

- In-memory PGlite constructed with the full extension set (`vector` from `@electric-sql/pglite-pgvector`, `pg_trgm` from `@electric-sql/pglite/contrib/pg_trgm`, `pg_textsearch` from `@electric-sql/pglite-pg_textsearch`), then the **real app migration path**: `runMigrations(db, { enableVector: true })` from `packages/db/src/drizzle/migrate.ts` (the drizzle baseline + `customMigrations` ledger — the path AGENTS.md documents as "used by the real app").
- Seeded volume: **2,000 `file_records`** (3 roots × 4 embedding sets; 10% NULL `embedding_set_id`, 5% NULL `root_id` — deliberately, to exercise the partial-index caveat), **50,000 `file_chunks`** (25/file, realistic code-like content so the tsvector/trgm/bm25 indexes do real work), **20,000 `job_queue`** rows (85% succeeded / 3% failed / 8% queued / 4% running with mixed live/expired leases), **40,000 `embedding_cache`** rows (20k hashes × 2 model keys), **10,000 `file_token_cache`** rows (20 folders). `ANALYZE` after seeding.
- Per candidate: `EXPLAIN (ANALYZE, BUFFERS)` each hot repository query shape with all indexes present, `DROP INDEX` the candidate in-session, re-EXPLAIN, then restore. Every EXPLAIN ran inside a rolled-back transaction (the job-claim query mutates). Run twice; second (warm) run reported.
- **Forced-plan capability probes**: for the `file_records` candidates the planner prefers seq scans at this heap size (48 pages), so plan choice alone can't distinguish "won't" from "can't". A second pass dropped all three single-column indexes and set `enable_seqscan = off`; PG18 marks an unavoidable seq scan `Disabled: true`, which proves the surviving multicolumn index *cannot* serve the shape.

Skip scan visibility: PG18's `EXPLAIN ANALYZE` reports `Index Searches: N` per index node; `N > 1` on a scan whose leading column has no equality predicate is the skip-scan signature.

> **Important context — two migration paths, two schemas.** The numbered `MigrationRunner` (`packages/db/src/migrations/index.ts`, used by tests) produces a *different* index set from the drizzle ledger the app runs: the numbered path creates e.g. `idx_file_chunks_unique_position (file_record_id, chunk_index)`, `idx_file_chunks_file_type`, `idx_file_chunks_type`, `idx_job_queue_claim (queue, state, run_at, id)`, `idx_job_queue_scheduling`, and `idx_file_records_path_name` — none of which exist in the live app schema. Several "obvious" prefix redundancies that appear when reading the numbered migrations therefore **do not exist in production** and are not verdicts here. This audit is grounded in the post-migration `pg_indexes` dump of the real app path.

## Live index inventory (focus tables, after full migration run)

### file_chunks (heap 27.3 MB at 50k rows)

| Index | Definition | Size @50k |
|---|---|---|
| `idx_file_chunks_content_bm25` | bm25 (content) — added by the in-flight BM25 work | 25,059,328 B |
| `idx_file_chunks_content_trgm` | GIN (content gin_trgm_ops) | 17,031,168 B |
| `idx_file_chunks_content_tsvector` | GIN (content_tsvector) | 8,609,792 B |
| `idx_file_chunks_content_hash` | btree (content_hash) | 3,268,608 B |
| `file_chunks_pkey` | btree (id) | 1,892,352 B |
| `idx_file_chunks_file_record_id` | btree (file_record_id) | 507,904 B |
| `idx_file_chunks_embedding_set_id` | btree (embedding_set_id) | 344,064 B |

(Dimension HNSW indexes are created lazily at runtime by `dimension-index-helpers.ts`, not by migrations; none present after a bare migration run.)

### file_records (heap 393 kB at 2k rows)

| Index | Definition | Size @2k |
|---|---|---|
| `idx_file_records_name_trgm` | GIN (name gin_trgm_ops) | 483,328 B |
| `idx_file_records_root_identity` | UNIQUE btree (embedding_set_id, root_id, path) WHERE embedding_set_id IS NOT NULL AND root_id IS NOT NULL | 163,840 B |
| `idx_file_records_content_hash` | btree (content_hash) | 155,648 B |
| `idx_file_records_path` | btree (path) | 131,072 B |
| `file_records_pkey` | btree (id) | 81,920 B |
| `idx_file_records_root_id` | btree (root_id) | 40,960 B |
| `idx_file_records_embedding_set_id` | btree (embedding_set_id) | 40,960 B |

### job_queue (heap 4.4 MB at 20k rows)

| Index | Definition | Size @20k |
|---|---|---|
| `idx_job_queue_embed_set_state` | btree (queue, job_type, embedding_set_id, state, updated_at) WHERE job_type='embed_chunk' AND embedding_set_id IS NOT NULL | 2,736,128 B |
| `idx_job_queue_state_run_at` | btree (state, run_at) | 2,088,960 B |
| `job_queue_pkey` | btree (id) | 1,073,152 B |
| `idx_job_queue_dedupe_key` | btree (dedupe_key) | 270,336 B |
| `idx_job_queue_leased_until` | btree (leased_until) | 147,456 B |
| `idx_job_queue_active_embed_chunk_id` | btree (chunk_id) WHERE job_type='embed_chunk' AND chunk_id IS NOT NULL AND state IN ('queued','running') | 57,344 B |

### embedding_cache (heap 6.4 MB at 40k rows)

| Index | Definition | Size @40k |
|---|---|---|
| `idx_embedding_cache_content_model` | UNIQUE btree (content_hash, model_key) | 3,637,248 B |
| `idx_embedding_cache_content_hash` | btree (content_hash) | 1,990,656 B |
| `embedding_cache_pkey` | btree (id) | 1,277,952 B |
| `idx_embedding_cache_accessed_at` | btree (accessed_at) | 278,528 B |

### file_token_cache (heap 1.6 MB at 10k rows)

| Index | Definition | Size @10k |
|---|---|---|
| `idx_file_token_cache_folder_path_unique` | UNIQUE btree (folder_id, file_path) | 614,400 B |
| `idx_file_token_cache_lookup` | btree (folder_id, file_path) — **exact duplicate of the unique** | 614,400 B |
| `idx_file_token_cache_hash` | btree (content_hash) | 589,824 B |
| `file_token_cache_pkey` | btree (id) | 245,760 B |
| `idx_file_token_cache_mode` | btree (folder_id, counting_mode) | 106,496 B |
| `idx_file_token_cache_folder` | btree (folder_id) | 106,496 B |

## Hot query shapes (source-grounded)

| # | Shape | Source |
|---|---|---|
| Q1 | `WHERE file_record_id = $1 ORDER BY chunk_index` | `packages/db/src/repositories/file-chunk-repository.ts:99` (delete-by-file at `:330`) |
| Q2 | `WHERE embedding_set_id = $` (chunks) | `file-chunk-repository.ts:425,658` |
| Q3 | `file_record_id IN (SELECT id FROM file_records WHERE root_id = ANY($::text[]))` | `file-chunk-repository.ts:413,420,584`; electron variant `:478,644` |
| Q4 | `file_record_id IN (SELECT id FROM file_records WHERE path = ANY($::text[]))` | `file-chunk-repository.ts:969` |
| Q5 | chunk dedupe by `content_hash = $` | insert/upsert dedupe paths |
| Q6 | job claim: `WHERE queue=$1 AND attempts<max_attempts AND ((state='queued' AND run_at<=$2) OR (state='running' AND (leased_until IS NULL OR leased_until<=$2))) ORDER BY run_at, id LIMIT n FOR UPDATE SKIP LOCKED` | `packages/db/src/queue/job-queue.ts:576-587` |
| Q7 | lease expiry: `WHERE state='running' AND leased_until IS NOT NULL AND leased_until <= $1` | `job-queue.ts:1251` |
| Q8 | dedupe probe: `WHERE dedupe_key=$ AND state IN ('queued','running')` | `job-queue.ts:312` |
| Q9 | set-scoped queue status: `WHERE queue=$ AND job_type='embed_chunk' AND embedding_set_id=$ AND state IN (...)` | `job-queue.ts:432` family |
| Q10 | cache get: `WHERE content_hash=$1 AND model_key=$2` | `packages/db/src/repositories/embedding-cache-repository.ts:159` |
| Q11 | cache batch: `WHERE model_key=$1 AND content_hash IN (...)` | `embedding-cache-repository.ts:199` |
| Q12 | root-identity triple: `embedding_set_id=$ AND root_id=$ AND path=$` | `packages/db/src/repositories/drizzle/file-record-repository.ts:214` |
| Q13 | set + connected roots: `embedding_set_id=$ AND root_id IS NOT NULL` | `drizzle/file-record-repository.ts:260,285` |
| Q14 | plain set filter on file_records: `WHERE embedding_set_id=$` | `packages/db/src/repositories/embedding-sets-repository.ts:370` |
| Q15 | token-cache folder scan: `WHERE folder_id=$` | `packages/db/src/repositories/drizzle/token-cache-store.ts:263` |

Leading-column statistics at seeded volume (`pg_stats.n_distinct`; negative = fraction of row count):

| Column | n_distinct | null_frac |
|---|---|---|
| file_records.embedding_set_id | 4 | 0.10 |
| file_records.root_id | 3 | 0.05 |
| file_records.path | -1 (unique) | 0 |
| file_chunks.file_record_id | 2000 | 0 |
| embedding_cache.content_hash | -0.50 (20k) | 0 |
| embedding_cache.model_key | 2 | 0 |
| file_token_cache.folder_id | 20 | 0 |
| job_queue.queue / state / job_type | 2 / 4 / 2 | 0 |

---

## Verdicts

### DROP — `embedding_cache.idx_embedding_cache_content_hash` (btree on `content_hash`)

`content_hash` is the **leading** column of the UNIQUE `idx_embedding_cache_content_model (content_hash, model_key)`, so this is a classic prefix redundancy — no skip scan required. The repository has **no hash-only query shape**: `get` (Q10) and `getBatch` (Q11) both bind `model_key`, upserts use `ON CONFLICT (content_hash, model_key)`, and eviction uses `accessed_at`.

Q10 before (all indexes present):

```
Index Scan using idx_embedding_cache_content_model on embedding_cache  (cost=0.41..8.43 rows=1 width=20) (actual time=0.004..0.005 rows=1.00 loops=1)
  Index Cond: ((content_hash = '31f85...'::text) AND (model_key = 'local:model-a'::text))
  Index Searches: 1
  Buffers: shared hit=4
Execution Time: 0.010 ms
```

Q10 after `DROP INDEX idx_embedding_cache_content_hash`: **byte-identical plan** (`cost=0.41..8.43`, `Execution Time: 0.009 ms`). Q11 likewise identical before/after (Bitmap Index Scan on the composite, `Index Searches: 19`, `Execution Time: 0.055/0.056 ms`). The single-column index was never chosen for any shape even when present.

Impact: **1,990,656 bytes** at 40k rows (~28% of this table's index bytes), scaling linearly with cache size, plus one fewer btree maintained on every embedding-cache write (this table takes a write per newly embedded chunk content — hot during workspace indexing).

### DROP — `file_token_cache.idx_file_token_cache_lookup` (btree on `(folder_id, file_path)`)

An **exact duplicate** (same columns, same order) of the UNIQUE `idx_file_token_cache_folder_path_unique`. The point lookup used the unique index both before and after the drop, with identical plans:

```
Index Scan using idx_file_token_cache_folder_path_unique on file_token_cache  (cost=0.29..8.30 rows=1 width=4)
  Index Cond: ((folder_id = 'folder-3'::text) AND (file_path = 'f/23/file423.ts'::text))
Execution Time: 0.010 ms   (after drop: 0.013 ms, same plan)
```

Impact: **614,400 bytes** at 10k rows (a full copy of the unique index), and one fewer btree on the token-cache upsert path (written for every file during token counting).

### DROP — `file_token_cache.idx_file_token_cache_folder` (btree on `folder_id`)

`folder_id` is the leading column of BOTH `idx_file_token_cache_folder_path_unique (folder_id, file_path)` and `idx_file_token_cache_mode (folder_id, counting_mode)` — prefix-redundant twice over. Decisively: at **baseline the planner already ignored it** — the folder-only aggregate (Q15) chose `idx_file_token_cache_mode` for its bitmap scan while `idx_file_token_cache_folder` sat idle. After dropping it (together with `_lookup`), Q15's plan and timing were unchanged (`Execution Time: 0.329 ms → 0.307 ms`, same node structure), and the folder+mode filter improved slightly by using both columns of the mode index.

Impact: **106,496 bytes** at 10k rows plus btree maintenance on every upsert.

### KEEP — `file_records.idx_file_records_root_id` (the skip-scan flagship — defeated by index partiality)

The hypothesis: `idx_file_records_root_identity (embedding_set_id, root_id, path)` has a low-cardinality leading column (n_distinct = 4), the ideal skip-scan setup, so PG18 might serve `WHERE root_id = ANY(...)` (Q3, on the hot chunk root-scoping path) from the composite.

**Empirical result: the composite can never be used for the real query shapes, because it is a partial index** (`WHERE embedding_set_id IS NOT NULL AND root_id IS NOT NULL`) and the real predicates don't imply the partial condition (`root_id = ANY(...)` implies `root_id IS NOT NULL` but says nothing about `embedding_set_id`, and rows with NULL `embedding_set_id` are real — 10% in seed, matching legacy/mid-import rows in production). Forced-plan proof with all three single-column indexes dropped and `enable_seqscan = off`:

```
--- P1 root = ANY (REAL shape) ---
Seq Scan on file_records  (cost=0.00..73.00 rows=1267 width=7) (actual ... rows=1267)
  Disabled: true
  Filter: (root_id = ANY ('{root-1,root-2}'::text[]))
```

`Disabled: true` means the planner had **no legal index path at all** — this is a capability impossibility, not a costing choice, so it holds at any scale. Skip scan itself is alive and well in this build: adding the predicate-implying conjunct flips it to the composite with the skip-scan signature:

```
--- P2 root = ANY + embedding_set_id IS NOT NULL ---
Bitmap Index Scan on idx_file_records_root_identity  (cost=0.00..54.50 rows=1140 ...)
  Index Cond: (root_id = ANY ('{root-1,root-2}'::text[]))
  Index Searches: 4        <-- skip scan over the 4 embedding_set_id values
```

But no repository query carries that conjunct, and adding one would change semantics (NULL-set rows must be returned). Also worth recording honestly: at seeded volume even the *baseline* Q3 plan is a Seq Scan (a root matches ~33-63% of a 48-page table — n_distinct for `root_id` is 3), so `idx_file_records_root_id`'s equality value is modest; its indispensable role is the `ON DELETE CASCADE` on `roots(id)` (root removal = full workspace wipe scans `file_records.root_id` per deleted root) and selective lookups when many roots are mounted. **KEEP.**

### KEEP — `file_records.idx_file_records_embedding_set_id`

Same partiality trap. The plain set filter (Q14, `WHERE embedding_set_id = 'set-2'`) does not imply `root_id IS NOT NULL`, so the composite is unusable — forced-plan probe P3 shows `Seq Scan ... Disabled: true` with the single-column index dropped. With the index present, Q14 uses it (`Bitmap Index Scan on idx_file_records_embedding_set_id`, 0.278 ms vs 0.389 ms seq scan after drop — a real regression at even this small volume). The Q13 shape (`+ root_id IS NOT NULL`) *does* imply the partial predicate and probe P4 confirms the composite serves it as a plain prefix scan (`Index Searches: 1` — leading-column equality, no skip scan needed), but Q14 alone justifies the keep. **KEEP.**

### KEEP — `file_records.idx_file_records_path`

`path` is the *third* column of the partial composite. The real shape Q4 (`path = ANY(50 paths)`, no set/root conjuncts) cannot use it (probe P5: `Seq Scan ... Disabled: true`). With the index present, Q4 is served precisely (`Bitmap Index Scan on idx_file_records_path`, `Index Searches: 14`, 0.070 ms, 28 buffers vs seq scan 0.247 ms, 48 buffers after drop). The predicate-implied probe P6 does demonstrate a working skip scan over the (set, root) pairs (`Index Searches: 4`, 22 buffers) — but again, no real query carries those conjuncts. **KEEP.**

### KEEP — all `job_queue` indexes (no consolidation candidates exist)

In the live schema there is **no multicolumn index whose suffix covers any single-column index**: `idx_job_queue_leased_until (leased_until)` and `idx_job_queue_dedupe_key (dedupe_key)` appear in no composite (the numbered-path `idx_job_queue_lease (state, leased_until)` and `idx_job_queue_claim (queue, state, run_at, id)` **do not exist in the app schema**); `idx_job_queue_embed_set_state` is partial on `job_type='embed_chunk' AND embedding_set_id IS NOT NULL` and cannot serve the general claim/expiry shapes. Baseline EXPLAINs confirm each index earns its keep:

- Q6 claim: `BitmapOr` of two `idx_job_queue_state_run_at` scans (`(state='queued' AND run_at<=...)` + `(state='running')`), 2.29 ms over 20k rows — the only b-tree that can serve the claim.
- Q7 expiry: `Index Scan using idx_job_queue_leased_until` (`Index Cond: leased_until IS NOT NULL AND leased_until <= ...`), 0.207 ms. `leased_until` exists in no other index.
- Q8 dedupe probe: `Index Scan using idx_job_queue_dedupe_key`, 0.008 ms. Note: unlike the numbered path's unique partial `idx_job_queue_dedupe_active`, the live index is plain — dedupe correctness is enforced in `enqueue`'s CTE, and the index is its only support.
- Q9 set-scoped status: `Bitmap Index Scan on idx_job_queue_embed_set_state` with all three leading equality conditions + `state = ANY`, `Index Searches: 3`, 0.370 ms.

**KEEP all.**

### KEEP — all `file_chunks` btrees (nothing to consolidate onto)

The live schema has **only single-column btrees** on file_chunks (`file_record_id`, `embedding_set_id`, `content_hash`) — the numbered-path multicolumn indexes (`idx_file_chunks_unique_position`, `idx_file_chunks_file_type`) do not exist in the app, so there is no skip-scan consolidation to evaluate. Each single serves a distinct hot shape (Q1 file lookup + cascade deletes, Q2 set-scoped ops, Q5 dedupe). The write-amplification lever on this hottest table is not btree redundancy but the three content indexes (bm25 25.1 MB + trgm 17.0 MB + tsvector 8.6 MB ≈ 82% of the table's index bytes at 50k chunks) — out of scope here, owned by the search stack. **KEEP all.**

---

## Verdict summary

| Index | Table | Verdict | Reason (evidence) |
|---|---|---|---|
| `idx_embedding_cache_content_hash` | embedding_cache | **DROP** | Prefix of UNIQUE `(content_hash, model_key)`; no hash-only query exists; plans identical after drop (Q10/Q11) |
| `idx_file_token_cache_lookup` | file_token_cache | **DROP** | Exact duplicate of UNIQUE `(folder_id, file_path)`; identical plans after drop |
| `idx_file_token_cache_folder` | file_token_cache | **DROP** | Prefix of two composites; planner already ignored it at baseline; no regression after drop |
| `idx_file_records_root_id` | file_records | KEEP | Partial composite provably unusable for real shapes (`Disabled: true` probe P1); FK-cascade support |
| `idx_file_records_embedding_set_id` | file_records | KEEP | Q14 regresses to seq scan (probe P3 `Disabled: true`) |
| `idx_file_records_path` | file_records | KEEP | Q4 regresses to seq scan (probe P5 `Disabled: true`) |
| `idx_job_queue_state_run_at` | job_queue | KEEP | Only server of the claim query (Q6) |
| `idx_job_queue_leased_until` | job_queue | KEEP | Only index containing `leased_until` (Q7) |
| `idx_job_queue_dedupe_key` | job_queue | KEEP | Only index containing `dedupe_key` (Q8) |
| `idx_job_queue_embed_set_state`, `idx_job_queue_active_embed_chunk_id` | job_queue | KEEP | Partial, purpose-built (Q9 / chunk-cancel) |
| `idx_file_chunks_file_record_id`, `idx_file_chunks_embedding_set_id`, `idx_file_chunks_content_hash` | file_chunks | KEEP | No multicolumn index exists to consolidate onto |

**Prospective persisted-size savings from the three DROPs: 2,711,552 bytes (~2.6 MiB) at the seeded volume**, scaling linearly with cache growth (e.g. ~25 MB of `content_hash` index at 500k cached embeddings), plus three fewer btrees maintained on the embedding-cache and token-cache write paths. The migration shipped as dual-registered migration 062 (`packages/db/src/migrations/062-index-consolidation.ts`), which also drops `idx_prompt_item_revisions_item_revision` (same key as the UNIQUE `prompt_item_revisions_unique`).

## Skip-scan bottom line

PG18 skip scan **works in this PGlite build** (demonstrated: `Index Searches: 4` on `idx_file_records_root_identity` for probes P2/P6) but yields **zero consolidation wins for this schema**, for two structural reasons:

1. Every candidate multicolumn index on the audited tables is **partial**, and the real query shapes don't imply the partial predicates — a scale-independent disqualifier (`Disabled: true` under forced plans) that precedes any skip-scan consideration.
2. The remaining single-column indexes either have no covering composite at all (job_queue, file_chunks) or are plain prefix redundancies that were already droppable pre-PG18 (embedding_cache, file_token_cache).

## Additional observations (advisory, no verdicts)

- **Migration-path divergence**: the numbered test runner materializes indexes the app never gets (`idx_file_chunks_unique_position`, `idx_file_chunks_file_type`, `idx_file_chunks_type`, `idx_file_chunks_chunk_index`, `idx_file_chunks_token_count`, `idx_job_queue_claim`, `idx_job_queue_scheduling`, `idx_job_queue_lease`, `idx_file_records_path_name`, ...). Anyone reasoning about production plans from the numbered migration files will reach wrong conclusions (this audit initially did). Worth a follow-up decision on parity.
- Small-table prefix redundancies exist in the live schema but were left un-verdicted (negligible size, cold paths): `idx_file_relationships_source` (prefix of UNIQUE `(source_id, target_id, relationship_type)`), `idx_selection_snapshot_files_snapshot_id` (prefix of UNIQUE `(snapshot_id, file_path)`), and `idx_prompt_item_revisions_item_revision (prompt_item_id, revision DESC)` (functionally covered by UNIQUE `(prompt_item_id, revision)` — btrees scan backwards).
- `idx_file_chunks_content_bm25` (from the in-flight BM25 work) is now the single largest index in the database at 25 MB per 50k chunks — worth its own size/benefit tracking.

## Reproduction

Scratch harness (not committed): in-memory PGlite with the three extensions → `runMigrations(db, { enableVector: true })` → SQL seeding via `generate_series` → `ANALYZE` → EXPLAIN matrix with per-case `DROP INDEX`/restore inside the session, plus a forced-plan pass (`SET enable_seqscan = off`). Total runtime ≈ 30 s. Raw outputs: index inventory + `pg_stats` + `pg_relation_size` tables and full EXPLAIN texts as quoted above.
