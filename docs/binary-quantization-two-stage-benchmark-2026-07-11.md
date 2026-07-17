# Binary-Quantization Two-Stage Retrieval Benchmark (2026-07-11)

Go/no-go evaluation of a two-stage vector retrieval pipeline for large repos:
**stage 1** — binary-quantized `bit(N)` HNSW index queried by Hamming distance
(`<~>`) as a cheap wide prefilter; **stage 2** — rerank the candidate pool with
full-precision cosine distance. Measured against the current single-stage
halfvec HNSW path, inside PGlite's single-connection WASM (the production
constraint).

**Verdict: NO-GO as a query-latency upgrade; the numbers instead point at two
different, larger problems** (index build time and filtered-search recall) with
their own follow-ups — see [Recommendation](#recommendation).

## Environment

- `@electric-sql/pglite` 0.5.4 (Postgres 18.3, WASM, `memory://`), pgvector
  **0.8.1** (`binary_quantize`, `<~>`, `bit_hamming_ops` all verified working;
  `EXPLAIN` confirmed the planner uses the bit HNSW index for the prefilter
  subquery in every scenario — no silent seq scans in either arm).
- Harness: `packages/db/scripts/benchmark-binary-quantization.ts` (tsx, manual
  run only, not in any CI lane).
- Production query shape mirrored exactly: partial expression index
  `USING hnsw ((embedding::halfvec(N)) halfvec_cosine_ops) WITH (m=16,
  ef_construction=64) WHERE vector_dims(embedding)=N`, queries in one
  transaction with `SET LOCAL hnsw.ef_search=100` +
  `hnsw.iterative_scan='strict_order'`, 10× overfetch (LIMIT 100 for k=10).
- Corpus: synthetic clustered unit vectors, 1024-dim (bge-m3, the local
  default). Intra-cluster cosine ≈ 0.8 (spread 0.75), anisotropy mixed in so
  unrelated pairs sit at cosine ≈ 0.3 (bge-like). An isotropic control run
  showed **anisotropy barely moves any number**, so the synthetic-geometry risk
  is low. 40 queries/scenario; ±~2–3 pt noise on recall at that sample size.
- Ground truth: exact fp32 cosine seq scan per query.
- Scenarios: `main` = filter matching ~90% of rows (whole-set search, the
  dominant production query, `embedding_set_id = $x`); `selective` = filter
  matching ~10% (root-scoped search analog).

## Results

### Query quality/latency — 25k rows

| Arm | main recall@10 | main p50/p95 (ms) | selective recall@10 | selective p50/p95 (ms) |
|---|---|---|---|---|
| exact seq scan | 100% | 165.9 / 202.3 | 100% | 22.2 / 25.5 |
| single-stage halfvec (prod, ef=100) | 99.8% | 7.9 / 12.6 | 57.2% | 41.5 / 67.4 |
| single-stage ef=200 | 99.8% | 7.0 / 10.7 | 68.0% | 45.0 / 67.5 |
| single-stage ef=800 | 99.8% | 25.7 / 35.3 | 84.5% | 42.9 / 74.2 |
| two-stage P=200 | **100%** | **5.7 / 7.8** | 61.2% | 16.5 / 21.3 |
| two-stage P=800 | 100% | 19.4 / 23.7 | **91.0%** | **35.5 / 45.5** |

### Query quality/latency — 100k rows

| Arm | main recall@10 | main p50/p95 (ms) | selective recall@10 | selective p50/p95 (ms) |
|---|---|---|---|---|
| exact seq scan | 100% | 726.8 / 790.1 | 100% | 79.0 / 80.9 |
| single-stage halfvec (prod, ef=100) | 94.2% | 8.5 / 25.3 | 39.5% | 79.5 / 129.6 |
| two-stage P=200 | 89.2% | 5.1 / 8.3 | 42.5% | 20.4 / 23.2 |
| two-stage P=400 | 90.8% | 12.0 / 13.0 | 50.8% | 24.0 / 28.7 |
| two-stage P=800 | 93.2% | 21.3 / 23.0 | 61.5% | 31.2 / 34.9 |

### Index build time and size (the structural numbers)

| Scale | halfvec HNSW build | bit HNSW build | halfvec idx size | bit idx size | fp32 vectors (TOAST) |
|---|---|---|---|---|---|
| 25k × 1024d | 132.3 s | **7.9 s** (17×) | 65.1 MB | **10.4 MB** (6.3×) | 131.9 MB |
| 100k × 1024d | **2,496 s (41.6 min)** | **31.9 s (78×)** | 260.4 MB | **41.4 MB** (6.3×) | 533.2 MB (measured) |
| 100k, `maintenance_work_mem=512MB` | **505 s (8.4 min, 5× faster)** | 30.5 s | 260.4 MB | 41.5 MB | 533.2 MB |

Build times matter more than usual here: PGlite is a single connection, so a
`CREATE INDEX` **blocks every DB operation in the app for its whole duration**
(the deferred-index-builder only delays when the freeze starts; its code
comment assumes "5-30s", which held at ≤10k chunks and is now 41.6 minutes at
100k). The default `maintenance_work_mem=64MB` puts the 260 MB halfvec graph
on pgvector's slow spill path while the 41 MB bit graph fits in memory — that
alone explains most of the 78× gap: with `maintenance_work_mem=512MB` the
halfvec build drops 5× to 8.4 min (bit build unchanged), a one-line,
no-schema, no-recall-cost fix for the current design.

## Analysis

1. **Two-stage is NOT a query-latency win at scale.** The primary whole-set
   search is already 8.5 ms p50 at 100k on the current path — not a
   bottleneck. Two-stage needs P=800 to reach recall parity (93.2% vs 94.2%,
   within noise) and costs 21.3 ms there — 2.5× slower. At P=200 it is faster
   (5.1 ms) but gives up ~5 pts of recall. BQ's Hamming resolution caps its
   recall ceiling as the corpus grows: at 25k, P=200 gave 100%.
2. **Filtered search is broken today, and two-stage only half-fixes it.** At
   100k with a 10% filter the production path returns **39.5% recall@10 at
   79.5 ms p50 — the same latency as an exact seq scan (79.0 ms) that would
   return 100%**. `strict_order` iterative scan walks most of the graph and
   still misses. Raising ef_search doesn't rescue it (25k: ef=800 → 84.5% at
   flat ~43 ms). Two-stage dominates the filtered frontier (61.5% @ 31 ms vs
   39.5% @ 79 ms at 100k) but is nowhere near acceptable either. The winning
   move for selective filters isn't ANN at all — it's detecting selectivity
   and seq-scanning the filtered subset exactly.
3. **The bit index's apparent build-time win is mostly a tuning artifact.**
   At default settings it builds 78× faster (32 s vs 41.6 min), but most of
   that gap is the halfvec graph spilling past `maintenance_work_mem=64MB`;
   with 512 MB the gap shrinks to 16× (30.5 s vs 8.4 min). The durable
   structural win is persisted size: 6.3× smaller index (41 vs 260 MB —
   cold-load-relevant for browser `idb://` stores). Both wins only materialize
   if the bit index **replaces** the halfvec index (rerank needs no index),
   and replacement costs the recall/latency regressions in (1) plus P-tuning
   complexity that must scale with corpus size (P=200 suffices at 25k; P=800
   still trails slightly at 100k).

## Recommendation

**No-go on migrating the search path to two-stage binary quantization now.**
The primary query it would accelerate is already fast, recall parity at 100k
requires a rerank pool that erases the speedup, and the win shrinks as corpora
grow — the opposite of the "large repo" goal. No migrations proposed.

The measurements instead surface two follow-ups with better ROI:

1. **Index-build freeze at large scale (severity: high, cheap fix measured).**
   41.6 min of blocked single-connection DB at 100k chunks with the default
   64 MB `maintenance_work_mem`; **measured 5× faster (8.4 min) with
   `SET maintenance_work_mem='512MB'`** applied before the deferred build (a
   transient per-session setting — memory is only held during the build).
   Recommended change: the deferred dimension-index builder
   (`dimension-index-helpers.ts`) should raise `maintenance_work_mem` for its
   build statement, sized against the estimated graph
   (`rows × dims × 2B + graph overhead`) and the WASM memory ceiling. Further
   levers if 8.4 min is still too long: lower `ef_construction`/`m` for very
   large sets, surface build progress in the UI. (Parallel builds are
   impossible in PGlite — no bgworkers.)
2. **Filtered-search recall (severity: high, correctness).** Root-scoped /
   selective searches at 100k return under half the true neighbors. Candidate
   fixes, in benchmark-first order: (a) planner heuristic — when the filter is
   estimated selective (e.g. <15% of the dimension's rows), skip the ANN
   index and exact-scan the subset (100% recall at equal-or-better latency,
   already proven by the seq-scan row above); (b) `hnsw.max_scan_tuples` /
   ef tuning; (c) partial indexes per large root (index bloat tradeoff).

Re-evaluate two-stage BQ only if: corpora grow ≥500k chunks (seq-scan
fallbacks stop being viable and halfvec build time becomes untenable), or
pgvector ships improved filtered iterative scans, or persisted-size pressure
(browser cold load) becomes acute enough to justify the recall trade.

## Reproduction

```bash
cd packages/db
pnpm exec tsx scripts/benchmark-binary-quantization.ts --rows 100000 \
  --queries 40 --twoStage --rerank 40,100,200,400,800 --json /tmp/bq-100k.json
# flags: --dims --k --singleEf 100,200,... --mwm 512MB --spread --aniso --seed
```

Raw JSON reports from this evaluation's runs (25k, 25k-iso, 25k-efsweep, 100k,
100k-mwm512) were generated with seed 42 and are reproducible from the flags
in each file's `config` block. NOTE: the two-stage BQ arms (and the bit index
build) moved behind `--twoStage` when the harness was extended for the
follow-up below.

---

## Follow-up (2026-07-11): filtered-search recall fix — validated and shipped

The harness was extended with the candidate fixes from Recommendation #2
(arms: `exact-filtered`, `adaptive`, `single-stage-mst<N>` =
`hnsw.max_scan_tuples` sweep, `partial-index`; two-stage arms now opt-in via
`--twoStage`). Same corpus/geometry/seed (42), 40 queries/scenario;
100k run with `--mwm 512MB`.

### Results — 25k rows

| Arm | selective recall@10 | selective p50/p95 (ms) | main recall@10 | main p50/p95 (ms) |
|---|---|---|---|---|
| single-stage (prod, ef=100) | 57.0% | 37.9 / 55.4 | 99.8% | 6.4 / 7.5 |
| exact-filtered | **100%** | **21.4 / 22.0** | 100% | 155.8 / 167.9 |
| adaptive (counts + route) | **100%** | 25.4 / 27.1 (→exact) | 99.8% | 9.4 / 10.8 (→ann) |
| mst=50k | 57.0% | 37.0 / 55.7 | 99.8% | 6.2 / 6.7 |
| partial-index (build 8.1s, 6.5 MB) | 95.2% | 7.0 / 8.7 | — | — |

### Results — 100k rows

| Arm | selective recall@10 | selective p50/p95 (ms) | main recall@10 | main p50/p95 (ms) |
|---|---|---|---|---|
| single-stage (prod, ef=100) | 39.8% | 84.8 / 139.1 | 96.0% | 23.6 / 66.2 |
| exact-filtered | **100%** | **80.2 / 81.6** | 100% | 770.5 / 1600.4 |
| adaptive (counts + route) | **100%** | 94.4 / 96.3 (→exact) | 96.0% | 12.4 / 28.4 (→ann) |
| mst=200k | 39.8% | 80.8 / 135.2 | 96.0% | 7.9 / 22.2 |
| partial-index (build 51.9s, 26.1 MB) | 69.2% | 8.5 / 11.4 | — | — |

### Verdict per candidate

- **(a) Adaptive exact-scan routing — SHIPPED.** On selective filters the
  exact scan returns 100% recall at equal-or-better latency than the broken
  ANN path (80.2 vs 84.8 ms p50 at 100k); the bounded selectivity counts add
  ~4 ms (25k) to ~14 ms (100k) and route correctly in both scenarios. No
  schema changes, no index builds, works for every narrowing filter shape.
- **(b) `hnsw.max_scan_tuples` — REJECTED.** Raising the iterative-scan visit
  cap to 2× the corpus changes nothing (39.8% → 39.8% at 100k): the collapse
  is not the tuple cap binding; `strict_order` iterative scan itself fails to
  reach the filtered neighbors.
- **(c) Per-root partial indexes — REJECTED for this problem.** Even a
  dedicated partial index over exactly the filtered 10k rows returns only
  69.2% recall at 100k total (95.2% at 25k) — recall still degrades with the
  ANN graph, on top of per-root build freezes (51.9 s at 10k covered rows,
  single-connection) and unbounded index count for dynamic roots.

### Shipped implementation

`resolveFilteredVectorSearchRoute` (packages/db/src/repositories/_shared.ts;
`EXACT_FILTERED_SCAN_MAX_ROWS` = 20_000, `EXACT_FILTERED_SCAN_MAX_RATIO` =
0.15), wired into `searchSimilar` in BOTH `FileChunkRepository` and
`ElectronFileChunkRepository`:

- Only NARROWED searches (any filter beyond `embedding_set_id`: rootId/
  rootIds, filePaths, selectionSnapshotId, fileRecordId, chunkType) run the
  routing counts — the dominant whole-set search path is untouched.
- Count 1 (bounded at 20_001): rows matching the narrowed filter, cheap
  predicates only (`embedding IS NOT NULL` — never `vector_dims`, which would
  detoast every vector). 0 → return `[]` without searching; > 20k → ANN.
- Count 2 (bounded at `ceil(matched / 0.15)`): whole-set rows; reaching the
  cap proves the ratio ≤ 0.15 → EXACT route, else ANN.
- Exact route: same search SQL with full-precision `embedding <=>
  $1::vector(N)` order/score expressions — they cannot match the halfvec
  expression index, so the planner exact-scans the filtered subset (100%
  recall by construction, fp32 scores). No `SET LOCAL` tuning transaction.

Paired tests: `search-similar-sql-path.test.ts` (routing decision),
`search-similar-sql-path.integration.test.ts` (real PGlite: route selection,
empty short-circuit, no-counts-on-whole-set), and
`electron-file-chunk-repository.test.ts` (IPC path: exact bypasses the
transaction primitive, ANN keeps it, count sequencing).

The `DrizzleFileChunkRepository` (exported for tests only, no production
consumers) keeps the plain ANN path — flagged as a follow-up if it ever gains
a production caller.
