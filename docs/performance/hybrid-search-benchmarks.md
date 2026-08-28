# Hybrid search benchmarks

## BST-270 baseline — 2026-08-28

This benchmark measures the real PGlite hybrid-search path against the same
corpus and queries used for a vector-only control. It is deliberately manual
and uncached: the retained result is evidence for a release decision, not a
wall-clock assertion that would make the normal test suite host-dependent.

Run the default baseline from the repository root:

```bash
pnpm --filter @brainstrike/db bench:hybrid-search
```

Use `--json <path>` to retain the complete machine-readable report. The CLI
also accepts `--rows`, `--dimensions`, `--topics`, `--iterations`, `--warmup`,
and `--limit`; malformed or unsupported arguments fail visibly.

### Configuration

| Property | Value |
| --- | ---: |
| Platform | macOS arm64 |
| Node.js | v24.16.0 |
| Corpus | 10,000 chunks |
| Embedding dimensions | 64 |
| Query topics | 8 |
| Measured iterations | 20 |
| Warmup iterations | 3 |
| Result limit | 10 |

The synthetic corpus is deterministic and topic-partitioned. Each measured
iteration alternates the vector-only and hybrid execution order to reduce
order bias. Warmups are excluded, and the report retains all raw samples in
addition to nearest-rank p50 and p95 values.

### Result

| Measurement | p50 | p95 | Target |
| --- | ---: | ---: | ---: |
| Vector-only latency | 15.017 ms | 17.038 ms | control |
| Hybrid latency | 41.607 ms | 44.002 ms | p95 <= 500 ms |
| Additional hybrid latency | 26.590 ms | 28.555 ms | p95 <= 100 ms |

Result: **PASS**. Every query returned 10 vector-only and 10 hybrid results.
Forced-index `EXPLAIN` checks selected
`idx_file_chunks_content_tsvector` (GIN) and
`idx_file_chunks_emb_hnsw_64` (HNSW).

No query or result cache was added. The measured path is already well inside
both targets, while caching mutable local-first search results would require a
new, explicit invalidation owner to avoid stale answers. Existing dimension-
specific HNSW index construction and search tuning remain the appropriate
optimization for this evidence.

### Verification layers

- `hybrid-search-benchmark.test.ts` pins warmup exclusion, alternating order,
  percentile calculation, threshold failures, and malformed configuration.
- `pglite-hybrid-search-benchmark.integration.test.ts` exercises a small real
  migrated PGlite corpus and requires both GIN and HNSW planner selection.
- The command above owns the retained 10,000-row performance evidence and
  exits nonzero when a latency target, result invariant, or index-plan
  invariant fails.
