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
| Embedding dimensions | 384 |
| Query topics | 8 |
| Measured iterations | 24 |
| Warmup iterations | 3 |
| Result limit | 10 |

The synthetic corpus is deterministic and topic-partitioned. Query embeddings
use seeds outside the corpus row range, so no query is an exact indexed vector.
Each measured iteration alternates the vector-only and hybrid execution order
to reduce order bias, and 24 iterations divide evenly across the eight topics.
Both arms request the same 50-candidate vector source pool, so additional
latency isolates the FTS arm plus RRF fusion. Warmups are excluded, and the
report retains all raw samples in addition to nearest-rank p50 and p95 values.

### Result

| Measurement | p50 | p95 | Target |
| --- | ---: | ---: | ---: |
| Vector-only latency | 10.750 ms | 12.242 ms | control |
| Hybrid latency | 32.975 ms | 36.465 ms | p95 <= 500 ms |
| Additional hybrid latency | 22.276 ms | 24.627 ms | p95 <= 100 ms |

Result: **PASS**. Every query returned 50 vector-only source rows and 10 fused
hybrid results. Natural-planner `EXPLAIN` replayed the exact measured SQL. The
vector path selected `idx_file_chunks_emb_hnsw_384`; the lexical path chose a
sequential scan over 10,000 same-embedding-set rows rather than
`idx_file_chunks_content_tsvector`. This is an observation, not a disguised GIN
claim: the measured end-to-end latency remains the release gate, and the
captured plan makes future planner changes directly comparable.

No query or result cache was added. The measured path is already well inside
both targets, while caching mutable local-first search results would require a
new, explicit invalidation owner to avoid stale answers. Existing dimension-
specific HNSW index construction and search tuning remain the appropriate
optimization for this evidence.

### Verification layers

- `hybrid-search-benchmark.test.ts` pins warmup exclusion, alternating order,
  percentile calculation, threshold failures, and malformed configuration.
- `pglite-hybrid-search-benchmark.integration.test.ts` exercises a small real
  migrated PGlite corpus, replays the exact measured statements under a forced
  applicability probe, and records the actual lexical and HNSW plans.
- The command above owns the retained 10,000-row performance evidence and
  exits nonzero when a latency target, result invariant, or HNSW plan invariant
  fails. Its natural lexical plan remains reported but is not misrepresented as
  a GIN requirement.
